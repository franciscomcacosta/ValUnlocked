export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120; // fulfilOrder can wait on the Fly worker

// Norpo webhook. Register https://valunlock.online/api/norpo as an endpoint in
// the Norpo dashboard (Webhooks) and put its signing secret in NORPO_WEBHOOK_SECRET.
// Delivery is retried for ~10h until we return 2xx and can repeat, so everything
// downstream is idempotent. Stock/credit is only released from here — never from
// the customer's redirect back to the site.
import { db } from "@/lib/supabase";
import type { IpnPayload } from "@/lib/nowpayments";
import { verifyNorpoSignature } from "@/lib/norpo";
import { dispatchPaymentEvent } from "@/lib/payment-events";
import { logToStaff } from "@/lib/discord";

interface NorpoEvent {
  id?: string;
  event?: string;
  data?: { paymentId?: string; reference?: string; amount?: number | string; currency?: string };
}

export async function POST(req: Request) {
  const raw = await req.text();
  if (!verifyNorpoSignature(raw, req.headers.get("norpo-signature"), process.env.NORPO_WEBHOOK_SECRET)) {
    return new Response("bad signature", { status: 401 });
  }

  let evt: NorpoEvent;
  try { evt = JSON.parse(raw); } catch { return new Response("bad json", { status: 400 }); }
  const data = evt.data;
  if (!data?.paymentId || !data.reference) return new Response("ok");

  const paymentId = `norpo:${data.paymentId}`;
  const status =
    evt.event === "payment.settled" ? "finished" :
    evt.event === "payment.failed" ? "failed" :
    null;

  await db.from("ipn_events").insert({ payment_id: paymentId, payment_status: status ?? evt.event ?? "unknown", payload: evt });

  if (evt.event === "refund.created") {
    await logToStaff(`↩️ Norpo refund on ${data.reference} (${data.amount} ${data.currency}). Check the order manually.`);
    return new Response("ok");
  }
  if (!status) return new Response("ok"); // events we don't act on

  const ipn: IpnPayload = {
    payment_id: paymentId,
    payment_status: status,
    order_id: data.reference,
    pay_currency: "usdc",
    price_amount: Number(data.amount),
    price_currency: data.currency,
  };
  return dispatchPaymentEvent(ipn, paymentId, true);
}
