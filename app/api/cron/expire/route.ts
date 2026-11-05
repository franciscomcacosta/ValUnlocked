import { db } from "@/lib/supabase";

export const runtime = "nodejs";

// Hourly job (Vercel Cron, see vercel.json): releases stock held by unpaid
// orders and returns any credit they used.
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const { data, error } = await db.rpc("expire_stale_orders", { p_older_than: "3 hours" });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ expired: data });
}
