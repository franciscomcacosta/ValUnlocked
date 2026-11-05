// Fulfilment: called by the IPN handler when an order's payment finalizes.
// For an own/bought inventory row: just flip status to sold (legacy flow).
// For a qvsp-reserved row: call qvsp POST /orders, get creds, encrypt +
// create an inventory row, flip status, DM the buyer.
import { db } from "./supabase";
import { notifyDiscordUser } from "./discord";
import { buyAccount, type QvspKind } from "./qvsp";
import { encrypt } from "./crypto";

export async function fulfilOrder(orderId: string): Promise<boolean> {
  // Atomically claim this order. Duplicate IPN deliveries return null.
  const { data: claimed } = await db.rpc("claim_order_for_fulfilment", { p_order_id: orderId });
  if (!claimed) return false;

  // Load order + user + (legacy) reserved inventory_id.
  const { data: order } = await db
    .from("orders")
    .select("id, inventory_id, user_id, users(discord_id), products(name)")
    .eq("id", orderId)
    .single();
  if (!order) {
    console.error(`[fulfil] order ${orderId} vanished`);
    return false;
  }

  const user = order.users as unknown as { discord_id: string } | null;
  const product = order.products as unknown as { name: string } | null;

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
    .select("qvsp_id, kind, region, skin_count, peak, rank_normalized")
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

  // Actually buy from qvsp. This spends from our qvsp balance.
  let qvspOrder;
  try {
    qvspOrder = await buyAccount({
      kind: qvspRow.kind as QvspKind,
      id: qvspRow.qvsp_id,
    });
  } catch (e) {
    console.error(`[fulfil] qvsp buy failed for order ${orderId}`, e);
    // Leave reservation in place for a human to retry/refund.
    await db.from("orders").update({ status: "paid" }).eq("id", orderId);
    if (user?.discord_id) {
      await notifyDiscordUser(
        user.discord_id,
        `⚠️ Your payment was received but we hit a snag delivering your account. Staff will sort it out in a few minutes.`
      ).catch(() => {});
    }
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
      acquired_from: `qvsp:${qvspRow.qvsp_id}`,
      cost_cents: null,
      login_enc: encrypt(creds.login),
      password_enc: encrypt(creds.password),
      email_enc: encrypt(creds.email ?? ""),
      email_password_enc: encrypt(creds.email_password ?? ""),
      notes: `Region ${qvspRow.region} · ${qvspRow.skin_count} skins · peak ${qvspRow.peak ?? "N/A"}`,
      status: "sold",
    })
    .select("id")
    .single();
  if (invErr || !inv) {
    console.error("[fulfil] inventory insert failed", invErr);
    return false;
  }

  // Mark qvsp row claimed, attach inventory to the order, flip order status.
  await db.rpc("claim_qvsp_stock", { p_qvsp_id: qvspRow.qvsp_id, p_order_id: orderId });
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
      `✅ Your Valorant account is ready — **${qvspRow.region}**, **${qvspRow.skin_count} skins**, peak **${qvspRow.peak ?? "N/A"}**.\n` +
        `View credentials: ${process.env.PUBLIC_BASE_URL}/orders/${orderId}\n` +
        `Change the account and email passwords on first login.`
    ).catch((e) => console.error("[fulfil] DM failed", e));
  }

  return true;
}
