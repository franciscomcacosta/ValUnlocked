export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";

export const runtime = "nodejs";

// The signed-in buyer's orders (no credentials – those come from /api/orders/[id]).
export async function GET(req: Request) {
  const userId = await getSessionUserId(req);
  if (!userId) return Response.json({ error: "login_required" }, { status: 401 });
  const { data } = await db
    .from("orders")
    .select("id, status, price_cents, currency, created_at, fulfilled_at, products(name, region, rank)")
    .eq("user_id", userId)
    .not("status", "eq", "cancelled")
    .order("created_at", { ascending: false })
    .limit(50);
  return Response.json(data ?? [], { headers: { "cache-control": "no-store" } });
}
