export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { db } from "@/lib/supabase";
import { encrypt } from "@/lib/crypto";
import { requireAdmin } from "@/lib/session";

export const runtime = "nodejs";

// Add one full-access account to stock. Credentials are encrypted before insert.
export async function POST(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;

  const b = (await req.json().catch(() => ({}))) as Record<string, string | undefined>;
  for (const f of ["product_slug", "source", "login", "password", "email", "email_password"]) {
    if (!b[f]) return Response.json({ error: `${f} is required` }, { status: 400 });
  }
  if (b.source !== "own" && b.source !== "bought") {
    return Response.json({ error: "source must be own or bought" }, { status: 400 });
  }
  if (b.source === "bought" && !b.acquired_from) {
    return Response.json({ error: "bought accounts need the original owner in acquired_from" }, { status: 400 });
  }

  const { data: product } = await db.from("products").select("id").eq("slug", b.product_slug!).single();
  if (!product) return Response.json({ error: "unknown product" }, { status: 400 });

  const { error } = await db.from("inventory").insert({
    product_id: product.id,
    source: b.source,
    acquired_from: b.acquired_from || null,
    cost_cents: b.cost_eur ? Math.round(parseFloat(b.cost_eur) * 100) : null,
    login_enc: encrypt(b.login!),
    password_enc: encrypt(b.password!),
    email_enc: encrypt(b.email!),
    email_password_enc: encrypt(b.email_password!),
    notes: b.notes || null,
  });
  if (error) return Response.json({ error: error.message }, { status: 400 });
  return Response.json({ ok: true });
}
