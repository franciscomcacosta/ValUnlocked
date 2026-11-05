import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

// Create or update a product listing (matched on slug).
export async function POST(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;

  const b = (await req.json().catch(() => ({}))) as {
    name?: string; region?: string; rank?: string; description?: string; price_eur?: number | string;
  };
  const price = Math.round(Number(b.price_eur) * 100);
  if (!b.name || !b.region || !Number.isFinite(price) || price <= 0) {
    return Response.json({ error: "name, region and a positive price are required" }, { status: 400 });
  }
  const slug = `${b.region}-${b.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

  const { error } = await db.from("products").upsert(
    { slug, name: b.name, region: b.region.toUpperCase(), rank: b.rank || null, description: b.description || null, price_cents: price },
    { onConflict: "slug" }
  );
  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ ok: true, slug });
}
