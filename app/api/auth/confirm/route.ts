export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// POST /api/auth/confirm  (form: token) — the "Continue as <name>" button on
// /login, used when a Discord login finished in a different browser than it
// started in. The token is signed and short-lived (lib/oauth-state.ts).
import { NextResponse } from "next/server";
import { sessionCookie } from "@/lib/session";
import { readConfirm } from "@/lib/oauth-state";
import { attachReferrer, REFERRAL_COOKIE } from "@/lib/referrals";

export async function POST(req: Request) {
  const base = process.env.PUBLIC_BASE_URL!;
  const form = await req.formData().catch(() => null);
  const p = readConfirm(String(form?.get("token") ?? ""));
  if (!p) return NextResponse.redirect(`${base}/login?error=expired`, { status: 303 });

  if (p.ref) await attachReferrer(p.uid, p.ref).catch(() => false);

  const res = NextResponse.redirect(`${base}${p.next}`, { status: 303 });
  res.cookies.set(...sessionCookie({ uid: p.uid, did: p.did, name: p.name, avatar: p.avatar }));
  res.cookies.delete("vs_oauth_state");
  res.cookies.delete(REFERRAL_COOKIE);
  return res;
}
