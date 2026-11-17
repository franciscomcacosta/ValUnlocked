// Shared payment-event handling, used by /api/ipn (NOWPayments) and /api/norpo.
// Branches on the order_id prefix:
//   "sub_<uuid>"  → subscription invoice (lib/subs.applyPaidSubInvoice)
//   "topup_<uuid>"→ credit top-up (apply_topup: paid + bonus, exactly once)
//   "<uuid>"      → account order (lib/fulfil.fulfilOrder)
// All branches are idempotent on duplicate deliveries.
import { db } from "@/lib/supabase";
import type { IpnPayload } from "@/lib/nowpayments";
import { fulfilOrder } from "@/lib/fulfil";
import { cancelOrder } from "@/lib/checkout";
import { applyPaidSubInvoice } from "@/lib/subs";
import { logToStaff } from "@/lib/discord";

const PAID = new Set(["finished", ...(process.env.FULFIL_ON_CONFIRMED === "true" ? ["confirmed"] : [])]);
const DEAD = new Set(["expired", "failed"]);
const IN_PROGRESS = new Set(["waiting", "confirming", "confirmed", "sending"]);

async function handleSubIpn(ipn: IpnPayload, paymentId: string, check: boolean): Promise<Response> {
  const subInvoiceId = ipn.order_id.replace(/^sub_/, "");

  const { data: inv } = await db
    .from("sub_invoices")
    .select("id, paid_at, tier, amount_cents, currency")
    .eq("id", subInvoiceId)
    .maybeSingle();
  if (!inv) return new Response("unknown sub invoice", { status: 200 });

  // Already paid → ack and ignore (idempotent).
  if (inv.paid_at) return new Response("ok");

  await db
    .from("sub_invoices")
    .update({
      np_payment_id: paymentId,
      np_status: ipn.payment_status,
    })
    .eq("id", inv.id);

  if (PAID.has(ipn.payment_status) && check && amountMismatch(ipn, inv.amount_cents, inv.currency)) {
    await logToStaff(`⚠️ Sub invoice ${inv.id}: paid amount/currency mismatch (${ipn.price_amount} ${ipn.price_currency}). Not applied — needs manual handling.`);
    return new Response("ok");
  }
  if (PAID.has(ipn.payment_status)) {
    const ok = await applyPaidSubInvoice(inv.id);
    if (ok) {
      await logToStaff(
        `💎 Sub paid: ${inv.tier} · ${(inv.amount_cents / 100).toFixed(2)} ${inv.currency.toUpperCase()}`
      );
    }
  } else if (DEAD.has(ipn.payment_status)) {
    await logToStaff(`⌛ Sub invoice ${inv.id} ${ipn.payment_status}. User will need to retry.`);
  }
  // IN_PROGRESS statuses just log, no action — payment is still settling.

  return new Response("ok");
}

async function handleTopupIpn(ipn: IpnPayload, paymentId: string, check: boolean): Promise<Response> {
  const id = ipn.order_id.replace(/^topup_/, "");
  const { data: top } = await db
    .from("topup_invoices")
    .select("id, user_id, pay_cents, bonus_cents, credited_at")
    .eq("id", id)
    .maybeSingle();
  if (!top) return new Response("unknown topup", { status: 200 });
  if (top.credited_at) return new Response("ok");   // idempotent

  await db
    .from("topup_invoices")
    .update({ np_payment_id: paymentId, np_status: ipn.payment_status })
    .eq("id", top.id);

  if (PAID.has(ipn.payment_status) && check && amountMismatch(ipn, top.pay_cents, "eur")) {
    await logToStaff(`⚠️ Top-up ${top.id}: paid amount/currency mismatch (${ipn.price_amount} ${ipn.price_currency}). Not credited — needs manual handling.`);
    return new Response("ok");
  }
  if (PAID.has(ipn.payment_status)) {
    const { data: credited } = await db.rpc("apply_topup", { p_id: top.id });
    if (credited && credited > 0) {
      await logToStaff(
        `💳 Top-up ${top.id}: €${(top.pay_cents / 100).toFixed(2)} paid, €${((top.pay_cents + top.bonus_cents) / 100).toFixed(2)} credited.`
      );
    }
  } else if (ipn.payment_status === "partially_paid") {
    await logToStaff(
      `⚠️ Top-up ${top.id} partially paid: ${ipn.actually_paid} ${ipn.pay_currency?.toUpperCase()}. Not credited — needs manual handling.`
    );
  }
  return new Response("ok");
}

async function handleOrderIpn(ipn: IpnPayload, paymentId: string, check: boolean): Promise<Response> {
  const { data: order } = await db
    .from("orders")
    .select("id, user_id, status, credit_used_cents, charge_cents, currency")
    .eq("id", ipn.order_id)
    .single();
  if (!order) return new Response("unknown order", { status: 200 });

  if (["fulfilled", "refunded_credit", "cancelled", "expired", "failed"].includes(order.status)) {
    return new Response("ok");
  }

  await db
    .from("orders")
    .update({
      np_payment_id: paymentId,
      np_status: ipn.payment_status,
      pay_currency: ipn.pay_currency ?? null,
      actually_paid: ipn.actually_paid ?? null,
    })
    .eq("id", order.id);

  if (PAID.has(ipn.payment_status) && check && amountMismatch(ipn, order.charge_cents, order.currency)) {
    await db.from("orders").update({ status: "partially_paid" }).eq("id", order.id);
    await logToStaff(`⚠️ Order ${order.id}: paid amount/currency mismatch (${ipn.price_amount} ${ipn.price_currency}). Not delivered — needs manual handling.`);
    return new Response("ok");
  }
  if (PAID.has(ipn.payment_status)) {
    const delivered = await fulfilOrder(order.id);
    if (delivered) {
      await logToStaff(
        `💰 Order ${order.id} paid (${(order.charge_cents / 100).toFixed(2)} ${order.currency.toUpperCase()}) and delivered.`
      );
    }
  } else if (ipn.payment_status === "partially_paid") {
    await db.from("orders").update({ status: "partially_paid" }).eq("id", order.id);
    await logToStaff(
      `⚠️ Order ${order.id} partially paid: ${ipn.actually_paid} ${ipn.pay_currency?.toUpperCase()}. Needs manual handling.`
    );
  } else if (DEAD.has(ipn.payment_status)) {
    await cancelOrder(order.id, order.user_id, order.credit_used_cents, ipn.payment_status as "expired" | "failed");
  } else if (IN_PROGRESS.has(ipn.payment_status)) {
    await db.from("orders").update({ status: ipn.payment_status }).eq("id", order.id);
  }

  return new Response("ok");
}

// Never hand over stock/credit for less than was charged (or in another currency).
function amountMismatch(ipn: IpnPayload, expectedCents: number, currency: string): boolean {
  const paid = Number(ipn.price_amount);
  if (ipn.price_amount == null || !Number.isFinite(paid)) return true;
  if (ipn.price_currency && ipn.price_currency.toLowerCase() !== currency.toLowerCase()) return true;
  return Math.round(paid * 100) < expectedCents;
}

// checkAmount: verify the paid amount/currency against our records (used for Norpo).
export function dispatchPaymentEvent(ipn: IpnPayload, paymentId: string, checkAmount = false): Promise<Response> {
  if (ipn.order_id?.startsWith("sub_")) return handleSubIpn(ipn, paymentId, checkAmount);
  if (ipn.order_id?.startsWith("topup_")) return handleTopupIpn(ipn, paymentId, checkAmount);
  return handleOrderIpn(ipn, paymentId, checkAmount);
}
