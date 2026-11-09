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
  const requiredSkins = Array.isArray(body.required_skins) ? (body.required_skins as string[]) : [];

  // Base query against available stock. Paginated — autobuy inventory
  // can be tens of thousands of rows.
  type Row = { qvsp_price_cents: number; peak: string; level: number; skin_count: number; region: string; kind: string; skins: string[] | null };
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let q = db
      .from("qvsp_stock")
      .select("qvsp_price_cents, peak, level, skin_count, region, kind, skins")
      .is("reserved_order_id", null)
      .is("removed_at", null)
      .eq("claimed", false)
      .lte("public_at", new Date().toISOString())
      .range(offset, offset + PAGE - 1);
    if (kinds.length > 0) q = q.in("kind", kinds);
    if (regions.length > 0) q = q.in("region", regions);
    if (minSkins > 0) q = q.gte("skin_count", minSkins);
    if (minLevel > 0) q = q.gte("level", minLevel);
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
  let count = 0;
  for (const r of rows) {
    if (maxPriceCents > 0) {
      const p = xrayPriceForUltra(r.qvsp_price_cents);
      if (p.finalCents > maxPriceCents) continue;
    }
    if (peakFloor > 0 && rankIndex(r.peak ?? "") < peakFloor) continue;
    if (requiredSkins.length > 0) {
      const have = new Set((r.skins ?? []).map((s) => s.toLowerCase()));
      let hasAll = true;
      for (const req of requiredSkins) {
        if (!have.has(req.toLowerCase())) { hasAll = false; break; }
      }
      if (!hasAll) continue;
    }
    count++;
  }

  return Response.json({ ok: true, matching: count, scanned: rows.length });
}
