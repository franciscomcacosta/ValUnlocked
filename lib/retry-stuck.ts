// Retry orders that were paid (or are free gifts) but whose qvsp purchase
// failed with a non-"sold" error — e.g. qvsp API changes, low balance,
// timeouts. fulfilOrder() leaves those as status "paid" with the account
// still held, so they can be safely re-run here. qvsp's idempotency key
// (derived from order + listing) means a retry can never double-buy.
import { db } from "./supabase";
import { fulfilOrder } from "./fulfil";

export type RetryResult = { orderId: string; delivered: boolean; status: string };

export async function retryStuckOrders(opts: { maxAgeMinutes?: number; limit?: number } = {}): Promise<RetryResult[]> {
  let q = db
    .from("orders")
    .select("id")
    .eq("status", "paid")
    .is("inventory_id", null)
    .order("created_at", { ascending: true })
    .limit(opts.limit ?? 25);
  if (opts.maxAgeMinutes) q = q.gte("paid_at", new Date(Date.now() - opts.maxAgeMinutes * 60_000).toISOString());
  const { data } = await q;

  const out: RetryResult[] = [];
  for (const o of data ?? []) {
    // Move it back out of "paid" so fulfilOrder's atomic claim accepts it.
    // The status filter makes this race-safe (two retries can't both win).
    const { data: flipped } = await db
      .from("orders")
      .update({ status: "confirmed" })
      .eq("id", o.id)
      .eq("status", "paid")
      .select("id");
    if (!flipped?.length) continue;
    const delivered = await fulfilOrder(o.id as string).catch(() => false);
    const { data: now } = await db.from("orders").select("status").eq("id", o.id).single();
    out.push({ orderId: o.id as string, delivered, status: (now?.status as string) ?? "?" });
  }
  return out;
}
