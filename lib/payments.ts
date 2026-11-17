// Single entry point for creating a payment. PAYMENT_PROVIDER=norpo switches new
// payments to Norpo; anything else (default) keeps using NOWPayments, so nothing
// changes until the env var is flipped. Callers keep their existing shape:
// { id, invoice_url } — `id` is stored in np_invoice_id.
import { createInvoice as createNowInvoice, type InvoiceResult } from "./nowpayments";
import { createNorpoPayment } from "./norpo";

export type { InvoiceResult };

export function paymentProvider(): "norpo" | "nowpayments" {
  return process.env.PAYMENT_PROVIDER === "norpo" ? "norpo" : "nowpayments";
}

export async function createInvoice(opts: {
  orderId: string;
  priceCents: number;
  currency: string;
  description: string;
  successPath?: string;
}): Promise<InvoiceResult> {
  if (paymentProvider() === "norpo") return createNorpoPayment(opts);
  return createNowInvoice(opts);
}

// Pay link for an existing invoice id. Norpo ids carry a "norpo:" prefix, so
// old NOWPayments orders keep their old link after the switch.
export function invoiceLink(id: string): string {
  if (id.startsWith("norpo:")) return `https://api.norpo.io/return/p/${id.slice("norpo:".length)}`;
  return `https://nowpayments.io/payment/?iid=${id}`;
}
