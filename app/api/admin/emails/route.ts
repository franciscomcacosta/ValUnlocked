// Admin: recovery emails the worker couldn't fetch (usually Riot's captcha).
//
// GET  /api/admin/emails                 → orders still missing an email
// POST /api/admin/emails { orderId, email } → save it + DM the buyer
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";
import { encrypt, decrypt } from "@/lib/crypto";
import { notifyDiscordUser, logToStaff } from "@/lib/discord";
import { emailReadyMessage } from "@/lib/discord-messages";
import { ordersMissingEmail } from "@/lib/admin";

export async function GET(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const orders = await ordersMissingEmail();
  return Response.json({ ok: true, orders }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const b = (await req.json().catch(() => ({}))) as { orderId?: string; email?: string };
  const email = (b.email ?? "").trim();
  if (!b.orderId) return Response.json({ error: "orderId required" }, { status: 400 });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    return Response.json({ error: "That doesn't look like an email address." }, { status: 400 });
  }

  const { data: order } = await db
    .from("orders")
    .select("id, inventory_id, users(discord_id)")
    .eq("id", b.orderId)
    .maybeSingle();
  if (!order?.inventory_id) return Response.json({ error: "Order has no delivered account." }, { status: 404 });

  const { data: inv, error } = await db
    .from("inventory")
    .update({ email_enc: encrypt(email) })
    .eq("id", order.inventory_id)
    .select("login_enc")
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });

  let login: string | null = null;
  try { login = inv?.login_enc ? decrypt(inv.login_enc as string) : null; } catch {}
  const did = (order.users as unknown as { discord_id?: string } | null)?.discord_id;
  if (did) {
    await notifyDiscordUser(did, emailReadyMessage({ orderId: order.id as string, email, login })).catch(() => {});
  }
  await logToStaff(`✉️ ${auth.name} added the recovery email for VU-${(order.id as string).slice(0, 8).toUpperCase()}.`).catch(() => {});
  return Response.json({ ok: true, message: did ? "Saved — the buyer got it in a DM." : "Saved." });
}
