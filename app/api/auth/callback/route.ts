export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Discord sends people back here after the authorize screen.
//
// Never loops: every failure goes to /login (a public page) with a clear
// reason and a "Try again" button — not back into the login-gated site.
//
// Same browser that started the login (state cookie matches) → signed in.
// Different browser (phone handed off to the Discord app and back, cookie
// lost) → the signed state still proves the login is ours, and the person
// confirms with one click on /login ("Continue as <name>").
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/supabase";
import { sessionCookie } from "@/lib/session";
import { attachReferrer, REFERRAL_COOKIE } from "@/lib/referrals";
import { readState, makeConfirm } from "@/lib/oauth-state";

const STATE_COOKIE = "vs_oauth_state";

export async function GET(req: NextRequest) {
  const base = process.env.PUBLIC_BASE_URL!;
  const q = req.nextUrl.searchParams;
  const fail = (reason: string) => {
    const res = NextResponse.redirect(`${base}/login?error=${reason}`);
    res.cookies.delete(STATE_COOKIE);
    return res;
  };

  // Pressed "Cancel" on Discord's screen.
  if (q.get("error")) return fail(q.get("error") === "access_denied" ? "denied" : "discord");

  const code = q.get("code");
  const stateToken = q.get("state");
  const state = readState(stateToken);
  if (!code || !state) return fail("expired");

  // Exchange the code for an access token.
  const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.DISCORD_CLIENT_ID!,
      client_secret: process.env.DISCORD_CLIENT_SECRET!,
      grant_type: "authorization_code",
      code,
      redirect_uri: `${base}/api/auth/callback`,
    }),
  }).catch(() => null);
  if (!tokenRes?.ok) {
    console.warn("[auth] token exchange failed", tokenRes?.status, await tokenRes?.text().catch(() => ""));
    // A used/expired code usually means the page was refreshed or opened twice.
    return fail("expired");
  }
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const meRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${access_token}` },
  }).catch(() => null);
  if (!meRes?.ok) return fail("discord");
  const me = (await meRes.json()) as { id: string; username: string; global_name?: string; avatar: string | null };
  const name = me.global_name || me.username;

  // Create the user on first login, keep the name fresh after that.
  const { data: user, error } = await db
    .from("users")
    .upsert({ discord_id: me.id, discord_username: name }, { onConflict: "discord_id" })
    .select("id")
    .single();
  if (error || !user) {
    console.error("[auth] user upsert failed", error);
    return fail("server");
  }

  const sameBrowser = req.cookies.get(STATE_COOKIE)?.value === stateToken;
  const ref = req.cookies.get(REFERRAL_COOKIE)?.value ?? state.r ?? null;

  if (!sameBrowser) {
    // Finished in a different browser: ask them to confirm it's them.
    const token = makeConfirm({ uid: user.id as string, did: me.id, name, avatar: me.avatar, next: state.next, ref });
    return NextResponse.redirect(`${base}/login?confirm=${encodeURIComponent(token)}`);
  }

  // Came in through a friend's invite link? Link them (only works for
  // people who haven't ordered yet, so existing customers can't be claimed).
  if (ref) await attachReferrer(user.id as string, ref).catch(() => false);

  const res = NextResponse.redirect(`${base}${state.next}`);
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(REFERRAL_COOKIE);
  res.cookies.set(...sessionCookie({ uid: user.id as string, did: me.id, name, avatar: me.avatar }));
  return res;
}
