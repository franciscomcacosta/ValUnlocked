export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/supabase";
import { encodeSession, SESSION_COOKIE, SESSION_DAYS } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const base = process.env.PUBLIC_BASE_URL!;
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const expected = req.cookies.get("vs_oauth_state")?.value;
  if (!code || !state || !expected || state !== expected) {
    return NextResponse.redirect(`${base}/?login=failed`);
  }

  // Exchange the code for an access token
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
  });
  if (!tokenRes.ok) return NextResponse.redirect(`${base}/?login=failed`);
  const { access_token } = await tokenRes.json();

  const meRes = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${access_token}` },
  });
  if (!meRes.ok) return NextResponse.redirect(`${base}/?login=failed`);
  const me = (await meRes.json()) as { id: string; username: string; global_name?: string; avatar: string | null };

  // Create the user on first login, keep the name fresh after that
  const { data: user, error } = await db
    .from("users")
    .upsert({ discord_id: me.id, discord_username: me.global_name || me.username }, { onConflict: "discord_id" })
    .select("id")
    .single();
  if (error || !user) return NextResponse.redirect(`${base}/?login=failed`);

  const res = NextResponse.redirect(`${base}/`);
  res.cookies.delete("vs_oauth_state");
  res.cookies.set(
    SESSION_COOKIE,
    encodeSession({
      uid: user.id,
      did: me.id,
      name: me.global_name || me.username,
      avatar: me.avatar,
      exp: Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400,
    }),
    {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: SESSION_DAYS * 86400,
      path: "/",
    }
  );
  return res;
}
