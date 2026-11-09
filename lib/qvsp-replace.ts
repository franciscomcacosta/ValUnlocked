// qvsp replacement tickets.
//
// Endpoints (from the API's own root listing):
//   POST /replace                    open a ticket
//   POST /replace/proof              upload a video
//   POST /replace/{ticket}/proof     attach proof to a ticket
//   POST /replace/{ticket}/say       post a message on a ticket
//   GET  /replace/{ticket}           ticket state
//
// The request/response FIELD NAMES are not documented to us yet ("Partner
// Api Docs.md" in the onboarding kit). Every guess lives in this file and
// readers accept several spellings, so matching the docs is a local edit.
// Nothing here is trusted blindly: outcomes are always re-read with GET.
import { qvspRaw, getOrder, type QvspCredentials } from "./qvsp";

export type TicketState = "open" | "approved" | "denied" | "closed" | "unknown";

export interface TicketView {
  id: string;
  state: TicketState;
  rawStatus: string | null;
  credentials: QvspCredentials | null;   // replacement account, if qvsp gave one
  replacementOrderId: string | null;
  note: string | null;
  raw: unknown;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** First non-empty string among dotted paths, e.g. "ticket.id". */
function pick(o: unknown, paths: string[]): string | null {
  for (const p of paths) {
    let cur: unknown = o;
    for (const k of p.split(".")) cur = isObj(cur) ? cur[k] : undefined;
    if (typeof cur === "string" && cur.trim()) return cur.trim();
    if (typeof cur === "number") return String(cur);
  }
  return null;
}

function findCredentials(o: unknown, depth = 0): QvspCredentials | null {
  if (!isObj(o) || depth > 4) return null;
  if (typeof o.login === "string" && typeof o.password === "string") return o as QvspCredentials;
  for (const v of Object.values(o)) {
    const c = findCredentials(v, depth + 1);
    if (c) return c;
  }
  return null;
}

function mapState(s: string | null): TicketState {
  const v = (s ?? "").toLowerCase();
  if (!v) return "unknown";
  if (/(approv|accept|replaced|resolved|refund)/.test(v)) return "approved";
  if (/(deni|reject|declin)/.test(v)) return "denied";
  if (/(clos|cancel|expir)/.test(v)) return "closed";
  if (/(open|pending|review|wait|new|progress)/.test(v)) return "open";
  return "unknown";
}

export function ticketIdFrom(body: unknown): string | null {
  return pick(body, ["ticket_id", "ticket.id", "ticket.ticket_id", "data.ticket_id", "data.id", "id", "replacement.ticket_id"]);
}

/** qvsp's allowed ticket categories. */
export type QvspCategory = "banned" | "ingame_ban" | "login" | "login_mfa" | "mfa" | "other";

/** Our report reason (+ the buyer's note) → qvsp category. */
const QVSP_CATEGORIES: QvspCategory[] = ["banned", "ingame_ban", "login", "login_mfa", "mfa", "other"];

export function qvspCategory(reason: string, details?: string | null): QvspCategory {
  // New reports use qvsp's categories directly.
  if ((QVSP_CATEGORIES as string[]).includes(reason)) return reason as QvspCategory;
  // Older reports (login/count/locked/other) — best guess from the note.
  const d = (details ?? "").toLowerCase();
  const mfa = /\b(2fa|mfa|two[- ]?factor|authenticator|verification code|security code|email code)\b/.test(d);
  if (reason === "login") return mfa ? "login_mfa" : "login";
  if (reason === "locked") return /(in[- ]?game|queue|ranked|penalt|restrict|comp)/.test(d) ? "ingame_ban" : "banned";
  if (mfa) return "mfa";
  return "other"; // wrong skin count, something else
}

export async function openTicket(opts: {
  qvspOrderId: string;
  reason: string;
  message: string;
  accountUsername?: string | null;
  details?: string | null;
  proofToken: string;
}) {
  const res = await qvspRaw("/replace", {
    json: {
      order_id: opts.qvspOrderId,
      // Required by qvsp: login of the account being replaced + a category.
      account_username: opts.accountUsername ?? undefined,
      category: qvspCategory(opts.reason, opts.details),
      // qvsp requires the video to be uploaded first (uploadProof) and its
      // token sent with the ticket.
      proof_token: opts.proofToken,
      reason: opts.reason,
      message: opts.message,
    },
  });
  return { ...res, ticketId: res.ok ? ticketIdFrom(res.body) : null };
}

/** Step 1 of a qvsp ticket: upload the buyer's video, get a proof_token. */
export async function uploadProof(opts: {
  file: Blob;
  filename: string;
  qvspOrderId?: string;
  accountUsername?: string | null;
  category?: QvspCategory;
}) {
  const send = (field: string) => {
    const form = new FormData();
    if (opts.qvspOrderId) form.append("order_id", opts.qvspOrderId);
    // qvsp requires these on the proof upload too.
    if (opts.accountUsername) form.append("account_username", opts.accountUsername);
    if (opts.category) form.append("category", opts.category);
    form.append(field, opts.file, opts.filename);
    return qvspRaw("/replace/proof", { form });
  };
  let res = await send("video");
  // If qvsp names a different file field, retry once with "file".
  if (!res.ok && res.status >= 400 && res.status < 500 && /\b(file|video)\b/i.test(JSON.stringify(res.body ?? ""))) {
    const again = await send("file");
    if (again.ok) res = again;
  }
  const proofToken = res.ok
    ? pick(res.body, ["proof_token", "token", "data.proof_token", "proof.proof_token", "proof.token", "data.token"])
    : null;
  return { ...res, proofToken };
}

/** (Legacy) Upload the video to an existing ticket. */
export async function uploadVideo(opts: { ticketId: string; file: Blob; filename: string }) {
  const form = new FormData();
  form.append("ticket_id", opts.ticketId);
  form.append("video", opts.file, opts.filename);
  const res = await qvspRaw("/replace/proof", { form });
  const proofRef = res.ok
    ? pick(res.body, ["proof_id", "proof.id", "id", "video_id", "file_id", "url", "proof.url", "video_url"])
    : null;
  return { ...res, proofRef };
}

export async function attachProof(opts: { ticketId: string; proofRef: string | null; videoUrl: string | null }) {
  return qvspRaw(`/replace/${encodeURIComponent(opts.ticketId)}/proof`, {
    json: {
      ...(opts.proofRef ? { proof_id: opts.proofRef } : {}),
      ...(opts.videoUrl ? { url: opts.videoUrl, video_url: opts.videoUrl } : {}),
    },
  });
}

export async function sayOnTicket(ticketId: string, message: string) {
  return qvspRaw(`/replace/${encodeURIComponent(ticketId)}/say`, { json: { message } });
}

/** Read a ticket and normalise it. Fetches the replacement order's
 *  credentials when qvsp points at a new order instead of inlining them. */
export async function getTicket(ticketId: string): Promise<TicketView | null> {
  const res = await qvspRaw(`/replace/${encodeURIComponent(ticketId)}`);
  if (!res.ok) return null;
  const t = isObj(res.body) && isObj(res.body.ticket) ? res.body.ticket : res.body;
  const rawStatus = pick(t, ["status", "state", "decision", "outcome", "result"]);
  let credentials = findCredentials(t);
  const replacementOrderId = pick(t, [
    "replacement_order_id", "new_order_id", "replacement.order_id", "replacement.id", "new_order.id",
  ]);
  if (!credentials && replacementOrderId) {
    try { credentials = (await getOrder(replacementOrderId)).credentials ?? null; } catch { /* leave null */ }
  }
  return {
    id: ticketId,
    state: mapState(rawStatus),
    rawStatus,
    credentials: credentials?.login && credentials?.password ? credentials : null,
    replacementOrderId,
    note: pick(t, ["note", "reason", "message", "staff_note", "resolution"]),
    raw: res.body,
  };
}
