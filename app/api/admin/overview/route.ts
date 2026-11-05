import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;

  const [{ data: orders }, { data: stock }, { data: sold }] = await Promise.all([
    db
      .from("orders")
      .select("id, status, price_cents, charge_cents, currency, created_at, users(discord_username, discord_id), products(name)")
      .not("status", "eq", "cancelled")
      .order("created_at", { ascending: false })
      .limit(50),
    db.from("product_stock").select("id, slug, name, region, rank, price_cents, currency, in_stock").order("name"),
    db.from("orders").select("price_cents").eq("status", "fulfilled"),
  ]);

  const revenueCents = (sold ?? []).reduce((sum, o) => sum + o.price_cents, 0);
  const attention = (orders ?? []).filter((o) => o.status === "partially_paid" || o.status === "paid").length;

  return Response.json(
    {
      stats: {
        revenueCents,
        ordersFulfilled: sold?.length ?? 0,
        inStock: (stock ?? []).reduce((n, p) => n + Number(p.in_stock), 0),
        needsAttention: attention,
      },
      products: stock ?? [],
      orders: orders ?? [],
    },
    { headers: { "cache-control": "no-store" } }
  );
}
