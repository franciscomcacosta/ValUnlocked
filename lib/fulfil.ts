// Fulfilment: called by the IPN handler when an order's payment finalizes.
// For an own/bought inventory row: just flip status to sold (legacy flow).
// For a qvsp-reserved row: call qvsp POST /orders, get creds, encrypt +
// create an inventory row, flip status, DM the buyer.
import { db } from "./supabase";
import { notifyDiscordUser } from "./discord";
import { buyAccount, QvspApiError, type QvspKind, type QvspOrder } from "./qvsp";
import { encrypt, decrypt } from "./crypto";
import { SKIN_BRACKETS } from "./pricing";
import { skinVariants } from "./skin-names";
import { logToStaff } from "./discord";
import { rewardReferral } from "./referrals";
import { accountReadyMessage, orderReadyMessage, deliveryDelayedMessage, giftSoldOutMessage, soldOutRefundMessage } from "./discord-messages";

export async function fulfilOrder(orderId: string): Promise<boolean> {
  const delivered = await deliverOrder(orderId);
  // First paid order of an invited friend → referral credit for both.
  if (delivered) await rewardReferral(orderId).catch((e) => console.error("[fulfil] referral reward failed", e));
  return delivered;
}

async function deliverOrder(orderId: string): Promise<boolean> {
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
      // Inline login + password in the DM so the buyer can grab them
      // straight from Discord. Full details (incl. recovery email) stay
      // on the order page.
      const { data: inv } = await db
        .from("inventory")
        .select("login_enc, password_enc")
        .eq("id", order.inventory_id)
        .maybeSingle();
      let login: string | null = null;
      let password: string | null = null;
      if (inv?.login_enc && inv?.password_enc) {
        try {
          login = decrypt(inv.login_enc);
          password = decrypt(inv.password_enc);
        } catch (e) {
          console.error("[fulfil] decrypt failed", e);
        }
      }
      await notifyDiscordUser(
        user.discord_id,
        orderReadyMessage({ orderId, productName: product?.name ?? "Your account", login, password })
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

  // Buy from qvsp → verify the credentials work → if broken, swap and try
  // the next equivalent. Two swap reasons: (a) qvsp sold it to someone
  // else before our POST, (b) the creds qvsp gave us don't log in.
  //
  // Verification runs in the Fly worker: it attempts the login in a
  // headless browser and records video. On failure we have a proof
  // video we can hand qvsp to open a replacement ticket; the buyer
  // never sees the broken account.
  //
  // If the worker can't give a verdict (captcha, timeout), we fall back
  // to today's behavior: deliver with a 10-min test window and dispatch
  // the async extractor for the recovery email.
  let qvspOrder: QvspOrder | null = null;
  let row = qvspRow;
  let verifiedEmail: string | null = null;
  let verifyVerdict: "ok" | "unverified" | null = null;
  for (let attempt = 0; attempt < 4 && !qvspOrder; attempt++) {
    try {
      qvspOrder = await buyAccount({ kind: row.kind as QvspKind, id: row.qvsp_id, orderRef: orderId });
    } catch (e) {
      if (!isGoneError(e)) {
        console.error(`[fulfil] qvsp buy failed for order ${orderId}`, e);
        // Not a "sold elsewhere" error (e.g. our qvsp balance): leave the
        // reservation for a human to retry/refund.
        await db.from("orders").update({ status: "paid" }).eq("id", orderId);
        await logToStaff(`⚠️ Order ${orderId}: qvsp buy failed (${describeErr(e)}). Needs a manual retry or refund.`);
        if (user?.discord_id) {
          await notifyDiscordUser(user.discord_id, deliveryDelayedMessage({ orderId })).catch(() => {});
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
      continue;
    }

    // qvsp accepted the buy. Check the creds shape before verifying.
    const peekCreds = qvspOrder.credentials;
    if (!peekCreds?.login || !peekCreds?.password) {
      const shape = String((qvspOrder as Record<string, unknown>)._shape ?? "?");
      console.error(`[fulfil] qvsp order ${qvspOrder.id || "?"} returned no credentials · shape ${shape}`);
      await db.from("orders").update({ status: "paid" }).eq("id", orderId);
      await logToStaff(
        `⚠️ Order ${orderId}: qvsp accepted the purchase (qvsp order ${qvspOrder.id || "unknown"}) but sent no readable login yet. ` +
          `Will retry. Response shape (values hidden): \`${shape.slice(0, 600)}\``
      );
      return false;
    }

    // Pre-flight the credentials in the headless worker.
    const verdict = await verifyCredsWithWorker(orderId, peekCreds.login, peekCreds.password);
    if (verdict.ok) {
      verifiedEmail = verdict.email;
      verifyVerdict = "ok";
      break;
    }
    if (verdict.reason === "login_invalid" || verdict.reason === "login_timeout") {
      // Account's creds don't work. File an AUTOMATED replacement claim
      // against this exact qvsp order so we recover our money, then swap
      // for an equivalent and buy again for the end user.
      await autoFileReplacementClaim({
        orderId,
        qvspOrderId: qvspOrder.id ?? null,
        login: peekCreds.login,
        reason: verdict.reason,   // maps to qvsp's "login" category
        videoPath: verdict.video_path ?? null,
      }).catch((e) => console.error("[fulfil] auto-file replacement failed", e));
      await db.from("qvsp_stock").update({ removed_at: new Date().toISOString() }).eq("qvsp_id", row.qvsp_id);
      await db.rpc("release_qvsp_stock", { p_order_id: orderId });
      const alt = await reserveEquivalent(orderId, row);
      if (!alt) {
        await refundSoldOut(orderId, order.user_id as string, user?.discord_id ?? null, product?.name ?? "your account");
        return false;
      }
      row = alt;
      qvspOrder = null;  // reset so the loop buys the swap
      continue;
    }
    // captcha_present / email_not_found / worker_error / extraction_timeout:
    // can't be sure the account is bad. Trust qvsp, deliver with the 10-min
    // test window as the safety net. Don't swap.
    verifyVerdict = "unverified";
    console.warn(`[fulfil] order ${orderId}: verify inconclusive (${verdict.reason}) — delivering with test-window fallback`);
    break;
  }
  if (!qvspOrder) {
    await refundSoldOut(orderId, order.user_id as string, user?.discord_id ?? null, product?.name ?? "your account");
    return false;
  }

  // Save qvsp's order id right away so the purchase is never "lost" even if
  // the credentials aren't readable yet (retries replay the same order).
  if (qvspOrder.id) await db.from("orders").update({ qvsp_order_id: qvspOrder.id }).eq("id", orderId);

  const creds = qvspOrder.credentials!;  // non-null; checked inside the loop

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
      // Prefer the email we just scraped from the Riot account (verified
      // email) over whatever qvsp claims. qvsp often leaves this blank.
      email_enc: encrypt(verifiedEmail ?? creds.email ?? ""),
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
    // Two DM shapes based on whether verify succeeded.
    //  - ok    → single DM with login + password + email, no test window
    //            (we already logged in successfully, no need to re-test)
    //  - other → login + password now, email arrives in a second DM from
    //            the async /extract callback, plus the 10-min test window
    await notifyDiscordUser(
      user.discord_id,
      accountReadyMessage({
        orderId,
        region: String(row.region),
        skins: (row.skin_count as number) ?? 0,
        peak: (row.peak as string | null) ?? null,
        login: creds.login,
        password: creds.password,
        email: verifiedEmail,
        verified: verifyVerdict === "ok" && !!verifiedEmail,
      })
    ).catch((e) => console.error("[fulfil] DM failed", e));
  }

  // Dispatch the async email extractor only when verify didn't already
  // get us the email (captcha / timeout / worker_error paths).
  if (!verifiedEmail) {
    void dispatchEmailExtraction(orderId, creds.login, creds.password);
  }

  return true;
}

/** File a replacement claim against qvsp automatically after our
 *  pre-delivery verifier caught broken creds. Uses the same path as a
 *  buyer-reported claim: insert a row, call forwardClaimToQvsp, which
 *  signs the video + uploads to qvsp's /replace/proof + opens the ticket.
 *  Idempotent — a duplicate insert against an open claim is ignored. */
async function autoFileReplacementClaim(opts: {
  orderId: string;
  qvspOrderId: string | null;
  login: string;
  reason: "login_invalid" | "login_timeout";
  videoPath: string | null;
}): Promise<void> {
  const { forwardClaimToQvsp } = await import("./claims");

  // Grab the buyer's user_id so the row is well-formed. We still mark
  // this as an auto-filed claim via outcome_note for staff auditing.
  const { data: order } = await db
    .from("orders")
    .select("user_id")
    .eq("id", opts.orderId)
    .single();
  if (!order) return;

  // qvsp's category 'login' covers both login_invalid and login_timeout
  // (we never attempted an MFA step, so it's never login_mfa).
  const { data: claim, error } = await db
    .from("replacement_claims")
    .insert({
      order_id: opts.orderId,
      user_id: order.user_id,
      reason: "login",
      details: `AUTO: pre-delivery verifier said ${opts.reason} for login \`${opts.login}\``,
      video_path: opts.videoPath,
      // Our auto-claim is to recover OUR cost, not to refund the buyer —
      // they haven't paid for this broken account, they're getting a
      // swap. Refund amount is 0 since nothing was delivered to them.
      refund_cents: 0,
      bonus_cents: 0,
      outcome_note: "auto_filed_pre_delivery",
    })
    .select("id")
    .single();
  if (error || !claim) {
    // If the unique index trips because a buyer-filed claim already
    // exists for this order, skip. That's fine — the buyer's claim
    // carries the real refund and takes precedence.
    if (/duplicate|unique/i.test(error?.message ?? "")) {
      await logToStaff(
        `🤖 Order ${opts.orderId}: auto pre-delivery claim skipped (buyer already filed one). Our swap is still happening.`
      );
      return;
    }
    await logToStaff(
      `🤖 Order ${opts.orderId}: auto pre-delivery claim insert failed (${error?.message ?? "?"}). ` +
        `We still swapped the account for the buyer — but the qvsp refund wasn't filed. Follow up.`
    );
    return;
  }

  await logToStaff(
    `🤖 Order ${opts.orderId}: pre-delivery verifier caught \`${opts.reason}\` on login \`${opts.login}\`. ` +
      `Filed replacement claim \`${claim.id.slice(0, 8)}\` with qvsp automatically. ` +
      (opts.qvspOrderId ? `qvsp order: \`${opts.qvspOrderId}\`.` : "")
  );

  // Fire-and-forget the actual qvsp API call. forwardClaimToQvsp
  // handles its own error logging into forward_error + staff.
  try {
    await forwardClaimToQvsp(claim.id);
  } catch (e) {
    console.error("[fulfil] forwardClaimToQvsp threw", e);
  }
}

/** Call the Fly worker's /verify endpoint synchronously and wait up to 90s
 *  for a verdict. Returns the verdict, or a synthetic worker_error if the
 *  dispatch itself fails. */
async function verifyCredsWithWorker(
  orderId: string,
  login: string,
  password: string
): Promise<
  | { ok: true; email: string }
  | { ok: false; reason: string; video_path?: string; detail?: string }
> {
  const workerUrl = process.env.EXTRACTOR_WORKER_URL;
  const workerSecret = process.env.EXTRACTOR_WORKER_SECRET;
  if (!workerUrl || !workerSecret) return { ok: false, reason: "worker_disabled" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const res = await fetch(`${workerUrl.replace(/\/$/, "")}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${workerSecret}`,
      },
      body: JSON.stringify({ order_id: orderId, login, password }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: "worker_error", detail: `${res.status} ${text.slice(0, 200)}` };
    }
    return (await res.json()) as Awaited<ReturnType<typeof verifyCredsWithWorker>>;
  } catch (e) {
    return { ok: false, reason: "worker_error", detail: String(e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

/** Fire the Fly worker to log in and extract the Riot-recovery email. */
async function dispatchEmailExtraction(
  orderId: string,
  login: string,
  password: string
): Promise<void> {
  const workerUrl = process.env.EXTRACTOR_WORKER_URL;
  const workerSecret = process.env.EXTRACTOR_WORKER_SECRET;
  if (!workerUrl || !workerSecret) return; // feature disabled

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
    const bracket = SKIN_BRACKETS.find(
      (b) => prod.slug === `qvsp-${b.name}` || (/^qvsp-(welcome|gift-[a-z_]+)-/.test(prod.slug) && prod.slug.endsWith(`-${b.name}`))
    );
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
  if (paid === 0) {
    // Free gift: the order is now "refunded", which re-opens the gift.
    await logToStaff(`🎁 Order ${orderId}: free gift sold out mid-delivery — gift re-opened for the buyer.`);
    if (discordId) {
      await notifyDiscordUser(discordId, giftSoldOutMessage({ itemName })).catch(() => {});
    }
    return;
  }
  await logToStaff(`💸 Order ${orderId}: sold out on qvsp with no equivalent — refunded €${(paid / 100).toFixed(2)} to credit.`);
  if (discordId) {
    const { data: bal } = await db.from("users").select("credit_cents").eq("id", userId).maybeSingle();
    await notifyDiscordUser(
      discordId,
      soldOutRefundMessage({ orderId, itemName, refundCents: paid, balanceCents: (bal?.credit_cents as number | undefined) ?? null })
    ).catch(() => {});
  }
}
