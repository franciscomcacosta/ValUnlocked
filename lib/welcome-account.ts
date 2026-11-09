// Standard welcome gift: the first time someone PAYS for Standard, they get
// one free random 26–50 skins account. They claim it on the dashboard and
// pick the region themselves (stock differs per region).
//
// No extra table: eligibility is derived from data that already exists.
//   eligible = has a paid "initial" Standard invoice
//            AND has no live/delivered welcome order yet
// A welcome order that was cancelled or refunded (sold out mid-delivery)
// doesn't count, so they can claim again. Gifted / /grant plans create no
// invoice, so they don't include the free account.
import { db } from "./supabase";
import { SKIN_BRACKETS, type BracketName } from "./pricing";
import { fulfilOrder } from "./fulfil";

export const WELCOME_BRACKET: BracketName = "s_26_50";
export const WELCOME_SLUG = `qvsp-welcome-${WELCOME_BRACKET}`;
const REGIONS = ["EU", "NA", "AP", "KR", "LATAM", "BR"] as const;
const DEAD = ["cancelled", "refunded_credit", "expired", "failed"];

export type WelcomeStatus =
  | { state: "none" }                        // never paid for Standard
  | { state: "available" }                   // can claim now
  | { state: "claimed"; orderId: string };   // already has one

async function welcomeProductId(): Promise<string> {
  const { data: existing } = await db.from("products").select("id").eq("slug", WELCOME_SLUG).maybeSingle();
  if (existing?.id) return existing.id as string;
  const label = SKIN_BRACKETS.find((b) => b.name === WELCOME_BRACKET)!.label;
  const { data, error } = await db
    .from("products")
    .insert({
      slug: WELCOME_SLUG,
      name: `${label} · Standard welcome gift`,
      region: "—",
      price_cents: 0,
      currency: "eur",
      active: false,
      description: "Free random 26–50 skins account included with your first Standard plan.",
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`welcome product create failed: ${error?.message}`);
  return data.id as string;
}

export async function welcomeStatus(userId: string): Promise<WelcomeStatus> {
  const { data: paid } = await db
    .from("sub_invoices")
    .select("id")
    .eq("user_id", userId)
    .eq("tier", "standard")
    .eq("purpose", "initial")
    .not("paid_at", "is", null)
    .limit(1);
  if (!paid?.length) return { state: "none" };

  const productId = await welcomeProductId();
  const { data: orders } = await db
    .from("orders")
    .select("id, status")
    .eq("user_id", userId)
    .eq("product_id", productId)
    .order("created_at", { ascending: false });
  const live = (orders ?? []).find((o) => !DEAD.includes(o.status as string));
  return live ? { state: "claimed", orderId: live.id as string } : { state: "available" };
}

/** How many eligible 26–50 accounts each region has right now. */
export async function welcomeStock(): Promise<Record<string, number>> {
  const b = SKIN_BRACKETS.find((x) => x.name === WELCOME_BRACKET)!;
  const out: Record<string, number> = {};
  await Promise.all(
    REGIONS.map(async (r) => {
      const { count } = await db
        .from("qvsp_stock")
        .select("qvsp_id", { count: "exact", head: true })
        .eq("region", r)
        .eq("kind", "skinned")
        .gte("skin_count", b.minSkins)
        .lte("skin_count", b.maxSkins)
        .lte("qvsp_price_cents", b.maxAcceptableCostCents)
        .is("reserved_order_id", null)
        .is("removed_at", null)
        .eq("claimed", false)
        .lte("public_at", new Date().toISOString());
      out[r] = count ?? 0;
    })
  );
  return out;
}

export type ClaimResult =
  | { ok: true; orderId: string; delivered: boolean }
  | { ok: false; error: "not_eligible" | "already_claimed" | "invalid_region" | "out_of_stock" | "failed" };

export async function claimWelcomeAccount(userId: string, regionRaw: string): Promise<ClaimResult> {
  const region = regionRaw.toUpperCase();
  if (!(REGIONS as readonly string[]).includes(region)) return { ok: false, error: "invalid_region" };

  const st = await welcomeStatus(userId);
  if (st.state === "none") return { ok: false, error: "not_eligible" };
  if (st.state === "claimed") return { ok: false, error: "already_claimed" };

  const b = SKIN_BRACKETS.find((x) => x.name === WELCOME_BRACKET)!;
  const { data: candidates } = await db
    .from("qvsp_stock")
    .select("qvsp_id")
    .eq("region", region)
    .eq("kind", "skinned")
    .gte("skin_count", b.minSkins)
    .lte("skin_count", b.maxSkins)
    .lte("qvsp_price_cents", b.maxAcceptableCostCents)
    .is("reserved_order_id", null)
    .is("removed_at", null)
    .eq("claimed", false)
    .lte("public_at", new Date().toISOString())
    .limit(50);
  if (!candidates?.length) return { ok: false, error: "out_of_stock" };

  const productId = await welcomeProductId();
  const { data: order, error } = await db
    .from("orders")
    .insert({
      user_id: userId,
      product_id: productId,
      price_cents: b.publicPriceCents, // shown as "worth €6.99" — they pay 0
      credit_used_cents: 0,
      charge_cents: 0,
      currency: "eur",
    })
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
  for (const c of [...candidates].sort(() => Math.random() - 0.5)) {
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
