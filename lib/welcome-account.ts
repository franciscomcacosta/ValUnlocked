// Free-account gifts that members claim on the dashboard (they pick the
// region themselves — stock differs per region).
//
//   standard_welcome — first time someone PAYS for Standard → free 26–50
//   trial            — Standard trial from /trial            → free 1–25
//
// No extra table: eligibility comes from sub_invoices rows that already
// exist ("initial" paid Standard invoice, or a €0 "trial" marker row that
// /trial writes). A gift order that was cancelled or refunded (sold out
// mid-delivery) doesn't count, so they can claim again.
import { db } from "./supabase";
import { SKIN_BRACKETS, type BracketName } from "./pricing";
import { fulfilOrder } from "./fulfil";

export type GiftKind = "standard_welcome" | "trial";

type GiftSpec = { bracket: BracketName; purpose: string; name: string; description: string };
export const GIFTS: Record<GiftKind, GiftSpec> = {
  standard_welcome: {
    bracket: "s_26_50",
    purpose: "initial",
    name: "26–50 skins · Standard welcome gift",
    description: "Free random 26–50 skins account included with your first Standard plan.",
  },
  trial: {
    bracket: "s_1_25",
    purpose: "trial",
    name: "1–25 skins · Free trial gift",
    description: "Free random 1–25 skins account included with your Standard trial.",
  },
};
const ORDER: GiftKind[] = ["standard_welcome", "trial"];

// Kept for the swap logic in fulfil.ts (slug → bracket).
export const giftSlug = (k: GiftKind) => (k === "standard_welcome" ? `qvsp-welcome-${GIFTS[k].bracket}` : `qvsp-gift-${k}-${GIFTS[k].bracket}`);

const REGIONS = ["EU", "NA", "AP", "KR", "LATAM", "BR"] as const;
const DEAD = ["cancelled", "refunded_credit", "expired", "failed"];

export type GiftStatus =
  | { kind: GiftKind; state: "none" }
  | { kind: GiftKind; state: "available"; label: string; worthCents: number }
  | { kind: GiftKind; state: "claimed"; orderId: string };

async function giftProductId(kind: GiftKind): Promise<string> {
  const slug = giftSlug(kind);
  const { data: existing } = await db.from("products").select("id").eq("slug", slug).maybeSingle();
  if (existing?.id) return existing.id as string;
  const { data, error } = await db
    .from("products")
    .insert({ slug, name: GIFTS[kind].name, region: "—", price_cents: 0, currency: "eur", active: false, description: GIFTS[kind].description })
    .select("id")
    .single();
  if (error || !data) throw new Error(`gift product create failed: ${error?.message}`);
  return data.id as string;
}

export async function giftStatus(userId: string, kind: GiftKind): Promise<GiftStatus> {
  const { data: marker } = await db
    .from("sub_invoices")
    .select("id")
    .eq("user_id", userId)
    .eq("tier", "standard")
    .eq("purpose", GIFTS[kind].purpose)
    .not("paid_at", "is", null)
    .limit(1);
  if (!marker?.length) return { kind, state: "none" };

  const productId = await giftProductId(kind);
  const { data: orders } = await db
    .from("orders")
    .select("id, status")
    .eq("user_id", userId)
    .eq("product_id", productId)
    .order("created_at", { ascending: false });
  const live = (orders ?? []).find((o) => !DEAD.includes(o.status as string));
  if (live) return { kind, state: "claimed", orderId: live.id as string };
  const b = SKIN_BRACKETS.find((x) => x.name === GIFTS[kind].bracket)!;
  return { kind, state: "available", label: b.label, worthCents: b.publicPriceCents };
}

/** All gifts for this user, best first. */
export async function allGifts(userId: string): Promise<GiftStatus[]> {
  return Promise.all(ORDER.map((k) => giftStatus(userId, k)));
}

/** Back-compat for lib/subs.ts (Standard purchase DM). */
export async function welcomeStatus(userId: string) {
  const s = await giftStatus(userId, "standard_welcome");
  return { state: s.state };
}

function stockQuery(kind: GiftKind, region: string) {
  const b = SKIN_BRACKETS.find((x) => x.name === GIFTS[kind].bracket)!;
  return db
    .from("qvsp_stock")
    .select("qvsp_id", { count: "exact" })
    .eq("region", region)
    .eq("kind", "skinned")
    .gte("skin_count", b.minSkins)
    .lte("skin_count", b.maxSkins)
    .lte("qvsp_price_cents", b.maxAcceptableCostCents)
    .is("reserved_order_id", null)
    .is("removed_at", null)
    .eq("claimed", false)
    .lte("public_at", new Date().toISOString());
}

/** How many eligible accounts each region has for this gift right now. */
export async function giftStock(kind: GiftKind): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await Promise.all(
    REGIONS.map(async (r) => {
      const { count } = await stockQuery(kind, r).limit(1);
      out[r] = count ?? 0;
    })
  );
  return out;
}

export type ClaimResult =
  | { ok: true; orderId: string; delivered: boolean }
  | { ok: false; error: "not_eligible" | "already_claimed" | "invalid_region" | "out_of_stock" | "failed" };

export async function claimGift(userId: string, kind: GiftKind, regionRaw: string): Promise<ClaimResult> {
  const region = regionRaw.toUpperCase();
  if (!(REGIONS as readonly string[]).includes(region)) return { ok: false, error: "invalid_region" };
  if (!GIFTS[kind]) return { ok: false, error: "not_eligible" };

  const st = await giftStatus(userId, kind);
  if (st.state === "none") return { ok: false, error: "not_eligible" };
  if (st.state === "claimed") return { ok: false, error: "already_claimed" };

  // Free gifts take the cheapest matching listings (keeps promo cost down).
  const { data: candidates } = await stockQuery(kind, region).order("qvsp_price_cents", { ascending: true }).limit(25);
  if (!candidates?.length) return { ok: false, error: "out_of_stock" };

  const b = SKIN_BRACKETS.find((x) => x.name === GIFTS[kind].bracket)!;
  const productId = await giftProductId(kind);
  const { data: order, error } = await db
    .from("orders")
    .insert({ user_id: userId, product_id: productId, price_cents: b.publicPriceCents, credit_used_cents: 0, charge_cents: 0, currency: "eur" })
    .select("id")
    .single();
  if (error || !order) return { ok: false, error: "failed" };

  // Double-click guard: if a second claim raced us, keep only the oldest.
  const again = await db
    .from("orders")
    .select("id")
    .eq("user_id", userId)
    .eq("product_id", productId)
    .not("status", "in", `(${DEAD.join(",")})`)
    .order("created_at", { ascending: true });
  if ((again.data?.[0]?.id as string | undefined) !== order.id) {
    await db.from("orders").update({ status: "cancelled" }).eq("id", order.id);
    return { ok: false, error: "already_claimed" };
  }

  let reserved = false;
  for (const c of candidates) {
    const { data: picked } = await db.rpc("reserve_qvsp_stock", { p_order_id: order.id, p_qvsp_id: c.qvsp_id });
    if (picked) { reserved = true; break; }
  }
  if (!reserved) {
    await db.from("orders").update({ status: "cancelled" }).eq("id", order.id);
    return { ok: false, error: "out_of_stock" };
  }

  const delivered = await fulfilOrder(order.id as string);
  return { ok: true, orderId: order.id as string, delivered };
}
