// POST /api/webhooks/qvsp?token=<QVSP_WEBHOOK_TOKEN>
// qvsp events: order.*, replacement.approved|denied|closed, payout.sent,
// webhook.test. We never act on the payload itself: for replacement
// events we look up the ticket and re-read its real state from qvsp.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { timingSafeEqual } from "crypto";
import { db } from "@/lib/supabase";
import { ticketIdFrom } from "@/lib/qvsp-replace";
import { syncClaim } from "@/lib/claims";
import { logToStaff } from "@/lib/discord";

function tokenOk(given: string | null): boolean {
  const want = process.env.QVSP_WEBHOOK_TOKEN;
  if (!want || !given) return false;
  const a = Buffer.from(want);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(req: Request) {
  if (!tokenOk(new URL(req.url).searchParams.get("token"))) {
    return new Response("unauthorized", { status: 401 });
  }
  const raw = await req.text();
  let payload: Record<string, unknown> = {};
  try { payload = JSON.parse(raw); } catch { /* keep empty */ }
  const event = String(payload.event ?? payload.type ?? payload.name ?? "");

  if (event === "webhook.test") return Response.json({ ok: true });

  if (event.startsWith("replacement.")) {
    const ticketId = ticketIdFrom(payload) ?? ticketIdFrom(payload.data);
    if (!ticketId) {
      await logToStaff(`⚠️ qvsp ${event} webhook without a ticket id: ${raw.slice(0, 300)}`);
      return Response.json({ ok: true });
    }
    const { data: claim } = await db
      .from("replacement_claims")
      .select("id")
      .eq("qvsp_ticket_id", ticketId)
      .maybeSingle();
    if (!claim) {
      await logToStaff(`ℹ️ qvsp ${event} for ticket ${ticketId} — no matching claim here.`);
      return Response.json({ ok: true });
    }
    const result = await syncClaim(claim.id as string);
    return Response.json({ ok: true, result });
  }

  if (event === "order.paid_late" || event === "order.expired") {
    await logToStaff(`ℹ️ qvsp ${event}: ${raw.slice(0, 300)}`);
  }
  return Response.json({ ok: true });
}
