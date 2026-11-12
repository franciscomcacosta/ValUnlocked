import { createHmac, timingSafeEqual } from "crypto";

// Signed session cookie set after Discord login. Format: base64url(json).base64url(hmac)
export const SESSION_COOKIE = "vs_session";
export const SESSION_DAYS = 7;

export interface Session {
  uid: string;          // users.id
  did: string;          // Discord user id
  name: string;
  avatar: string | null;
  exp: number;          // unix seconds
}

function sign(data: string): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return createHmac("sha256", secret).update(data).digest("base64url");
}

export function encodeSession(s: Session): string {
  const data = Buffer.from(JSON.stringify(s)).toString("base64url");
  return `${data}.${sign(data)}`;
}

export function decodeSession(value: string | undefined | null): Session | null {
  if (!value) return null;
  const [data, sig] = value.split(".");
  if (!data || !sig) return null;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(data));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as Session;
    return s.exp > Date.now() / 1000 ? s : null;
  } catch {
    return null;
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function sessionFromRequest(req: Request): Session | null {
  return decodeSession(readCookie(req.headers.get("cookie"), SESSION_COOKIE));
}

export async function getSessionUserId(req: Request): Promise<string | null> {
  return sessionFromRequest(req)?.uid ?? null;
}

// Staff are listed by Discord id in ADMIN_DISCORD_IDS (comma separated).
export function isAdmin(s: Session | null): boolean {
  if (!s) return false;
  const ids = (process.env.ADMIN_DISCORD_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return ids.includes(s.did);
}

export function requireAdmin(req: Request): Session | Response {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "login_required" }, { status: 401 });
  if (!isAdmin(s)) return Response.json({ error: "forbidden" }, { status: 403 });
  return s;
}

export function avatarUrl(s: Pick<Session, "did" | "avatar">): string {
  return s.avatar
    ? `https://cdn.discordapp.com/avatars/${s.did}/${s.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(s.did) >> 22n) % 6}.png`;
}

/** Cookie settings for a fresh login session (used by the OAuth callback
 *  and the "continue as …" confirm step). */
export function sessionCookie(s: Omit<Session, "exp">): [string, string, { httpOnly: true; secure: boolean; sameSite: "lax"; maxAge: number; path: string }] {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  return [
    SESSION_COOKIE,
    encodeSession({ ...s, exp }),
    { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: SESSION_DAYS * 86400, path: "/" },
  ];
}
