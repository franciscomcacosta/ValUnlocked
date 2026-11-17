export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// fulfilOrder waits up to 90s on the Fly worker's /verify endpoint.
// Keep ~30s of headroom for buyAccount, DB writes, DM, etc.
export const maxDuration = 120;

// NOWPayments IPN handler. Verifies the HMAC, logs the raw event to ipn_events
// for audit, then hands off to lib/payment-events (shared with /api/norpo).
import { db } from "@/lib/supabase";
import { verifyIpn, type IpnPayload } from "@/lib/nowpayments";
import { dispatchPaymentEvent } from "@/lib/payment-events";

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

  return dispatchPaymentEvent(ipn, paymentId);
}
