// POST /api/worker/callback
// Called by the extractor worker after an email-extraction attempt.
// Shape: { order_id, ok, email?, reason? }
//
// Auth: Authorization: Bearer EXTRACTOR_CALLBACK_SECRET (set the same value
// in both this app and the worker).
//
// On success → encrypt + store email on the order's inventory row, notify
// user via Discord DM.
// On failure → log to staff channel for manual handling. The buyer still
// has login + password + email_password; staff just needs to run the
// bookmarklet once and paste the email in.

import { db } from "@/lib/supabase";
import { encrypt, decrypt } from "@/lib/crypto";
import { notifyDiscordUser, logToStaff } from "@/lib/discord";
import { emailReadyMessage, emailDelayedMessage } from "@/lib/discord-messages";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.EXTRACTOR_CALLBACK_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as
    | { order_id?: string; ok?: boolean; email?: string; reason?: string; detail?: string }
    | null;

  if (!body?.order_id) return Response.json({ error: "order_id required" }, { status: 400 });

  // Look up the order + its inventory row + user.
  const { data: order } = await db
    .from("orders")
    .select("id, inventory_id, user_id, users(discord_id)")
    .eq("id", body.order_id)
    .maybeSingle();
  if (!order) return Response.json({ error: "unknown_order" }, { status: 404 });

  const user = order.users as unknown as { discord_id: string } | null;

  // Success path — encrypt and store, then DM the buyer with the email
  // inline plus a reminder of which login it's for.
  if (body.ok && body.email) {
    let login: string | null = null;
    if (order.inventory_id) {
      await db
        .from("inventory")
        .update({ email_enc: encrypt(body.email) })
        .eq("id", order.inventory_id);
      const { data: inv } = await db
        .from("inventory")
        .select("login_enc")
        .eq("id", order.inventory_id)
        .maybeSingle();
      if (inv?.login_enc) {
        try { login = decrypt(inv.login_enc); } catch {}
      }
    }
    if (user?.discord_id) {
      await notifyDiscordUser(
        user.discord_id,
        emailReadyMessage({ orderId: order.id as string, email: body.email, login })
      ).catch((e) => console.error("[worker-cb] DM failed", e));
    }
    return Response.json({ ok: true });
  }

  // Failure path. If the order already has an email (qvsp sent one, or staff
  // added it), there's nothing to do — stay quiet.
  if (order.inventory_id) {
    const { data: inv } = await db.from("inventory").select("email_enc").eq("id", order.inventory_id).maybeSingle();
    let existing = "";
    try { existing = inv?.email_enc ? decrypt(inv.email_enc as string).trim() : ""; } catch {}
    if (existing) return Response.json({ ok: true, note: "email already on file" });
  }

  // Otherwise: short staff ping pointing at the admin queue, and tell the
  // buyer we're on it so they don't sit refreshing the order page.
  const why = body.reason === "captcha_present" ? "Riot showed a captcha" : `reason: ${body.reason ?? "unknown"}`;
  await logToStaff(
    `📧 Email needed for order VU-${(order.id as string).slice(0, 8).toUpperCase()} (${why}). ` +
      `Add it in **Admin → Emails**: ${process.env.PUBLIC_BASE_URL}/?tab=admin`
  ).catch((e) => console.error("[worker-cb] staff log failed", e));

  if (user?.discord_id) {
    await notifyDiscordUser(user.discord_id, emailDelayedMessage({ orderId: order.id as string })).catch((e) =>
      console.error("[worker-cb] fail DM failed", e)
    );
  }

  return Response.json({ ok: false, reason: body.reason });
}
