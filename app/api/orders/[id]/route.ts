export const dynamic = "force-dynamic";
import { db } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";
import { getSessionUserId } from "@/lib/session";

export const runtime = "nodejs";

// Returns order status, plus decrypted credentials once fulfilled.
// Only the buyer who placed the order can see it.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId(req);
  if (!userId) return Response.json({ error: "login_required" }, { status: 401 });

  const { id } = await ctx.params;
  const { data: order } = await db
    .from("orders")
    .select("id, user_id, status, price_cents, currency, created_at, fulfilled_at, inventory_id, products(name, region, rank)")
    .eq("id", id)
    .single();
  if (!order || order.user_id !== userId) return Response.json({ error: "not_found" }, { status: 404 });

  let account = null;
  if (order.status === "fulfilled" && order.inventory_id) {
    const { data: inv } = await db
      .from("inventory")
      .select("login_enc, password_enc, email_enc, email_password_enc")
      .eq("id", order.inventory_id)
      .single();
    if (inv) {
      account = {
        login: decrypt(inv.login_enc),
        password: decrypt(inv.password_enc),
        email: decrypt(inv.email_enc),
        emailPassword: decrypt(inv.email_password_enc),
      };
    }
  }

  const { user_id: _u, inventory_id: _i, ...publicOrder } = order;
  return Response.json({ ...publicOrder, account }, { headers: { "cache-control": "no-store" } });
}
