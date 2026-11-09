// Replacement / refund claims — shared by the claims API, the qvsp webhook
// and the claims cron.
//
// Rules (product decisions):
//   • Buyers can report within 10 minutes of delivery, with a video.
//   • The claim is forwarded to qvsp as a replacement ticket + video proof.
//   • If qvsp provides a replacement account, the buyer gets THAT account.
//   • If qvsp approves without a replacement, the buyer is refunded to
//     credit what THEY paid (orders.price_cents, not our qvsp cost) plus a
//     5% apology bonus.
//   • Denied → no credit; the buyer is told and can open a Discord ticket.
import { db } from "./supabase";
import { encrypt } from "./crypto";
import { notifyDiscordUser, logToStaff } from "./discord";
import { getOrders } from "./qvsp";
import { openTicket, uploadVideo, attachProof, sayOnTicket, getTicket, type TicketView } from "./qvsp-replace";

export const CLAIM_WINDOW_MS = 10 * 60 * 1000;
export const CLAIM_SUBMIT_GRACE_MS = 10 * 60 * 1000;   // upload may finish after the window
export const CLAIM_BONUS_PCT = 0.05;
export const VIDEO_BUCKET = "claim-videos";
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
// Approved but no replacement attached yet: wait this long for qvsp to add
// one before refunding instead.
const REPLACEMENT_WAIT_MS = 10 * 60 * 1000;

export const CLAIM_REASONS: Record<string, string> = {
  login: "Can't log in",
  count: "Wrong skin count",
  locked: "Locked or banned",
  other: "Something else",
};

export type ClaimRow = {
  id: string;
  order_id: string;
  user_id: string;
  reason: string;
  details: string | null;
  video_path: string | null;
  status: string;
  qvsp_ticket_id: string | null;
  qvsp_status: string | null;
  qvsp_last: Record<string, unknown> | null;
  refund_cents: number;
  bonus_cents: number;
  created_at: string;
};

const euro = (c: number) => `€${(c / 100).toFixed(2)}`;
const base = () => process.env.PUBLIC_BASE_URL ?? "https://valunlock.online";

export async function ensureVideoBucket(): Promise<void> {
  const { data } = await db.storage.getBucket(VIDEO_BUCKET);
  if (!data) await db.storage.createBucket(VIDEO_BUCKET, { public: false });
}

/** qvsp's own order id for one of our orders (saved, or looked up once). */
export async function resolveQvspOrderId(orderId: string): Promise<string | null> {
  const { data: o } = await db.from("orders").select("qvsp_order_id").eq("id", orderId).maybeSingle();
  if (o?.qvsp_order_id) return o.qvsp_order_id as string;
  const { data: stock } = await db
    .from("qvsp_stock")
    .select("qvsp_id")
    .or(`claimed_order_id.eq.${orderId},reserved_order_id.eq.${orderId}`)
    .maybeSingle();
  if (!stock) return null;
  try {
    const match = (await getOrders()).find((q) => q.stock_id === stock.qvsp_id || q.id === stock.qvsp_id);
    if (match) {
      await db.from("orders").update({ qvsp_order_id: match.id }).eq("id", orderId);
      return match.id;
    }
  } catch (e) {
    console.error("[claims] qvsp order lookup failed", e);
  }
  return null;
}

async function userDiscordId(userId: string): Promise<string | null> {
  const { data } = await db.from("users").select("discord_id").eq("id", userId).maybeSingle();
  return (data?.discord_id as string | undefined) ?? null;
}

async function dm(userId: string, text: string) {
  const did = await userDiscordId(userId);
  if (did) await notifyDiscordUser(did, text).catch((e) => console.error("[claims] DM failed", e));
}

/** Open the qvsp ticket and attach the video. Records any failure on the
 *  claim and pings staff so a human can finish it by hand. */
export async function forwardClaimToQvsp(claimId: string): Promise<void> {
  const { data: claim } = await db.from("replacement_claims").select("*").eq("id", claimId).single();
  if (!claim || claim.qvsp_ticket_id) return;
  const c = claim as ClaimRow;
  const reasonLabel = CLAIM_REASONS[c.reason] ?? c.reason;
  const videoUrl = c.video_path
    ? (await db.storage.from(VIDEO_BUCKET).createSignedUrl(c.video_path, 60 * 60 * 24 * 7)).data?.signedUrl ?? null
    : null;

  const fail = async (step: string, detail: unknown) => {
    const msg = `${step}: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`;
    await db.from("replacement_claims").update({ forward_error: msg }).eq("id", claimId);
    await logToStaff(
      `🧾 Claim ${claimId} (order ${c.order_id}) — couldn't forward to qvsp (${msg}).\n` +
        `Reason: ${reasonLabel}${c.details ? ` — "${c.details}"` : ""}\n` +
        (videoUrl ? `Video (7 days): ${videoUrl}` : "No video")
    );
  };

  const qvspOrderId = await resolveQvspOrderId(c.order_id);
  if (!qvspOrderId) return fail("lookup", "no qvsp order id for this order");

  const message = `${reasonLabel}${c.details ? ` — ${c.details}` : ""}. Buyer screen recording attached.`;
  const opened = await openTicket({ qvspOrderId, reason: c.reason, message });
  if (!opened.ok || !opened.ticketId) return fail("open ticket", opened.body);

  await db
    .from("replacement_claims")
    .update({ qvsp_ticket_id: opened.ticketId, status: "under_review", qvsp_status: "open" })
    .eq("id", claimId);

  if (c.video_path) {
    const { data: file } = await db.storage.from(VIDEO_BUCKET).download(c.video_path);
    let proofRef: string | null = null;
    if (file) {
      const up = await uploadVideo({ ticketId: opened.ticketId, file, filename: c.video_path.split("/").pop() ?? "proof.mp4" });
      if (up.ok) proofRef = up.proofRef;
      else await fail("upload video", up.body);
    }
    const att = await attachProof({ ticketId: opened.ticketId, proofRef, videoUrl });
    if (!att.ok) {
      // Fall back to posting the link as a message so qvsp still sees it.
      const said = videoUrl ? await sayOnTicket(opened.ticketId, `Video proof: ${videoUrl}`) : { ok: false, body: "no url" };
      if (!said.ok) await fail("attach proof", att.body);
    }
  }
  await logToStaff(`🧾 Claim ${claimId} sent to qvsp as ticket ${opened.ticketId} (${reasonLabel}).`);
}

async function deliverReplacement(c: ClaimRow, t: TicketView): Promise<boolean> {
  const creds = t.credentials!;
  const { data: order } = await db.from("orders").select("product_id").eq("id", c.order_id).single();
  if (!order) return false;
  const { data: inv, error } = await db
    .from("inventory")
    .insert({
      product_id: order.product_id,
      source: "qvsp",
      acquired_from: `qvsp:replacement:${t.id}`,
      cost_cents: null,
      login_enc: encrypt(creds.login),
      password_enc: encrypt(creds.password),
      email_enc: encrypt(creds.email ?? ""),
      email_password_enc: encrypt(creds.email_password ?? ""),
      notes: `Replacement for claim ${c.id}`,
      status: "sold",
    })
    .select("id")
    .single();
  if (error || !inv) {
    console.error("[claims] replacement inventory insert failed", error);
    return false;
  }
  const { data: ok } = await db.rpc("apply_claim_replacement", {
    p_claim: c.id,
    p_inventory: inv.id,
    p_note: "qvsp provided a replacement account",
  });
  if (!ok) return false;
  await dm(
    c.user_id,
    `✅ Your replacement account is ready. We've swapped it into your order.\n` +
      `View the new credentials: ${base()}/orders/${c.order_id}\n` +
      `Change the account and email passwords on first login.`
  );
  await logToStaff(`🔁 Claim ${c.id}: replacement delivered (ticket ${t.id}).`);
  return true;
}

async function refundClaim(c: ClaimRow, note: string): Promise<boolean> {
  const { data: credited } = await db.rpc("apply_claim_refund", { p_claim: c.id, p_note: note });
  if (!credited) return false;
  await dm(
    c.user_id,
    `💛 Sorry about that order. We've refunded **${euro(c.refund_cents)}** to your Val Unlocked credit, ` +
      `plus a **${euro(c.bonus_cents)} apology bonus** — **${euro(c.refund_cents + c.bonus_cents)}** in total.\n` +
      `It's ready to spend now: ${base()}`
  );
  await logToStaff(`💸 Claim ${c.id}: refunded ${euro(c.refund_cents)} + ${euro(c.bonus_cents)} bonus to credit.`);
  return true;
}

/** Re-read a claim's ticket from qvsp and apply the outcome. Idempotent. */
export async function syncClaim(claimId: string): Promise<string> {
  const { data } = await db.from("replacement_claims").select("*").eq("id", claimId).single();
  const c = data as ClaimRow | null;
  if (!c || !c.qvsp_ticket_id || !["submitted", "under_review"].includes(c.status)) return "skip";

  const t = await getTicket(c.qvsp_ticket_id);
  if (!t) return "unreachable";

  const prev = c.qvsp_last ?? {};
  const approvedSeenAt =
    (prev.approvedSeenAt as string | undefined) ?? (t.state === "approved" ? new Date().toISOString() : undefined);
  await db
    .from("replacement_claims")
    .update({ qvsp_status: t.rawStatus, qvsp_last: { ticket: t.raw, approvedSeenAt } })
    .eq("id", c.id);

  if (t.credentials) {
    return (await deliverReplacement(c, t)) ? "replaced" : "replace_failed";
  }
  if (t.state === "approved") {
    // qvsp may still be preparing a replacement — give it time before refunding.
    if (t.replacementOrderId) return "waiting_replacement";
    const waited = Date.now() - new Date(approvedSeenAt!).getTime();
    if (waited < REPLACEMENT_WAIT_MS) return "waiting_replacement";
    return (await refundClaim(c, t.note ?? "Approved by qvsp without a replacement")) ? "refunded" : "noop";
  }
  if (t.state === "denied" || t.state === "closed") {
    const wasApproved = !!prev.approvedSeenAt;
    if (wasApproved) {
      return (await refundClaim(c, t.note ?? "Approved by qvsp")) ? "refunded" : "noop";
    }
    const { data: upd } = await db
      .from("replacement_claims")
      .update({ status: "denied", resolved_at: new Date().toISOString(), outcome_note: t.note })
      .eq("id", c.id)
      .in("status", ["submitted", "under_review"])
      .select("id");
    if (upd?.length) {
      await dm(
        c.user_id,
        `Your report for order ${c.order_id.slice(0, 8).toUpperCase()} was reviewed and not approved` +
          `${t.note ? `: ${t.note}` : "."} If you think that's wrong, open a ticket in our Discord.`
      );
      await logToStaff(`⛔ Claim ${c.id}: denied by qvsp (ticket ${t.id}).`);
    }
    return "denied";
  }
  return "open";
}

/** Sync every open claim (cron fallback for missed webhooks). */
export async function syncOpenClaims(): Promise<Record<string, number>> {
  const { data } = await db
    .from("replacement_claims")
    .select("id")
    .in("status", ["submitted", "under_review"])
    .not("qvsp_ticket_id", "is", null)
    .limit(100);
  const tally: Record<string, number> = {};
  for (const row of data ?? []) {
    const r = await syncClaim(row.id as string);
    tally[r] = (tally[r] ?? 0) + 1;
  }
  return tally;
}
