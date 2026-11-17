import { createHmac, timingSafeEqual } from "crypto";

// Norpo (https://norpo.io/docs): card checkout that settles to us as USDC.
// Docs: POST /v1/payments with a Bearer secret key; payment events arrive as
// signed webhooks (Norpo-Signature: t=<ms>,v1=<hmac>) to the endpoint we
// register in the Norpo dashboard.
const API = process.env.NORPO_API_BASE ?? "https://api.norpo.io";

export interface NorpoPayment {
  id: string;         // "norpo:<paymentId>" — the prefix tells us which provider owns it
  invoice_url: string; // where to send the customer (order.url)
}

export async function createNorpoPayment(opts: {
  orderId: string;       // our reference, echoed back in the webhook as data.reference
  priceCents: number;
  currency: string;
  successPath?: string;  // defaults to /orders/<orderId>
}): Promise<NorpoPayment> {
  const base = process.env.PUBLIC_BASE_URL!;
  const key = process.env.NORPO_SECRET_KEY;
  if (!key) throw new Error("NORPO_SECRET_KEY not set");

  const res = await fetch(`${API}/v1/payments`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      amount: Number((opts.priceCents / 100).toFixed(2)), // decimal, not cents
      currency: opts.currency.toUpperCase(),
      reference: opts.orderId,
      redirectUrl: `${base}${opts.successPath ?? `/orders/${opts.orderId}`}`,
    }),
  });
  if (!res.ok) throw new Error(`Norpo payment failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  const url = data?.order?.url;
  if (!data?.paymentId || !url) throw new Error("Norpo payment: unexpected response shape");
  return { id: `norpo:${data.paymentId}`, invoice_url: url };
}

// Norpo-Signature = HMAC-SHA256 over `${t}.${rawBody}`, hex (per docs; the docs
// don't say whether the key is the full "whsec_…" string or the part after the
// prefix, so both are accepted). Verify against the RAW body.
export function verifyNorpoSignature(rawBody: string, header: string | null, secret: string | undefined): boolean {
  if (!header || !secret) return false;
  let t = "";
  const v1: string[] = [];
  for (const part of header.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") v1.push(v.toLowerCase());
  }
  if (!t || v1.length === 0) return false;

  const keys = new Set([secret, secret.replace(/^whsec_/, "")]);
  for (const key of keys) {
    const expected = Buffer.from(createHmac("sha256", key).update(`${t}.${rawBody}`).digest("hex"), "utf8");
    for (const sig of v1) {
      const got = Buffer.from(sig, "utf8");
      if (got.length === expected.length && timingSafeEqual(got, expected)) return true;
    }
  }
  return false;
}
