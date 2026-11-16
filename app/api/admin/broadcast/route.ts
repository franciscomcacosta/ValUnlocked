// Admin: DM an announcement to a group of buyers.
//
// POST /api/admin/broadcast
//   { action: "count", audience }                   → { total }
//   { action: "test",  audience, title, body, … }   → sends it to YOU only
//   { action: "send",  audience, title, body, …, offset }
//        → sends to the next batch of up to 25 people starting at `offset`,
//          returns { sent, failed, nextOffset, total }. The admin panel keeps
//          calling until nextOffset is null (keeps each call well under the
//          serverless time limit and Discord's rate limits).
//
// audience: "members" (any active plan) | "standard" | "premium" | "ultra" | "everyone"
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";
import { notifyDiscordUser, logToStaff } from "@/lib/discord";
import { broadcastMessage } from "@/lib/discord-messages";
import { pageAll } from "@/lib/admin";

const BATCH = 25;
const AUDIENCES = ["members", "standard", "premium", "ultra", "everyone"] as const;
type Audience = (typeof AUDIENCES)[number];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Discord ids of everyone in the audience, in a stable order. */
async function recipients(audience: Audience): Promise<string[]> {
  let userIds: string[] | null = null;
  if (audience !== "everyone") {
    let q = db.from("subscriptions").select("user_id, tier").in("status", ["active", "grace"]);
    if (audience !== "members") q = q.eq("tier", audience);
    const { data } = await q;
    userIds = [...new Set((data ?? []).map((s) => s.user_id as string))];
    if (!userIds.length) return [];
  }
  const rows = await pageAll<{ id: string; discord_id: string }>((a, b) => {
    let q = db.from("users").select("id, discord_id").order("id", { ascending: true }).range(a, b);
    if (userIds) q = q.in("id", userIds);
    return q;
  });
  return [...new Set(rows.map((r) => r.discord_id).filter(Boolean))];
}

export async function POST(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const b = (await req.json().catch(() => ({}))) as {
    action?: string; audience?: string; title?: string; body?: string;
    buttonLabel?: string; buttonUrl?: string; imageUrl?: string; offset?: number;
  };
  const audience = (AUDIENCES as readonly string[]).includes(b.audience ?? "") ? (b.audience as Audience) : "members";

  if (b.action === "count") {
    return Response.json({ ok: true, total: (await recipients(audience)).length });
  }

  const title = (b.title ?? "").trim();
  const body = (b.body ?? "").trim();
  if (!title || !body) return Response.json({ error: "Write a title and a message first." }, { status: 400 });
  if (title.length > 256) return Response.json({ error: "Title is too long (max 256)." }, { status: 400 });
  if (body.length > 3500) return Response.json({ error: "Message is too long (max 3500)." }, { status: 400 });
  if (b.buttonUrl && !/^https:\/\//.test(b.buttonUrl)) return Response.json({ error: "Button link must start with https://" }, { status: 400 });
  if (b.imageUrl && !/^https:\/\//.test(b.imageUrl)) return Response.json({ error: "Image link must start with https://" }, { status: 400 });
  const msg = broadcastMessage({ title, body, buttonLabel: b.buttonLabel, buttonUrl: b.buttonUrl, imageUrl: b.imageUrl });

  if (b.action === "test") {
    try {
      await notifyDiscordUser(auth.did, msg);
      return Response.json({ ok: true, message: "Test sent — check your Discord DMs." });
    } catch (e) {
      return Response.json({ error: `Couldn't DM you: ${String(e).slice(0, 120)}. Are DMs from server members on?` }, { status: 502 });
    }
  }

  if (b.action === "send") {
    const all = await recipients(audience);
    const offset = Math.max(0, Math.floor(Number(b.offset) || 0));
    if (offset === 0) {
      await logToStaff(`📣 ${auth.name} started a broadcast to **${all.length}** (${audience}): "${title}"`).catch(() => {});
    }
    let sent = 0;
    let failed = 0;
    for (const did of all.slice(offset, offset + BATCH)) {
      await notifyDiscordUser(did, msg).then(() => sent++, () => failed++);
      await sleep(250);
    }
    const next = offset + BATCH < all.length ? offset + BATCH : null;
    if (next === null) {
      await logToStaff(`📣 Broadcast "${title}" finished.`).catch(() => {});
    }
    return Response.json({ ok: true, sent, failed, nextOffset: next, total: all.length });
  }

  return Response.json({ error: "unknown action" }, { status: 400 });
}
