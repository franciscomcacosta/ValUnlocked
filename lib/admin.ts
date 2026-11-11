// Shared helpers for the admin panel API routes.
// Everything here runs server-side with the service-role client.
import { db } from "./supabase";
import { SUB_GRACE_HOURS, type SubTier } from "./pricing";

export const ADMIN_TIERS: SubTier[] = ["standard", "premium", "ultra"];

export const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`;

/** Read every row of a query in pages of 1000 (Supabase's per-request cap). */
export async function pageAll<T>(
  build: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  max = 50_000
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; from < max; from += 1000) {
    const { data, error } = await build(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** What a buyer actually paid for an order: store credit + crypto. */
export const paidCents = (o: { credit_used_cents?: number | null; charge_cents?: number | null }) =>
  (o.credit_used_cents ?? 0) + (o.charge_cents ?? 0);

/** Find a site user by our uuid, or by Discord id. */
export async function findUser(ref: { userId?: string | null; discordId?: string | null }) {
  const q = db.from("users").select("id, discord_id, discord_username, credit_cents, created_at");
  if (ref.userId) return (await q.eq("id", ref.userId).maybeSingle()).data;
  if (ref.discordId) return (await q.eq("discord_id", ref.discordId.trim()).maybeSingle()).data;
  return null;
}

/**
 * Add (positive) or remove (negative) store credit. Removals never take the
 * balance below €0. Returns the change actually applied and the new balance.
 * Goes through add_credit so it lands in the credit ledger.
 */
export async function changeCredit(
  userId: string,
  cents: number,
  reason: string,
  orderId: string | null = null
): Promise<{ delta: number; balance: number }> {
  const { data: before } = await db.from("users").select("credit_cents").eq("id", userId).single();
  const balance = (before?.credit_cents as number) ?? 0;
  const delta = cents < 0 ? -Math.min(balance, -cents) : cents;
  if (delta === 0) return { delta: 0, balance };
  const { error } = await db.rpc("add_credit", {
    p_user_id: userId,
    p_cents: delta,
    p_reason: reason.slice(0, 200),
    p_order_id: orderId,
  });
  if (error) throw new Error(error.message);
  const { data: after } = await db.from("users").select("credit_cents").eq("id", userId).single();
  return { delta, balance: (after?.credit_cents as number) ?? balance + delta };
}

/** Give a plan for N days. Same tier extends from the current end; a
 *  different tier switches and keeps whichever end date is later.
 *  (Same rules as the bot's /grant command.) */
export async function applyPlan(userId: string, tier: SubTier, days: number) {
  const { data: current } = await db
    .from("subscriptions")
    .select("id, tier, period_end")
    .eq("user_id", userId)
    .in("status", ["active", "grace"])
    .maybeSingle();
  const now = Date.now();
  const curEnd = current ? new Date(current.period_end as string).getTime() : 0;
  const end = new Date(
    current && current.tier === tier
      ? Math.max(now, curEnd) + days * 86_400_000
      : Math.max(curEnd, now + days * 86_400_000)
  );
  const fields = {
    tier,
    status: "active",
    period_end: end.toISOString(),
    grace_until: new Date(end.getTime() + SUB_GRACE_HOURS * 3_600_000).toISOString(),
    current_invoice_id: null,
    reminded_7d: false,
    reminded_3d: false,
    reminded_1d: false,
    cancelled_at: null,
  };
  const res = current
    ? await db.from("subscriptions").update(fields).eq("id", current.id).select("id").single()
    : await db.from("subscriptions").insert({ user_id: userId, ...fields }).select("id").single();
  if (res.error) throw new Error(res.error.message);
  return { end, previousTier: (current?.tier as SubTier | undefined) ?? null };
}

/** End a user's active plan. Returns the tier that was removed, if any. */
export async function removePlan(userId: string): Promise<SubTier | null> {
  const { data: current } = await db
    .from("subscriptions")
    .select("id, tier")
    .eq("user_id", userId)
    .in("status", ["active", "grace"])
    .maybeSingle();
  if (!current) return null;
  const { error } = await db
    .from("subscriptions")
    .update({ status: "expired", cancelled_at: new Date().toISOString() })
    .eq("id", current.id);
  if (error) throw new Error(error.message);
  return current.tier as SubTier;
}
