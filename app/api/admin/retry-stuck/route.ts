// GET  /api/admin/retry-stuck → list paid-but-undelivered orders
// POST /api/admin/retry-stuck → retry all of them now (admin only)
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { requireAdmin } from "@/lib/session";
import { db } from "@/lib/supabase";
import { retryStuckOrders } from "@/lib/retry-stuck";

export async function GET(req: Request) {
  const a = requireAdmin(req);
  if (a instanceof Response) return a;
  const { data } = await db
    .from("orders")
    .select("id, paid_at, price_cents, products(name)")
    .eq("status", "paid")
    .is("inventory_id", null)
    .order("created_at", { ascending: true })
    .limit(50);
  return Response.json({ ok: true, stuck: data ?? [] }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const a = requireAdmin(req);
  if (a instanceof Response) return a;
  const results = await retryStuckOrders({ limit: 25 });
  return Response.json({ ok: true, results });
}
