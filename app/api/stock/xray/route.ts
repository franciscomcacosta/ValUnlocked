// GET /api/stock/xray?region=EU&page=1&minSkins=50&skin=Reaver%20Vandal
// Ultra-only recon endpoint. Returns full account metadata (region, rank,
// peak, level, VP, skin list, buddies, last played) so the buyer knows
// EXACTLY what they're getting before committing.
//
// Never returns qvsp_id to the client — we send a synthetic `account_id`
// (hashed) that maps back to the real qvsp_id server-side so the X-RAY
// path can't be scraped by non-subscribers trying to replay URLs.
//
// Actually, simpler: we DO send qvsp_id because the buy endpoint needs it
// and the ultra-only middleware/gate makes it safe. Revisit if abuse happens.
import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { xrayPriceForUltra, type SubTier } from "@/lib/pricing";
import { lookupRank, type RankArt } from "@/lib/valorant-assets";

// qvsp ranks come as "platinum 2", "PLATINUM" (no division) or "unranked".
// valorant-api keys by "PLATINUM 2"; fall back to division 1 for bare tiers.
async function rankArt(raw: string | null): Promise<RankArt> {
  const name = (raw ?? "").trim();
  if (!name || /^(n\/a|unranked)$/i.test(name)) return lookupRank("Unranked");
  const hit = await lookupRank(name);
  if (hit.icon) return hit;
  return lookupRank(`${name} 1`);
}

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PAGE_SIZE = 50;
const REGIONS = new Set(["EU", "NA", "AP", "KR", "LATAM", "BR"]);

export async function GET(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  // Ultra-only gate.
  const { data: sub } = await db
    .from("subscriptions")
    .select("tier")
    .eq("user_id", session.uid)
    .in("status", ["active", "grace"])
    .maybeSingle();
  const tier = (sub?.tier ?? null) as SubTier | null;
  if (tier !== "ultra") {
    return Response.json(
      { error: "ultra_required", currentTier: tier },
      { status: 403 }
    );
  }

  const url = new URL(req.url);
  const region = url.searchParams.get("region")?.toUpperCase();
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const minSkins = parseInt(url.searchParams.get("minSkins") ?? "0", 10) || 0;
  const maxPriceCents = parseInt(url.searchParams.get("maxPriceCents") ?? "0", 10) || 0;
  const skinSearch = url.searchParams.get("skin")?.trim() ?? "";
  const sort = url.searchParams.get("sort") ?? "newest";
  const dirParam = url.searchParams.get("dir");
  if (region && !REGIONS.has(region)) {
    return Response.json({ error: "invalid_region" }, { status: 400 });
  }

  // Build query against the base table (service role; cost column needed).
  let q = db
    .from("qvsp_stock")
    .select(
      "qvsp_id, region, kind, level, peak, rank_normalized, qvsp_price_cents, skin_count, skins, buddies, vp, vp_value_cents, last_played, first_seen_at",
      { count: "exact" }
    )
    .eq("kind", "skinned")
    .is("reserved_order_id", null)
    .is("removed_at", null)
    .eq("claimed", false)
    .lte("public_at", new Date().toISOString());

  if (region) q = q.eq("region", region);
  if (minSkins > 0) q = q.gte("skin_count", minSkins);
  if (skinSearch) q = q.overlaps("skins", [skinSearch]);

  // Sorting. Each sort has a natural default direction; `dir` flips it
  // (the UI toggles on a second click, like the designer's ▲/▼).
  const SORT_COL: Record<string, { col: string; asc: boolean }> = {
    newest:       { col: "first_seen_at",    asc: false },
    cheapest:     { col: "qvsp_price_cents", asc: true },
    most_skins:   { col: "skin_count",       asc: false },
    highest_peak: { col: "peak",             asc: false },
    highest_vp:   { col: "vp",               asc: false },
  };
  const sc = SORT_COL[sort] ?? SORT_COL.newest;
  const asc = dirParam === "asc" ? true : dirParam === "desc" ? false : sc.asc;
  q = q.order(sc.col, { ascending: asc, nullsFirst: false });

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;
  const { data, error, count } = await q.range(from, to);
  if (error) return Response.json({ error: error.message }, { status: 500 });

  // Map rows + attach Ultra-specific pricing. Filter in-memory by maxPrice
  // (based on Ultra final price) since it's derived.
  const items = (await Promise.all((data ?? []).map(async (row) => {
    const pricing = xrayPriceForUltra(row.qvsp_price_cents);
    const [rk, pk] = await Promise.all([rankArt(row.rank_normalized), rankArt(row.peak)]);
    return {
      rankIcon: rk.icon,
      rankColor: rk.color,
      rankName: rk.canonicalName,
      peakIcon: pk.icon,
      peakColor: pk.color,
      peakName: pk.canonicalName,
      account_id: row.qvsp_id,
      region: row.region,
      level: row.level,
      peak: row.peak,
      rank: row.rank_normalized,
      skin_count: row.skin_count,
      skins: row.skins,
      buddies: row.buddies,
      vp: row.vp,
      vp_value_cents: row.vp_value_cents,
      last_played: row.last_played,
      first_seen_at: row.first_seen_at,
      publicCents: pricing.publicCents,
      finalCents: pricing.finalCents,
      savingsCents: pricing.savingsCents,
      discountPct: pricing.discountPct,
    };
  }))).filter((it) => (maxPriceCents > 0 ? it.finalCents <= maxPriceCents : true));

  return Response.json({
    ok: true,
    page,
    pageSize: PAGE_SIZE,
    total: count ?? 0,
    totalPages: Math.ceil((count ?? 0) / PAGE_SIZE),
    items,
  });
}
