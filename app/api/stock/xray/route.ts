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
import { rankIndex } from "@/lib/qvsp";
import { skinKey, accountSignature } from "@/lib/skin-names";

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
  const skinSearch = url.searchParams.get("skin")?.trim().toLowerCase() ?? "";
  const sort = url.searchParams.get("sort") ?? "vp_value";
  const dirParam = url.searchParams.get("dir");
  if (region && !REGIONS.has(region)) {
    return Response.json({ error: "invalid_region" }, { status: 400 });
  }

  // Everything is filtered, deduped and sorted in memory: qvsp re-lists the
  // same account under several ids (EU: ~3.5k listings, ~2k accounts), and
  // peak rank needs real rank order, neither of which SQL paging can do.
  type Row = {
    qvsp_id: string; region: string; kind: string; level: number | null; peak: string | null;
    rank_normalized: string | null; qvsp_price_cents: number; skin_count: number | null;
    skins: string[] | null; buddies: string[] | null; vp: number | null;
    vp_value_cents: number | null; last_played: string | null; first_seen_at: string | null;
  };
  const all = await loadRows(region ?? null);

  let rows = all.filter((r) => r.skin_count == null || r.skin_count >= minSkins);
  if (skinSearch) rows = rows.filter((r) => (r.skins ?? []).some((s) => skinKey(s).includes(skinSearch)));

  // One entry per account — the cheapest listing.
  const bySig = new Map<string, Row>();
  for (const r of rows) {
    const sig = accountSignature(r);
    const cur = bySig.get(sig);
    if (!cur || r.qvsp_price_cents < cur.qvsp_price_cents) bySig.set(sig, r);
  }
  let unique = Array.from(bySig.values());
  if (maxPriceCents > 0) unique = unique.filter((r) => xrayPriceForUltra(r.qvsp_price_cents).finalCents <= maxPriceCents);

  // Sorts (each has a natural direction; `dir` flips it).
  const SORTS: Record<string, { key: (r: Row) => number; asc: boolean }> = {
    vp_value:   { key: (r) => r.vp_value_cents ?? -1, asc: false },   // inventory worth, in VP
    cheapest:   { key: (r) => r.qvsp_price_cents,     asc: true },
    most_skins: { key: (r) => r.skin_count ?? 0,      asc: false },
    peak_rank:  { key: (r) => rankIndex(r.peak ?? ""), asc: false },
    vp_balance: { key: (r) => r.vp ?? 0,              asc: false },
  };
  const sc = SORTS[sort] ?? SORTS.vp_value;
  const asc = dirParam === "asc" ? true : dirParam === "desc" ? false : sc.asc;
  unique.sort((a, b) => {
    const d = sc.key(a) - sc.key(b);
    return (asc ? d : -d) || a.qvsp_id.localeCompare(b.qvsp_id);   // stable paging
  });

  const count = unique.length;
  const data = unique.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  // Map rows + attach Ultra-specific pricing. Filter in-memory by maxPrice
  // (based on Ultra final price) since it's derived.
  const items = (await Promise.all(data.map(async (row) => {
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
  })));

  return Response.json({
    ok: true,
    page,
    pageSize: PAGE_SIZE,
    total: count,
    totalPages: Math.ceil(count / PAGE_SIZE),
    items,
  });
}

// Short-lived per-region cache of live X-Ray rows (sync runs every few
// minutes; paging/sorting clicks shouldn't refetch ~3k rows each time).
const ROW_TTL_MS = 30_000;
const rowCache = new Map<string, { at: number; rows: XrayRow[] }>();
type XrayRow = {
  qvsp_id: string; region: string; kind: string; level: number | null; peak: string | null;
  rank_normalized: string | null; qvsp_price_cents: number; skin_count: number | null;
  skins: string[] | null; buddies: string[] | null; vp: number | null;
  vp_value_cents: number | null; last_played: string | null; first_seen_at: string | null;
};

async function loadRows(region: string | null): Promise<XrayRow[]> {
  const key = region ?? "ALL";
  const hit = rowCache.get(key);
  if (hit && Date.now() - hit.at < ROW_TTL_MS) return hit.rows;
  const rows: XrayRow[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let q = db
      .from("qvsp_stock")
      .select("qvsp_id, region, kind, level, peak, rank_normalized, qvsp_price_cents, skin_count, skins, buddies, vp, vp_value_cents, last_played, first_seen_at")
      .eq("kind", "skinned")
      .is("reserved_order_id", null)
      .is("removed_at", null)
      .eq("claimed", false)
      .lte("public_at", new Date().toISOString())
      .order("qvsp_id")
      .range(offset, offset + PAGE - 1);
    if (region) q = q.eq("region", region);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as XrayRow[]));
    if (!data || data.length < PAGE) break;
  }
  rowCache.set(key, { at: Date.now(), rows });
  return rows;
}
