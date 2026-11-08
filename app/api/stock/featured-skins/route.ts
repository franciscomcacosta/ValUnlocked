// GET /api/stock/featured-skins?region=EU
// For each featured skin, find the cheapest available qvsp account in the
// given region that contains that skin, count how many match, and compute
// public + tier-adjusted price.
import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { FEATURED_SKINS, featuredPriceForUser, type SubTier } from "@/lib/pricing";
import { lookupSkinArt } from "@/lib/valorant-assets";

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
      // Enrich with art from valorant-api.com (cached 24h in-process).
      // skin.label already includes the weapon name ("Reaver Vandal"), so
      // we look up by label alone — not label+weapon which would duplicate.
      const art = await lookupSkinArt(skin.label);

      if (error || !data || data.length === 0) {
        // Sold-out: still compute a display price from the per-skin floor so
        // "from €X" shows what you'd pay once stock returns, not €0.00.
        const indicative = featuredPriceForUser(skin.minPriceCents, skin.minPriceCents, tier);
        return {
          key: skin.label,
          label: skin.label,
          weapon: skin.weapon,
          available: 0,
          cheapestQvspCents: null,
          publicCents: indicative.publicCents,
          finalCents: indicative.finalCents,
          savingsCents: indicative.savingsCents,
          discountPct: indicative.discountPct,
          icon: art.icon,
          tier: art.tierName,
          tierColor: art.tierColor,
          tierIcon: art.tierIcon,
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
        icon: art.icon,
        tier: art.tierName,
        tierColor: art.tierColor,
        tierIcon: art.tierIcon,
      };
    })
  );

  return Response.json({ ok: true, tier, region, skins: results });
}
