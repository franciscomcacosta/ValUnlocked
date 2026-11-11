// GET /r/<code> — referral link.
// Remembers the inviter in a cookie, then sends the visitor through
// Discord login. If they're already signed in, links them right away.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { sessionFromRequest } from "@/lib/session";
import { attachReferrer, cleanCode, REFERRAL_COOKIE } from "@/lib/referrals";

export async function GET(req: NextRequest, ctx: { params: Promise<{ code: string }> }) {
  const base = process.env.PUBLIC_BASE_URL ?? new URL(req.url).origin;
  const code = cleanCode((await ctx.params).code);
  if (!code) return NextResponse.redirect(`${base}/`);

  const session = sessionFromRequest(req);
  if (session) {
    await attachReferrer(session.uid, code).catch(() => false);
    return NextResponse.redirect(`${base}/`);
  }

  const res = NextResponse.redirect(`${base}/api/auth/login`);
  res.cookies.set(REFERRAL_COOKIE, code, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 86400,
    path: "/",
  });
  return res;
}
