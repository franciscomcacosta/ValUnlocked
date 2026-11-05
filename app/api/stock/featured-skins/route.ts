// GET /api/stock/featured-skins?region=EU
// For each featured skin, find the cheapest available qvsp account in the
// given region that contains that skin, count how many match, and compute
// public + tier-adjusted price.
import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { FEATURED_SKINS, featuredPriceForUser, type SubTier } from "@/lib/pricing";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  const url = new URL(req.url);
  const region = url.searchParams.get("region")?.toUpperCase();
  if (!region) return Response.json({ error: "region_required" }, { status: 400 });

  // Current tier for pricing.
  const { data: sub } = await db
    .from("subscriptions")
    .select("tier")
    .eq("user_id", session.uid)
    .in("status", ["active", "grace"])
    .maybeSingle();
  const tier = (sub?.tier ?? null) as SubTier | null;

  // One parallel query per featured skin: cheapest qvsp cost + count for
  // any row where skins[] overlaps with the skin's matchAny variants.
  // Supabase JS doesn't do GROUP BY on expressions, so we fetch minimal
  // columns and reduce in-process. Kept to one query per featured skin to
  // keep the response under 150ms even with 12 skins.
  const results = await Promise.all(
    FEATURED_SKINS.map(async (skin) => {
      const { data, error } = await db
        .from("qvsp_stock")
        .select("qvsp_price_cents")
        .eq("region", region)
        .eq("kind", "skinned")
        .overlaps("skins", skin.matchAny)
        .is("reserved_order_id", null)
        .is("removed_at", null)
        .eq("claimed", false)
        .lte("public_at", new Date().toISOString());
      if (error || !data || data.length === 0) {
        return {
          key: skin.label,
          label: skin.label,
          weapon: skin.weapon,
          available: 0,
          cheapestQvspCents: null,
          publicCents: 0,
          finalCents: 0,
          savingsCents: 0,
          discountPct: 0,
        };
      }
      const prices = data.map((r) => r.qvsp_price_cents as number).filter((n) => Number.isFinite(n));
      const cheapest = Math.min(...prices);
      const p = featuredPriceForUser(cheapest, skin.minPriceCents, tier);
      return {
        key: skin.label,
        label: skin.label,
        weapon: skin.weapon,
        available: data.length,
        cheapestQvspCents: cheapest,
        publicCents: p.publicCents,
        finalCents: p.finalCents,
        savingsCents: p.savingsCents,
        discountPct: p.discountPct,
      };
    })
  );

  return Response.json({ ok: true, tier, region, skins: results });
}
