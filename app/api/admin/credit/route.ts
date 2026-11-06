export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";


// Give a buyer store credit (refunds, goodwill). Positive amounts only;
// credit is spent through checkout, never removed by hand.
export async function POST(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;

  const b = (await req.json().catch(() => ({}))) as { discord_id?: string; amount_eur?: number | string; reason?: string; order_id?: string };
  const cents = Math.round(Number(b.amount_eur) * 100);
  if (!b.discord_id || !Number.isFinite(cents) || cents <= 0) {
    return Response.json({ error: "discord_id and a positive amount are required" }, { status: 400 });
  }

  const { data: user } = await db.from("users").select("id").eq("discord_id", b.discord_id.trim()).single();
  if (!user) return Response.json({ error: "that user hasn't logged in to the shop yet" }, { status: 404 });

  const { error } = await db.rpc("add_credit", {
    p_user_id: user.id,
    p_cents: cents,
    p_reason: b.reason ? `manual: ${b.reason}` : "manual",
    p_order_id: b.order_id || null,
  });
  if (error) return Response.json({ error: error.message }, { status: 400 });

  // Mark the order as refunded-to-credit when one is given
  if (b.order_id) await db.from("orders").update({ status: "refunded_credit" }).eq("id", b.order_id);
  return Response.json({ ok: true });
}
