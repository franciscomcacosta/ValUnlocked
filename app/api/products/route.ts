import { db } from "@/lib/supabase";

export const runtime = "nodejs";

// Public product list with live stock counts (no credentials).
export async function GET() {
  const { data, error } = await db.from("product_stock").select("*").order("price_cents");
  if (error) return Response.json({ error: "unavailable" }, { status: 500 });
  return Response.json(data, { headers: { "cache-control": "s-maxage=30" } });
}
