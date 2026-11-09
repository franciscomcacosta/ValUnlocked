import { createHmac, timingSafeEqual } from "crypto";

const API = "https://api.nowpayments.io/v1";

export interface InvoiceResult {
  id: string;
  invoice_url: string;
}

// Creates a hosted invoice. The buyer picks a coin on NOWPayments' page.
export async function createInvoice(opts: {
  orderId: string;
  priceCents: number;
  currency: string;
  description: string;
  successPath?: string;   // defaults to /orders/<orderId>
}): Promise<InvoiceResult> {
  const base = process.env.PUBLIC_BASE_URL!;
  const res = await fetch(`${API}/invoice`, {
    method: "POST",
    headers: {
      "x-api-key": process.env.NOWPAYMENTS_API_KEY!,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      price_amount: opts.priceCents / 100,
      price_currency: opts.currency,
      order_id: opts.orderId,
      order_description: opts.description,
      ipn_callback_url: `${base}/api/ipn`,
      success_url: `${base}${opts.successPath ?? `/orders/${opts.orderId}`}`,
      cancel_url: `${base}${opts.successPath ?? `/orders/${opts.orderId}`}`,
      is_fee_paid_by_user: true, // fewer partially_paid orders
    }),
  });
  if (!res.ok) throw new Error(`NOWPayments invoice failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { id: String(data.id), invoice_url: data.invoice_url };
}

// NOWPayments signs the IPN body: HMAC-SHA512 over JSON with keys sorted
// (recursively), keyed with your IPN secret, sent in `x-nowpayments-sig`.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((value as Record<string, unknown>)[k]);
        return acc;
      }, {});
  }
  return value;
}

export function verifyIpn(rawBody: string, signature: string | null): boolean {
  if (!signature) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return false;
  }
  const expected = createHmac("sha512", process.env.NOWPAYMENTS_IPN_SECRET!)
    .update(JSON.stringify(sortKeys(parsed)))
    .digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signature.toLowerCase(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface IpnPayload {
  payment_id: number | string;
  payment_status: string; // waiting | confirming | confirmed | sending | partially_paid | finished | failed | refunded | expired
  order_id: string;
  invoice_id?: number | string;
  pay_currency?: string;
  actually_paid?: number;
  price_amount?: number;
  price_currency?: string;
}
