// GET /api/stock/drops → the most recent restocks that are public, each
// headlined by its best Premium+ skin. Seeds the LIVE ticker; new drops
// then arrive live from the stock watcher's broadcast.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { lookupSkinArt } from "@/lib/valorant-assets";
import { normalizeSkinName, accountSignature } from "@/lib/skin-names";

const RANK: Record<string, number> = { Ultra: 5, Exclusive: 4, Premium: 3 };

export async function GET(req: Request) {
  if (!sessionFromRequest(req)) return Response.json({ error: "auth_required" }, { status: 401 });

  const { data, error } = await db
    .from("qvsp_stock")
    .select("region, level, peak, rank_normalized, vp, skin_count, skins, public_at")
    .eq("kind", "skinned")
    .is("removed_at", null)
    .eq("claimed", false)
    .lte("public_at", new Date().toISOString())
    .order("public_at", { ascending: false })
    .limit(80);
  if (error) return Response.json({ ok: true, drops: [] });

  const seen = new Set<string>();
  const drops: Array<{ region: string; skin: string; tier: string; skins: number; at: string }> = [];
  for (const r of data ?? []) {
    const sig = accountSignature(r);
    if (seen.has(sig)) continue;
    seen.add(sig);
    let best: { skin: string; tier: string; rank: number } | null = null;
    for (const raw of (r.skins as string[] | null) ?? []) {
      const name = normalizeSkinName(raw);
      if (!name) continue;
      const art = await lookupSkinArt(name);
      const rank = RANK[art.tierName ?? ""] ?? 0;
      if (rank && (!best || rank > best.rank)) best = { skin: name, tier: art.tierName!, rank };
    }
    if (best) drops.push({ region: r.region as string, skin: best.skin, tier: best.tier, skins: (r.skin_count as number) ?? 0, at: r.public_at as string });
    if (drops.length >= 12) break;
  }
  return Response.json({ ok: true, drops }, { headers: { "cache-control": "private, max-age=30" } });
}
