// Replacement / refund claims — shared by the claims API, the qvsp webhook
// and the claims cron.
//
// Rules (product decisions):
//   • Buyers can report within 10 minutes of delivery, with a video.
//   • The claim is forwarded to qvsp as a replacement ticket + video proof.
//   • If qvsp provides a replacement account, the buyer gets THAT account.
//   • If qvsp approves without a replacement, the buyer is refunded to
//     credit what THEY paid (credit + crypto, not our qvsp cost) plus a
//     5% apology bonus.
//   • Denied → no credit; the buyer is told and can open a Discord ticket.
import { db } from "./supabase";
import { encrypt, decrypt } from "./crypto";
import { notifyDiscordUser, logToStaff } from "./discord";
import { getOrders } from "./qvsp";
import { openTicket, uploadProof, getTicket, qvspCategory, type TicketView } from "./qvsp-replace";

export const CLAIM_WINDOW_MS = 10 * 60 * 1000;
export const CLAIM_SUBMIT_GRACE_MS = 10 * 60 * 1000;   // upload may finish after the window
export const CLAIM_BONUS_PCT = 0.05;
export const VIDEO_BUCKET = "claim-videos";
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
// Approved but no replacement attached yet: wait this long for qvsp to add
// one before refunding instead.
const REPLACEMENT_WAIT_MS = 10 * 60 * 1000;

// Same six categories qvsp accepts, so every report reaches them with the
// right problem type. Keys ARE qvsp's category values.
export const CLAIM_REASONS: Record<string, string> = {
  banned: "Account is banned / suspended",
  ingame_ban: "In-game ban / restriction (logs in, but can't play Comp)",
  login: "Login / password doesn't work",
  login_mfa: "Can't log in: it wants an email / MFA code I can't get",
  mfa: "Logs in fine: Ranked/Comp needs verification (phone / MFA)",
  other: "Other",
};
/** Labels for reports filed before the categories matched qvsp's. */
export const LEGACY_CLAIM_REASONS: Record<string, string> = { count: "Wrong skin count", locked: "Locked or banned" };

export type ClaimRow = {
  id: string;
  order_id: string;
  user_id: string;
  forward_error?: string | null;
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
  const reasonLabel = CLAIM_REASONS[c.reason] ?? LEGACY_CLAIM_REASONS[c.reason] ?? c.reason;
  const videoUrl = c.video_path
    ? (await db.storage.from(VIDEO_BUCKET).createSignedUrl(c.video_path, 60 * 60 * 24 * 7)).data?.signedUrl ?? null
    : null;

  const fail = async (step: string, detail: unknown) => {
    const msg = `${step}: ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`;
    await db.from("replacement_claims").update({ forward_error: msg }).eq("id", claimId);
    if (c.forward_error === msg) return; // same failure as last try — don't spam staff
    await logToStaff(
      `🧾 Claim ${claimId} (order ${c.order_id}) — couldn't forward to qvsp (${msg}).\n` +
        `Reason: ${reasonLabel}${c.details ? ` — "${c.details}"` : ""}\n` +
        (videoUrl ? `Video (7 days): ${videoUrl}` : "No video")
    );
  };

  const qvspOrderId = await resolveQvspOrderId(c.order_id);
  if (!qvspOrderId) return fail("lookup", "no qvsp order id for this order");

  // The login of the delivered account (qvsp's ticket form requires it).
  const { data: ord } = await db.from("orders").select("inventory_id").eq("id", c.order_id).single();
  const { data: inv } = ord?.inventory_id
    ? await db.from("inventory").select("login_enc").eq("id", ord.inventory_id).single()
    : { data: null };
  let accountUsername: string | null = null;
  try { accountUsername = inv?.login_enc ? decrypt(inv.login_enc as string) : null; } catch { accountUsername = null; }
  if (!accountUsername) return fail("lookup", "couldn't read the account login for this order");

  // 1) Upload the buyer's video → proof_token (qvsp requires this first).
  if (!c.video_path) return fail("video", "this claim has no video");
  const { data: file } = await db.storage.from(VIDEO_BUCKET).download(c.video_path);
  if (!file) return fail("video", "couldn't read the uploaded video from storage");
  const proof = await uploadProof({
    file,
    filename: c.video_path.split("/").pop() ?? "proof.mp4",
    qvspOrderId,
    accountUsername,
    category: qvspCategory(c.reason, c.details),
  });
  if (!proof.ok || !proof.proofToken) return fail("upload video", proof.body);

  // 2) Open the ticket with that token.
  const message = `${reasonLabel}${c.details ? ` — ${c.details}` : ""}. Buyer screen recording attached.`;
  const opened = await openTicket({ qvspOrderId, reason: c.reason, message, accountUsername, details: c.details, proofToken: proof.proofToken });
  if (!opened.ok || !opened.ticketId) return fail("open ticket", opened.body);

  await db
    .from("replacement_claims")
    .update({ qvsp_ticket_id: opened.ticketId, status: "under_review", qvsp_status: "open" })
    .eq("id", claimId);

  await db.from("replacement_claims").update({ forward_error: null }).eq("id", claimId);
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

/** Free-gift orders (nothing paid): instead of a €0.00 refund, give the
 *  free account back — marking the order refunded re-opens the gift, so the
 *  buyer just claims a fresh one on the dashboard. */
async function reissueGift(c: ClaimRow, note: string): Promise<boolean> {
  const { data: upd } = await db
    .from("replacement_claims")
    .update({ status: "reissued", resolved_at: new Date().toISOString(), outcome_note: note })
    .eq("id", c.id)
    .in("status", ["submitted", "under_review"])
    .select("id");
  if (!upd?.length) return false;
  await db.from("orders").update({ status: "refunded_credit" }).eq("id", c.order_id);
  await dm(
    c.user_id,
    `💛 Sorry that free account didn't work. **You get a brand-new free account instead** — ` +
      `pick your region and claim it here: ${base()}/?claim=gift`
  );
  await logToStaff(`🎁 Claim ${c.id}: free gift account re-issued (order ${c.order_id}).`);
  return true;
}

async function isGiftOrder(orderId: string): Promise<boolean> {
  const { data } = await db.from("orders").select("credit_used_cents, charge_cents, products(slug)").eq("id", orderId).single();
  const slug = (data?.products as unknown as { slug?: string } | null)?.slug ?? "";
  const paid = ((data?.credit_used_cents as number) ?? 0) + ((data?.charge_cents as number) ?? 0);
  return paid === 0 && /^qvsp-(welcome|gift)-/.test(slug);
}

async function refundClaim(c: ClaimRow, note: string): Promise<boolean> {
  if (c.refund_cents === 0 && (await isGiftOrder(c.order_id))) return reissueGift(c, note);
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
  // Claims that never reached qvsp (forwarding failed) — try again for 24h.
  const { data: unsent } = await db
    .from("replacement_claims")
    .select("id")
    .eq("status", "submitted")
    .is("qvsp_ticket_id", null)
    .not("forward_error", "is", null)
    .gte("created_at", new Date(Date.now() - 24 * 3_600_000).toISOString())
    .limit(20);
  for (const row of unsent ?? []) await forwardClaimToQvsp(row.id as string).catch(() => {});

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
