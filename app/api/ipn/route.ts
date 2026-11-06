export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// NOWPayments IPN handler. Branches on the order_id prefix:
//   "sub_<uuid>"  → subscription invoice (lib/subs.applyPaidSubInvoice)
//   "<uuid>"      → account order (lib/fulfil.fulfilOrder)
//
// Both branches log raw events to ipn_events for audit, verify HMAC,
// and are idempotent on duplicate deliveries.
import { db } from "@/lib/supabase";
import { verifyIpn, type IpnPayload } from "@/lib/nowpayments";
import { fulfilOrder } from "@/lib/fulfil";
import { cancelOrder } from "@/lib/checkout";
import { applyPaidSubInvoice } from "@/lib/subs";
import { logToStaff } from "@/lib/discord";


const PAID = new Set(["finished", ...(process.env.FULFIL_ON_CONFIRMED === "true" ? ["confirmed"] : [])]);
const DEAD = new Set(["expired", "failed"]);
const IN_PROGRESS = new Set(["waiting", "confirming", "confirmed", "sending"]);

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyIpn(raw, req.headers.get("x-nowpayments-sig"))) {
    return new Response("bad signature", { status: 401 });
  }

  const ipn = JSON.parse(raw) as IpnPayload;
  const paymentId = String(ipn.payment_id);

  await db
    .from("ipn_events")
    .insert({ payment_id: paymentId, payment_status: ipn.payment_status, payload: ipn });

  // Route by order_id prefix.
  if (ipn.order_id?.startsWith("sub_")) {
    return handleSubIpn(ipn, paymentId);
  }
  return handleOrderIpn(ipn, paymentId);
}

async function handleSubIpn(ipn: IpnPayload, paymentId: string): Promise<Response> {
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

async function handleOrderIpn(ipn: IpnPayload, paymentId: string): Promise<Response> {
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
