// Gate the entire site behind Discord OAuth. Anyone who hits a page without
// a valid session cookie is bounced to /api/auth/login, which redirects them
// to Discord's consent screen. The only entry point to the site is the bot's
// login button in Discord.
//
// Unauthenticated endpoints that MUST stay accessible (listed below):
//   /api/auth/login       — starts the OAuth flow
//   /api/auth/callback    — Discord posts the code back here
//   /api/auth/logout      — clearing cookie needs no session
//   /api/ipn              — NOWPayments webhook (no browser, no cookie)
//   /api/webhooks/*       — qvsp webhook (checks its own ?token=)
//   /api/cron/*           — external cron (uses CRON_SECRET bearer token)
//   /api/worker/*         — Fly email worker callback (EXTRACTOR_CALLBACK_SECRET bearer)
//   /r/<code>             — referral link (sets a cookie, then sends to login)
//   /api/public-stats     — kept public ONLY if used; harmless if gated too
//
// Static assets (/_next, favicon) bypass via the matcher below.

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

const PUBLIC_API_PATHS = [
  "/api/auth/login",
  "/api/auth/callback",
  "/api/auth/logout",
  "/api/auth/confirm",  // "Continue as <name>" step (signed token)
  "/login",             // sign-in page: errors + confirm step, must never need a login
  "/api/ipn",
  "/api/webhooks/",   // prefix — each webhook verifies its own secret
  "/api/cron/",       // prefix match — any /api/cron/* is cron-secret-gated internally
  "/api/worker/",     // Fly email worker callback — checks EXTRACTOR_CALLBACK_SECRET itself
  "/r/",              // referral links — set a cookie, then go to Discord login
];

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Let auth endpoints + webhooks + crons through — they have their own auth.
  if (PUBLIC_API_PATHS.some((p) => pathname === p || (p.endsWith("/") && pathname.startsWith(p)))) {
    return NextResponse.next();
  }

  // Check session cookie. We don't verify the HMAC here (that happens in
  // route handlers); mere PRESENCE is enough to let the page load and make
  // its own /api/me call, which will do the full verification.
  const hasSession = req.cookies.get(SESSION_COOKIE)?.value;
  if (hasSession) return NextResponse.next();

  // Signed-out API calls get a plain 401 (a redirect to Discord would just
  // break the page's fetch); pages go to Discord login and come back here.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "login_required" }, { status: 401 });
  }
  const loginUrl = new URL("/api/auth/login", req.url);
  const next = pathname + req.nextUrl.search;
  if (next !== "/") loginUrl.searchParams.set("next", next);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Match everything EXCEPT static assets and Next internals.
  // Keep in mind: matcher runs middleware; the PUBLIC_API_PATHS check above
  // handles the API-level exceptions.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml).*)",
  ],
};
