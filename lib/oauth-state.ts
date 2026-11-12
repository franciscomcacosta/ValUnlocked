// Signed tokens for the Discord login flow (HMAC with SESSION_SECRET).
//
//  • state   — sent to Discord and checked on the way back. Being signed,
//              it works even when the browser that comes back isn't the one
//              that started (phones hand the login to the Discord app and
//              back to a different browser), so no cookie is required.
//  • confirm — short-lived "continue as <name>?" token, used when the login
//              finished in a different browser than it started. One click on
//              our own page then signs them in (blocks login-CSRF tricks).
import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const STATE_TTL_MS = 30 * 60_000;    // time allowed to finish logging in on Discord
const CONFIRM_TTL_MS = 10 * 60_000;

function key(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return s;
}
const sig = (purpose: string, data: string) => createHmac("sha256", key()).update(`${purpose}:${data}`).digest("base64url");

function seal(purpose: string, payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${sig(purpose, data)}`;
}
function open<T>(purpose: string, token: string | null | undefined): T | null {
  if (!token) return null;
  const [data, s] = token.split(".");
  if (!data || !s) return null;
  const a = Buffer.from(s);
  const b = Buffer.from(sig(purpose, data));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Only same-site paths like "/orders/123" — never another site. */
export function safeNext(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.startsWith("/\\") || raw.startsWith("/api/")) return "/";
  return raw.slice(0, 300);
}

// ─── state ───────────────────────────────────────────────────────────

type State = { n: string; t: number; next: string; r?: string };

/** `ref` = referral code from an invite link, carried through the login so
 *  it still counts if the browser changes on the way back. */
export function makeState(next: string, ref?: string | null): string {
  const s: State = { n: randomBytes(12).toString("base64url"), t: Date.now(), next: safeNext(next) };
  if (ref) s.r = ref.slice(0, 32);
  return seal("state", s);
}

/** The state's payload if it's ours and fresh, else null. */
export function readState(token: string | null | undefined): State | null {
  const s = open<State>("state", token);
  if (!s || typeof s.t !== "number" || Date.now() - s.t > STATE_TTL_MS) return null;
  return s;
}

// ─── confirm ─────────────────────────────────────────────────────────

export type PendingLogin = { uid: string; did: string; name: string; avatar: string | null; next: string; ref?: string | null; exp: number };

export function makeConfirm(p: Omit<PendingLogin, "exp">): string {
  return seal("confirm", { ...p, exp: Date.now() + CONFIRM_TTL_MS });
}

export function readConfirm(token: string | null | undefined): PendingLogin | null {
  const p = open<PendingLogin>("confirm", token);
  if (!p || typeof p.exp !== "number" || p.exp < Date.now()) return null;
  return p;
}
