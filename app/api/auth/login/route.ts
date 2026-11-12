export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { makeState, safeNext } from "@/lib/oauth-state";
import { REFERRAL_COOKIE } from "@/lib/referrals";

// Sends the user to Discord's authorize screen (scope: identify only).
//   ?next=/orders/123   where to land after signing in
//   ?switch=1           always show Discord's screen (to pick another account)
//
// The state is signed (lib/oauth-state.ts), so the callback can verify it even
// if the login comes back in a different browser (phones hand off to the
// Discord app). The cookie copy is only a bonus for the same-browser case.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const ref = req.headers.get("cookie")?.match(new RegExp(`(?:^|;\\s*)${REFERRAL_COOKIE}=([^;]+)`))?.[1] ?? null;
  const state = makeState(safeNext(url.searchParams.get("next")), ref ? decodeURIComponent(ref) : null);

  const discord = new URL("https://discord.com/oauth2/authorize");
  discord.searchParams.set("client_id", process.env.DISCORD_CLIENT_ID!);
  discord.searchParams.set("response_type", "code");
  discord.searchParams.set("redirect_uri", `${process.env.PUBLIC_BASE_URL}/api/auth/callback`);
  discord.searchParams.set("scope", "identify");
  discord.searchParams.set("state", state);
  // "none" skips the screen for people who already authorized us; first-timers
  // still see it. "consent" forces it, so people can switch account.
  discord.searchParams.set("prompt", url.searchParams.get("switch") ? "consent" : "none");

  const res = NextResponse.redirect(discord);
  res.cookies.set("vs_oauth_state", state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 30 * 60,
    path: "/",
  });
  return res;
}
