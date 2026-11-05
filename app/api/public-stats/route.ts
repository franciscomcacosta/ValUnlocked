// GET /api/public-stats
// Public (no auth). Returns the visible stock count + lowest public price
// so the landing page can show "1,347 accounts in stock · from €2.99"
// without exposing credentials or anything per-user.
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const revalidate = 60; // cache for a minute

export async function GET() {
  const { count } = await db
    .from("qvsp_stock_public")
    .select("qvsp_id", { count: "exact", head: true });

  const { data: cheapest } = await db
    .from("qvsp_stock_public")
    .select("public_price_cents")
    .order("public_price_cents", { ascending: true })
    .limit(1)
    .maybeSingle();

  return Response.json(
    {
      stockCount: count ?? 0,
      startingPriceCents: cheapest?.public_price_cents ?? null,
    },
    { headers: { "cache-control": "public, s-maxage=60, stale-while-revalidate=120" } }
  );
}
