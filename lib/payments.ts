// Single entry point for creating a payment. New payments always go through
// Norpo (card checkout, settles as USDC). NOWPayments is no longer offered:
// lib/nowpayments.ts and /api/ipn stay only so invoices that were already
// issued can still be verified and delivered, and old pay links keep working.
import { createNorpoPayment } from "./norpo";

export interface InvoiceResult {
  id: string;
  invoice_url: string;
}

export async function createInvoice(opts: {
  orderId: string;
  priceCents: number;
  currency: string;
  description: string;
  successPath?: string;
}): Promise<InvoiceResult> {
  return createNorpoPayment(opts);
}

// Pay link for an existing invoice id. Norpo ids carry a "norpo:" prefix, so
// older NOWPayments orders keep their old link.
export function invoiceLink(id: string): string {
  if (id.startsWith("norpo:")) return `https://api.norpo.io/return/p/${id.slice("norpo:".length)}`;
  return `https://nowpayments.io/payment/?iid=${id}`;
}
