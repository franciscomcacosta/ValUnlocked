// POST /api/autobuy/matches
// Body: { regions[], kinds[], min_skins, max_price_cents, min_level,
//         min_peak, required_skins[] }
//
// Returns how many accounts currently in stock match the proposed rule,
// so the rule editor can show "Matching right now: 0 / 14" before the
// user saves. Draft-only — not persisted, no side effects.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { rankIndex } from "@/lib/qvsp";
import { xrayPriceForUltra, type SubTier } from "@/lib/pricing";
import { lookupRank } from "@/lib/valorant-assets";

export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  // Ultra-only — same gate as the autobuy CRUD
  const { data: sub } = await db
    .from("subscriptions")
    .select("tier")
    .eq("user_id", session.uid)
    .in("status", ["active", "grace"])
    .maybeSingle();
  if ((sub?.tier as SubTier | undefined) !== "ultra") {
    return Response.json({ error: "ultra_required" }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }

  const regions = Array.isArray(body.regions) ? (body.regions as string[]).map((r) => r.toUpperCase()) : [];
  const kinds = Array.isArray(body.kinds) ? (body.kinds as string[]) : ["skinned"];
  const minSkins = parseInt(String(body.min_skins ?? 0), 10) || 0;
  const maxPriceCents = parseInt(String(body.max_price_cents ?? 0), 10) || 0;
  const minLevel = parseInt(String(body.min_level ?? 0), 10) || 0;
  const minPeak = (body.min_peak as string | undefined)?.trim().toLowerCase() || "";
  const maxPeak = (body.max_peak as string | undefined)?.trim().toLowerCase() || "";
  const minVp = parseInt(String(body.min_vp ?? 0), 10) || 0;
  const requiredSkins = Array.isArray(body.required_skins) ? (body.required_skins as string[]) : [];

  // Base query against available stock. Paginated — autobuy inventory
  // can be tens of thousands of rows.
  type Row = { qvsp_id: string; qvsp_price_cents: number; peak: string; rank_normalized: string | null; level: number; skin_count: number; region: string; kind: string; skins: string[] | null; vp: number | null };
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let q = db
      .from("qvsp_stock")
      .select("qvsp_id, qvsp_price_cents, peak, rank_normalized, level, skin_count, region, kind, skins, vp")
      .is("reserved_order_id", null)
      .is("removed_at", null)
      .eq("claimed", false)
      .lte("public_at", new Date().toISOString())
      .range(offset, offset + PAGE - 1);
    if (kinds.length > 0) q = q.in("kind", kinds);
    if (regions.length > 0) q = q.in("region", regions);
    if (minSkins > 0) q = q.gte("skin_count", minSkins);
    if (minLevel > 0) q = q.gte("level", minLevel);
    if (minVp > 0) q = q.gte("vp", minVp);
    const { data, error } = await q;
    if (error) return Response.json({ error: error.message }, { status: 500 });
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;
  }

  // Filter in-memory for:
  //   - price cap (based on Ultra final price)
  //   - peak-rank floor
  //   - required_skins subset
  const peakFloor = minPeak ? rankIndex(minPeak) : 0;
  const peakCeil = maxPeak ? rankIndex(maxPeak) : Infinity;
  let count = 0;
  const hits: Array<{ row: Row; finalCents: number }> = [];
  for (const r of rows) {
    if (maxPriceCents > 0) {
      const p = xrayPriceForUltra(r.qvsp_price_cents);
      if (p.finalCents > maxPriceCents) continue;
    }
    if (peakFloor > 0 && rankIndex(r.peak ?? "") < peakFloor) continue;
    if (rankIndex(r.peak ?? "") > peakCeil) continue;
    if (requiredSkins.length > 0) {
      const have = new Set((r.skins ?? []).map((s) => s.toLowerCase()));
      let hasAll = true;
      for (const req of requiredSkins) {
        if (!have.has(req.toLowerCase())) { hasAll = false; break; }
      }
      if (!hasAll) continue;
    }
    count++;
    hits.push({ row: r, finalCents: xrayPriceForUltra(r.qvsp_price_cents).finalCents });
  }

  // Total skinned stock (all regions) for the "N / total" readout.
  const { count: total } = await db
    .from("qvsp_stock")
    .select("qvsp_id", { count: "exact", head: true })
    .eq("kind", "skinned")
    .is("reserved_order_id", null)
    .is("removed_at", null)
    .eq("claimed", false)
    .lte("public_at", new Date().toISOString());

  hits.sort((a, b) => a.finalCents - b.finalCents);
  const top = await Promise.all(
    hits.slice(0, 25).map(async ({ row, finalCents }) => {
      const raw = (row.rank_normalized ?? "").trim();
      let art = await lookupRank(raw || "Unranked");
      if (!art.icon && raw) art = await lookupRank(`${raw} 1`);
      return {
        id: row.qvsp_id,
        rank: art.canonicalName ?? (raw || "Unranked"),
        rankIcon: art.icon,
        region: row.region,
        skins: row.skin_count,
        level: row.level,
        finalCents,
      };
    })
  );

  return Response.json({ ok: true, matching: count, scanned: rows.length, total: total ?? rows.length, matches: top });
}
