// GET /api/stock/brackets[?region=EU]
// Returns one row per (region, skin bracket) telling the UI how many random
// accounts are available in each bucket + the price for the current user's
// tier (if any).
import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { SKIN_BRACKETS, priceForBracket, type SubTier, type BracketName } from "@/lib/pricing";

export const runtime = "nodejs";

type Row = { region: string; skin_count: number; qvsp_price_cents: number };

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

  // Pull available skinned stock. Supabase JS caps SELECT at 1000 rows by
  // default, so we page through in batches of 1000 until we've got the full
  // set. ~12k rows = ~12 round trips, each small. Keeps server-side logic
  // simple and avoids a DB view we'd have to keep in sync with the schema.
  const rows: Row[] = [];
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    let q = db
      .from("qvsp_stock")
      .select("region, skin_count, qvsp_price_cents")
      .eq("kind", "skinned")
      .is("reserved_order_id", null)
      .is("removed_at", null)
      .eq("claimed", false)
      .lte("public_at", new Date().toISOString())
      .range(offset, offset + PAGE - 1);
    if (regionFilter) q = q.eq("region", regionFilter);
    const { data, error } = await q;
    if (error) return Response.json({ error: error.message }, { status: 500 });
    const batch = (data ?? []) as Row[];
    rows.push(...batch);
    if (batch.length < PAGE) break;    // short batch = last page
  }

  const counts: Record<string, Record<BracketName, number>> = {};
  for (const r of REGIONS) {
    counts[r] = {} as Record<BracketName, number>;
    for (const b of SKIN_BRACKETS) counts[r][b.name] = 0;
  }
  for (const row of rows) {
    const region = row.region;
    if (!counts[region]) continue;
    const sc = row.skin_count ?? 0;
    for (const b of SKIN_BRACKETS) {
      if (sc >= b.minSkins && sc <= b.maxSkins) {
        // Count every account in this bucket. The cost-ceiling filter used
        // to run here, dropping any row whose qvsp cost exceeded the
        // bracket's margin headroom — but that silently hid stock from
        // users and was visually confusing (1 available when qvsp says
        // 400). The reservation function in reserve_qvsp_stock() still
        // enforces the ceiling at purchase time, so we never actually sell
        // an unprofitable account; the UI just stops lying about supply.
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
