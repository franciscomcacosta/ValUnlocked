// Fulfilment: called by the IPN handler when an order's payment finalizes.
// For an own/bought inventory row: just flip status to sold (legacy flow).
// For a qvsp-reserved row: call qvsp POST /orders, get creds, encrypt +
// create an inventory row, flip status, DM the buyer.
import { db } from "./supabase";
import { notifyDiscordUser } from "./discord";
import { buyAccount, QvspApiError, type QvspKind, type QvspOrder } from "./qvsp";
import { encrypt } from "./crypto";
import { SKIN_BRACKETS, type SubTier } from "./pricing";
import { skinVariants } from "./skin-names";
import { logToStaff } from "./discord";

export async function fulfilOrder(orderId: string): Promise<boolean> {
  // Atomically claim this order. Duplicate IPN deliveries return null.
  const { data: claimed } = await db.rpc("claim_order_for_fulfilment", { p_order_id: orderId });
  if (!claimed) return false;

  // Load order + user + (legacy) reserved inventory_id.
  const { data: order } = await db
    .from("orders")
    .select("id, inventory_id, user_id, credit_used_cents, charge_cents, users(discord_id), products(name, slug)")
    .eq("id", orderId)
    .single();
  if (!order) {
    console.error(`[fulfil] order ${orderId} vanished`);
    return false;
  }

  const user = order.users as unknown as { discord_id: string } | null;
  const product = order.products as unknown as { name: string; slug: string } | null;

  // Case 1 — classic inventory row already reserved.
  if (order.inventory_id) {
    await db.from("inventory").update({ status: "sold" }).eq("id", order.inventory_id);
    await db
      .from("orders")
      .update({ status: "fulfilled", fulfilled_at: new Date().toISOString() })
      .eq("id", orderId);
    if (user?.discord_id) {
      await notifyDiscordUser(
        user.discord_id,
        `✅ Your order for **${product?.name ?? "your account"}** is ready.\n` +
          `View credentials: ${process.env.PUBLIC_BASE_URL}/orders/${orderId}\n` +
          `Change the account and email passwords on first login.`
      ).catch((e) => console.error("[fulfil] DM failed", e));
    }
    return true;
  }

  // Case 2 — qvsp reservation. Find the reserved qvsp_stock row for this order.
  const { data: qvspRow } = await db
    .from("qvsp_stock")
    .select("qvsp_id, kind, region, skin_count, peak, rank_normalized, qvsp_price_cents")
    .eq("reserved_order_id", orderId)
    .eq("claimed", false)
    .maybeSingle();
  if (!qvspRow) {
    console.error(`[fulfil] order ${orderId} paid but no reserved qvsp row`);
    await db
      .from("orders")
      .update({ status: "paid" })
      .eq("id", orderId); // leave as paid for manual handling
    return false;
  }

  // Actually buy from qvsp (spends our qvsp balance). If the reserved
  // listing was bought by someone else on qvsp in the meantime, swap in the
  // next-cheapest EQUIVALENT account (same bracket / same skin, same region)
  // — the buyer's price never changes. No equivalent → full credit refund.
  let qvspOrder: QvspOrder | null = null;
  let row = qvspRow;
  for (let attempt = 0; attempt < 4 && !qvspOrder; attempt++) {
    try {
      qvspOrder = await buyAccount({ kind: row.kind as QvspKind, id: row.qvsp_id });
    } catch (e) {
      if (!isGoneError(e)) {
        console.error(`[fulfil] qvsp buy failed for order ${orderId}`, e);
        // Not a "sold elsewhere" error (e.g. our qvsp balance): leave the
        // reservation for a human to retry/refund.
        await db.from("orders").update({ status: "paid" }).eq("id", orderId);
        await logToStaff(`⚠️ Order ${orderId}: qvsp buy failed (${describeErr(e)}). Needs a manual retry or refund.`);
        if (user?.discord_id) {
          await notifyDiscordUser(
            user.discord_id,
            `⚠️ Your payment was received but we hit a snag delivering your account. Staff will sort it out in a few minutes.`
          ).catch(() => {});
        }
        return false;
      }
      // Sold elsewhere: hide it, release our hold, look for an equivalent.
      await db.from("qvsp_stock").update({ removed_at: new Date().toISOString() }).eq("qvsp_id", row.qvsp_id);
      await db.rpc("release_qvsp_stock", { p_order_id: orderId });
      const alt = await reserveEquivalent(orderId, row);
      if (!alt) {
        await refundSoldOut(orderId, order.user_id as string, user?.discord_id ?? null, product?.name ?? "your account");
        return false;
      }
      await logToStaff(`🔁 Order ${orderId}: ${row.qvsp_id} sold on qvsp before we bought it — swapped to ${alt.qvsp_id}.`);
      row = alt;
    }
  }
  if (!qvspOrder) {
    await refundSoldOut(orderId, order.user_id as string, user?.discord_id ?? null, product?.name ?? "your account");
    return false;
  }

  const creds = qvspOrder.credentials;
  if (!creds?.login || !creds?.password) {
    console.error(`[fulfil] qvsp order ${qvspOrder.id} returned no credentials`);
    await db.from("orders").update({ status: "paid" }).eq("id", orderId);
    return false;
  }

  // Encrypt and persist as an inventory row so /orders/[id] page shows them.
  const { data: inv, error: invErr } = await db
    .from("inventory")
    .insert({
      // Attach to the synthetic bracket product.
      product_id: (
        await db
          .from("orders")
          .select("product_id")
          .eq("id", orderId)
          .single()
      ).data!.product_id,
      source: "qvsp",
      acquired_from: `qvsp:${row.qvsp_id}`,
      cost_cents: null,
      login_enc: encrypt(creds.login),
      password_enc: encrypt(creds.password),
      email_enc: encrypt(creds.email ?? ""),
      email_password_enc: encrypt(creds.email_password ?? ""),
      notes: `Region ${row.region} · ${row.skin_count} skins · peak ${row.peak ?? "N/A"}`,
      status: "sold",
    })
    .select("id")
    .single();
  if (invErr || !inv) {
    console.error("[fulfil] inventory insert failed", invErr);
    return false;
  }

  // Keep qvsp's own order id — replacement tickets need it. Separate update so
  // a not-yet-migrated column (006) can never block delivery.
  if (qvspOrder.id) {
    const { error: qErr } = await db.from("orders").update({ qvsp_order_id: qvspOrder.id }).eq("id", orderId);
    if (qErr) console.warn("[fulfil] couldn't save qvsp_order_id (run migration 006)", qErr.message);
  }

  // Mark qvsp row claimed, attach inventory to the order, flip order status.
  await db.rpc("claim_qvsp_stock", { p_qvsp_id: row.qvsp_id, p_order_id: orderId });
  await db
    .from("orders")
    .update({
      inventory_id: inv.id,
      status: "fulfilled",
      fulfilled_at: new Date().toISOString(),
    })
    .eq("id", orderId);

  if (user?.discord_id) {
    await notifyDiscordUser(
      user.discord_id,
      `✅ Your Valorant account is ready — **${row.region}**, **${row.skin_count} skins**, peak **${row.peak ?? "N/A"}**.\n` +
        `View credentials: ${process.env.PUBLIC_BASE_URL}/orders/${orderId}\n` +
        `Change the account and email passwords on first login.`
    ).catch((e) => console.error("[fulfil] DM failed", e));
  }

  // Fire-and-forget email extraction for Premium+ subscribers. Worker will
  // POST back to /api/worker/callback with the extracted email or a failure.
  // Standard users don't get auto-extraction — they have to figure it out
  // themselves, which is a feature not a bug (keeps the method a sub perk).
  void maybeDispatchEmailExtraction(orderId, order.user_id, creds.login, creds.password);

  return true;
}

/** Only fires if user is Premium or Ultra AND the worker URL is configured. */
async function maybeDispatchEmailExtraction(
  orderId: string,
  userId: string,
  login: string,
  password: string
): Promise<void> {
  const workerUrl = process.env.EXTRACTOR_WORKER_URL;
  const workerSecret = process.env.EXTRACTOR_WORKER_SECRET;
  if (!workerUrl || !workerSecret) return; // feature disabled

  // Gate by sub tier.
  const { data: sub } = await db
    .from("subscriptions")
    .select("tier")
    .eq("user_id", userId)
    .in("status", ["active", "grace"])
    .maybeSingle();
  const tier = (sub?.tier ?? null) as SubTier | null;
  if (tier !== "premium" && tier !== "ultra") return;

  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/extract`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${workerSecret}`,
      },
      body: JSON.stringify({ order_id: orderId, login, password }),
    });
    if (!res.ok) {
      console.error(`[fulfil] worker dispatch failed ${res.status}:`, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.error("[fulfil] worker fetch error:", e);
  }
}


// ─── sold-elsewhere fallback ───────────────────────────────────────────

type StockRow = {
  qvsp_id: string; kind: string; region: string; skin_count: number | null;
  peak: string | null; rank_normalized: string | null; qvsp_price_cents: number | null;
};

/** qvsp refusing because the listing is gone (sold / pulled / not found). */
function isGoneError(e: unknown): boolean {
  if (e instanceof QvspApiError) {
    if ([404, 409, 410].includes(e.status)) return true;
    return /sold|not.?found|unavailable|no.?longer|taken|gone|reserved|out.?of.?stock/i.test(`${e.code} ${e.message}`);
  }
  return false;
}

function describeErr(e: unknown): string {
  return e instanceof QvspApiError ? `${e.status} ${e.code}: ${e.message}` : String(e).slice(0, 200);
}

/** Reserve the cheapest equivalent listing for this order, or null.
 *  Bracket orders → same skin-count bracket; skin orders → has that skin;
 *  X-Ray (specific account) orders have no equivalent. */
async function reserveEquivalent(orderId: string, gone: StockRow): Promise<StockRow | null> {
  const { data: o } = await db.from("orders").select("products(slug, name)").eq("id", orderId).single();
  const prod = (o?.products as unknown as { slug: string; name: string } | null) ?? null;
  if (!prod || prod.slug === "qvsp-xray") return null;

  let q = db
    .from("qvsp_stock")
    .select("qvsp_id, kind, region, skin_count, peak, rank_normalized, qvsp_price_cents")
    .eq("region", gone.region)
    .eq("kind", gone.kind)
    .is("reserved_order_id", null)
    .is("removed_at", null)
    .eq("claimed", false)
    .lte("public_at", new Date().toISOString())
    .neq("qvsp_id", gone.qvsp_id);

  if (prod.slug.startsWith("qvsp-skin-")) {
    q = q.overlaps("skins", skinVariants(prod.name));
  } else {
    const bracket = SKIN_BRACKETS.find((b) => prod.slug === `qvsp-${b.name}` || prod.slug === `qvsp-welcome-${b.name}`);
    if (!bracket) return null;
    // Stay within what the bracket was priced to cover.
    q = q.gte("skin_count", bracket.minSkins).lte("skin_count", bracket.maxSkins)
         .lte("qvsp_price_cents", bracket.maxAcceptableCostCents);
  }

  const { data: candidates } = await q.order("qvsp_price_cents", { ascending: true }).limit(10);
  for (const c of candidates ?? []) {
    const { data: picked } = await db.rpc("reserve_qvsp_stock", { p_order_id: orderId, p_qvsp_id: c.qvsp_id });
    if (picked) return c as StockRow;
  }
  return null;
}

/** No equivalent left: refund everything the client paid to credit. */
async function refundSoldOut(orderId: string, userId: string, discordId: string | null, itemName: string) {
  const { data: o } = await db.from("orders").select("credit_used_cents, charge_cents, status").eq("id", orderId).single();
  const paid = ((o?.credit_used_cents as number) ?? 0) + ((o?.charge_cents as number) ?? 0);
  await db.rpc("release_qvsp_stock", { p_order_id: orderId });
  const { data: upd } = await db
    .from("orders")
    .update({ status: "refunded_credit" })
    .eq("id", orderId)
    .neq("status", "refunded_credit")
    .select("id");
  if (!upd?.length) return;   // already refunded
  if (paid > 0) {
    await db.rpc("add_credit", { p_user_id: userId, p_cents: paid, p_reason: "sold_out_refund", p_order_id: orderId });
  }
  await logToStaff(`💸 Order ${orderId}: sold out on qvsp with no equivalent — refunded €${(paid / 100).toFixed(2)} to credit.`);
  if (discordId) {
    await notifyDiscordUser(
      discordId,
      `Sorry — the last **${itemName}** account sold out the moment you paid, and there was no matching one left. ` +
        `We've refunded the full **€${(paid / 100).toFixed(2)}** to your Val Unlocked credit — it's ready to spend now.`
    ).catch(() => {});
  }
}
