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
    let loginHint = "";
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
        try { loginHint = `\n(for login \`${decrypt(inv.login_enc)}\`)`; } catch {}
      }
    }
    if (user?.discord_id) {
      await notifyDiscordUser(
        user.discord_id,
        `✉️ Your recovery **email** is ready:${loginHint}\n\n` +
          `**Email:** \`${body.email}\`\n\n` +
          `Full details: ${process.env.PUBLIC_BASE_URL}/orders/${order.id}`
      ).catch((e) => console.error("[worker-cb] DM failed", e));
    }
    return Response.json({ ok: true });
  }

  // Failure path — staff log AND tell the buyer we're on it, so they
  // don't sit refreshing the order page waiting for the email.
  await logToStaff(
    `⚠️ Email extraction FAILED for order ${order.id} (reason: \`${body.reason ?? "unknown"}\`${
      body.detail ? ` · ${body.detail}` : ""
    }). ` +
      `Run the bookmarklet manually and set the email in the inventory row, or trigger a qvsp replacement. ` +
      `Order: ${process.env.PUBLIC_BASE_URL}/orders/${order.id}`
  ).catch((e) => console.error("[worker-cb] staff log failed", e));

  if (user?.discord_id) {
    await notifyDiscordUser(
      user.discord_id,
      `⚠️ We couldn't auto-pull your recovery email this time. Staff have been pinged and will drop it on your order page shortly.\n` +
        `Your login + password are already live — go ahead and use them. Order: ${process.env.PUBLIC_BASE_URL}/orders/${order.id}`
    ).catch((e) => console.error("[worker-cb] fail DM failed", e));
  }

  return Response.json({ ok: false, reason: body.reason });
}
