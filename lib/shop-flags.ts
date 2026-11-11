// Shop-wide switches stored in the shop_flags table (migration 010).
// Every read fails "open": if the table isn't there yet, sales carry on.
import { db } from "./supabase";

export type SalesPause = { paused: boolean; by?: "auto" | "manual"; reason?: string; since?: string };
export type CachedBalance = { cents: number; currency: string; at: string };

export async function getFlag<T>(key: string): Promise<T | null> {
  const { data, error } = await db.from("shop_flags").select("value").eq("key", key).maybeSingle();
  if (error || !data) return null;
  return data.value as T;
}

export async function setFlag(key: string, value: unknown): Promise<void> {
  const { error } = await db
    .from("shop_flags")
    .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) throw new Error(error.message);
}

export async function getSalesPause(): Promise<SalesPause> {
  return (await getFlag<SalesPause>("sales_paused")) ?? { paused: false };
}

/** Last qvsp balance the ops job saw, if it's fresh (≤ 10 min old). */
export async function getCachedBalance(): Promise<CachedBalance | null> {
  const b = await getFlag<CachedBalance>("qvsp_balance");
  if (!b || Date.now() - new Date(b.at).getTime() > 10 * 60_000) return null;
  return b;
}

/** Shown to buyers when sales are paused. */
export const PAUSED_MESSAGE = "We're restocking right now — purchases are paused for a few minutes. Please try again shortly.";
