// GET /api/stock/brackets[?region=EU]
// Returns one row per (region, skin bracket) telling the UI how many random
// accounts are available in each bucket + the price for the current user's
// tier (if any).
import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { SKIN_BRACKETS, priceForBracket, type SubTier, type BracketName } from "@/lib/pricing";

export const runtime = "nodejs";

type Row = { region: string; skin_count: number };

const REGIONS = ["EU", "AP", "KR", "LATAM", "BR"] as const;

export async function GET(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  const url = new URL(req.url);
  const regionFilter = url.searchParams.get("region")?.toUpperCase();

  // Current tier for pricing.
  const { data: sub } = await db
    .from("subscriptions")
    .select("tier")
    .eq("user_id", session.uid)
    .in("status", ["active", "grace"])
    .maybeSingle();
  const tier = (sub?.tier ?? null) as SubTier | null;

  // Pull available skinned stock, project only what we need for bucketing.
  // Supabase JS can't GROUP BY arbitrary expressions, so we do bucket counts
  // in-process. With ~11k rows and 6 brackets × 5 regions this is trivial.
  let q = db
    .from("qvsp_stock_public")
    .select("region, skin_count")
    .eq("kind", "skinned");
  if (regionFilter) q = q.eq("region", regionFilter);
  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const counts: Record<string, Record<BracketName, number>> = {};
  for (const r of REGIONS) {
    counts[r] = {} as Record<BracketName, number>;
    for (const b of SKIN_BRACKETS) counts[r][b.name] = 0;
  }
  for (const row of (data ?? []) as Row[]) {
    const region = row.region;
    if (!counts[region]) continue;
    const sc = row.skin_count ?? 0;
    for (const b of SKIN_BRACKETS) {
      if (sc >= b.minSkins && sc <= b.maxSkins) {
        counts[region][b.name]++;
        break;
      }
    }
  }

  const out = REGIONS.flatMap((region) =>
    SKIN_BRACKETS.map((b) => ({
      region,
      bracket: b.name,
      label: b.label,
      available: counts[region][b.name],
      price: priceForBracket(b.name, tier),
    }))
  );

  return Response.json({ ok: true, tier, brackets: out });
}
