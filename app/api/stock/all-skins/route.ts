// GET /api/stock/all-skins?region=EU
//
// Returns every named-tier skin currently in stock in the given region.
// "Named-tier" = Select / Deluxe / Premium / Exclusive / Ultra, i.e. skins
// that have a content tier on valorant-api.com. Filters out battlepass,
// default and random-color variants.
//
// For each skin:
//   - how many accounts in that region have it (`available`)
//   - cheapest qvsp cost across those accounts
//   - computed sell + tier-discounted price
//   - art: icon, tier, tierColor, tierIcon
//
// Sorted by content tier rank (Ultra → Select), then alphabetically.
//
// Heavy-ish — pages through qvsp_stock in one query per request and
// aggregates in-process. Cached for 30s on the client to keep the
// server lift down.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { featuredPriceForUser, type SubTier } from "@/lib/pricing";
import { lookupSkinArt, type SkinArt } from "@/lib/valorant-assets";

// Minimum price floor per content tier when we don't have a hand-tuned one.
// Mirrors FEATURED_SKINS' minPriceCents averages so the generated tiles
// land in similar price bands to the curated ones.
const FLOOR_BY_TIER_CENTS: Record<string, number> = {
  Select:    599,
  Deluxe:    799,
  Premium:   1499,
  Exclusive: 1699,
  Ultra:     1799,
};

// Content-tier rank for sorting (higher = shown first).
const TIER_RANK: Record<string, number> = {
  Ultra:     5,
  Exclusive: 4,
  Premium:   3,
  Deluxe:    2,
  Select:    1,
};

// Strip qvsp-style variant suffixes to collapse ("Reaver Vandal",
// "Reaver Vandal (4 Levels)") into one skin. Also filters out qvsp's
// placeholder entries like "invalid_skin" or empty strings which would
// otherwise show up as broken tiles.
function normalizeSkinName(raw: string): string {
  const cleaned = raw
    .replace(/\s*\(\d+\s*Level(?:s)?\)\s*$/i, "")
    .replace(/\s*\(5\s*Levels,\s*5\s*Variants\)\s*$/i, "")
    .trim();
  // qvsp known junk values we never want to surface as a skin tile.
  if (!cleaned || /^invalid_?skin$/i.test(cleaned) || /^unknown$/i.test(cleaned)) {
    return "";
  }
  return cleaned;
}

// Guess the weapon name from the skin's displayName, used for the label
// shown under tier on the tile. Last word usually = weapon class.
const WEAPONS = [
  "Vandal", "Phantom", "Operator", "Sheriff", "Ghost", "Classic",
  "Spectre", "Bulldog", "Stinger", "Judge", "Bucky", "Guardian",
  "Marshal", "Ares", "Odin", "Shorty", "Frenzy", "Melee", "Knife",
  "Outlaw",
];
function weaponFor(name: string): string {
  for (const w of WEAPONS) {
    if (name.endsWith(` ${w}`)) return w;
  }
  const last = name.split(" ").pop() ?? "";
  return last;
}

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

  // Pull all skinned, available rows for the region, paging around the
  // Supabase JS 1000-row default cap.
  type SkinRow = { skins: string[] | null; qvsp_price_cents: number };
  const rows: SkinRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await db
      .from("qvsp_stock")
      .select("skins, qvsp_price_cents")
      .eq("region", region)
      .eq("kind", "skinned")
      .is("reserved_order_id", null)
      .is("removed_at", null)
      .eq("claimed", false)
      .lte("public_at", new Date().toISOString())
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error("[all-skins] supabase error:", error.message);
      return Response.json({ error: "db_error", detail: error.message }, { status: 500 });
    }
    const batch = (data ?? []) as SkinRow[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  // Aggregate: skinName → { count, cheapestCents }
  const agg = new Map<string, { count: number; cheapest: number }>();
  for (const row of rows) {
    const skins = (row.skins ?? []) as string[];
    const price = row.qvsp_price_cents as number;
    if (!Number.isFinite(price)) continue;
    for (const raw of skins) {
      const name = normalizeSkinName(raw);
      if (!name) continue;
      const cur = agg.get(name);
      if (cur) {
        cur.count += 1;
        if (price < cur.cheapest) cur.cheapest = price;
      } else {
        agg.set(name, { count: 1, cheapest: price });
      }
    }
  }

  // Enrich each skin with art and content tier. Skip any that aren't on
  // valorant-api.com's roster (removes battlepass/variant-only entries).
  const artLookups = await Promise.all(
    Array.from(agg.keys()).map(async (name) => ({ name, art: await lookupSkinArt(name) }))
  );

  const results = [];
  for (const { name, art } of artLookups) {
    if (!art.icon || !art.tierName) continue;   // only named-tier skins
    const bucket = agg.get(name)!;
    const floor = FLOOR_BY_TIER_CENTS[art.tierName] ?? 999;
    const p = featuredPriceForUser(bucket.cheapest, floor, tier);
    results.push({
      key: name,
      label: name,
      weapon: weaponFor(name),
      available: bucket.count,
      cheapestQvspCents: bucket.cheapest,
      publicCents: p.publicCents,
      finalCents: p.finalCents,
      savingsCents: p.savingsCents,
      discountPct: p.discountPct,
      icon: art.icon,
      tier: art.tierName,
      tierColor: art.tierColor,
      tierIcon: art.tierIcon,
    });
  }

  // Sort by tier rank desc, then name asc.
  results.sort((a, b) => {
    const ra = TIER_RANK[a.tier ?? ""] ?? 0;
    const rb = TIER_RANK[b.tier ?? ""] ?? 0;
    if (ra !== rb) return rb - ra;
    return a.label.localeCompare(b.label);
  });

  return Response.json({ ok: true, tier, region, skins: results });
}
