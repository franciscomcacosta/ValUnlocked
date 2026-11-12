// Login screen — the entry point for the whole site.
// Everything behind it requires Discord OAuth (handled by middleware.ts).
// This page just has to: explain what the site is, kick off OAuth,
// and show a slice of what's inside (the live-stock marquee).

import { LockLogo } from "@/components/lock-logo";
import { readConfirm, safeNext } from "@/lib/oauth-state";

export const dynamic = "force-dynamic";

// Why a login didn't work, in plain words (?error=… from the callback).
const ERRORS: Record<string, { title: string; text: string }> = {
  denied: { title: "Sign-in cancelled", text: "You pressed Cancel on Discord. We only need your username — press the button to try again." },
  expired: { title: "That sign-in link expired", text: "It took too long or the page was opened twice. Just press the button below to sign in again." },
  discord: { title: "Discord didn't respond", text: "Discord had a hiccup. Wait a few seconds and try again." },
  server: { title: "Something went wrong on our side", text: "Please try again. If it keeps happening, open a ticket in our Discord." },
};

// Sample feed for the marquee. Replace with a /api/public-stats fetch in
// phase 4 when we wire real data to all surfaces.
const SAMPLE_FEED = [
  { item: "Reaver Vandal",         r: "EU",    p: "19.99", c: "#d1548d" },
  { item: "Elderflame Vandal",     r: "EU",    p: "34.99", c: "#fad663" },
  { item: "26–50 skins",      r: "AP",    p: "2.24",  c: "#ece8e1" },
  { item: "Ion Phantom",           r: "NA",    p: "14.39", c: "#d1548d" },
  { item: "Prime Vandal",          r: "EU",    p: "17.59", c: "#d1548d" },
  { item: "Araxys Operator",       r: "BR",    p: "8.04",  c: "#f5955b" },
  { item: "X-Ray · Immortal 2", r: "EU",  p: "90.99", c: "#fad663" },
  { item: "RGX 11z Pro Vandal",    r: "LATAM", p: "7.19",  c: "#f5955b" },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Duplicate feed so marquee loops seamlessly.
  const feed = SAMPLE_FEED.concat(SAMPLE_FEED);
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null;
  const pending = readConfirm(one(sp.confirm));
  const confirmToken = pending ? one(sp.confirm) : null;
  const error = !pending && one(sp.confirm) ? ERRORS.expired : ERRORS[one(sp.error) ?? ""] ?? null;
  const next = safeNext(one(sp.next));
  const loginHref = next === "/" ? "/api/auth/login" : `/api/auth/login?next=${encodeURIComponent(next)}`;
  const avatarUrl = pending
    ? pending.avatar
      ? `https://cdn.discordapp.com/avatars/${pending.did}/${pending.avatar}.png?size=96`
      : `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(pending.did) >> 22n) % 6}.png`
    : null;

  return (
    <div
      style={{
        position: "relative",
        minHeight: "100vh",
        overflow: "hidden",
        background: "var(--vu-navy)",
        color: "var(--vu-ivory)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "24px",
      }}
    >
      {/* Grid backdrop */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)",
          backgroundSize: "46px 46px",
        }}
      />
      {/* Red glow top-left */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          left: "-200px",
          top: "-200px",
          width: "700px",
          height: "700px",
          background:
            "radial-gradient(circle, rgba(255,70,85,0.16), transparent 62%)",
          pointerEvents: "none",
        }}
      />
      {/* Cyan glow bottom-right */}
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          right: "-240px",
          bottom: "-220px",
          width: "760px",
          height: "760px",
          background:
            "radial-gradient(circle, rgba(34,211,238,0.10), transparent 62%)",
          pointerEvents: "none",
        }}
      />
      {/* Oversized VU watermark */}
      <div
        aria-hidden="true"
        className="h"
        style={{
          position: "absolute",
          left: "60px",
          bottom: "40px",
          fontSize: "clamp(140px, 18vw, 200px)",
          color: "rgba(255,255,255,0.03)",
          lineHeight: 0.8,
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        VU
      </div>

      {/* Sign-in card */}
      <main
        className="cut rise"
        style={{
          position: "relative",
          width: "420px",
          maxWidth: "100%",
          background: "rgba(18,24,33,0.92)",
          boxShadow:
            "0 0 0 1px rgba(255,255,255,0.06), 0 40px 80px rgba(0,0,0,0.5)",
          padding: 0,
          overflow: "hidden",
        }}
      >
        {/* Red top strip */}
        <div style={{ height: "6px", background: "var(--vu-red)" }} />

        <div
          style={{
            padding: "40px 40px 36px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "10px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              marginBottom: "6px",
            }}
          >
            <LockLogo size={44} />
            <span className="h" style={{ fontSize: "38px", color: "#fff" }}>
              Val{" "}
              <span style={{ color: "var(--vu-red)" }}>Unlocked</span>
            </span>
          </div>

          <span
            className="bc"
            style={{
              fontSize: "15px",
              fontWeight: 600,
              color: "var(--vu-mute-soft)",
              letterSpacing: "0.14em",
            }}
          >
            Members-only account store
          </span>

          <p
            style={{
              margin: "2px 0 20px",
              color: "var(--vu-ivory-dim)",
              fontSize: "14px",
              maxWidth: "300px",
            }}
          >
            Access is through Discord. Sign in to see live stock, your
            subscription and your purchases.
          </p>

          {error && (
            <div
              role="alert"
              style={{
                width: "100%",
                textAlign: "left",
                background: "rgba(255,70,85,0.12)",
                borderLeft: "3px solid var(--vu-red)",
                padding: "10px 12px",
                marginBottom: "8px",
              }}
            >
              <div className="bc" style={{ color: "#fff", fontWeight: 700, fontSize: "16px" }}>{error.title}</div>
              <div style={{ color: "var(--vu-ivory-dim)", fontSize: "13px" }}>{error.text}</div>
            </div>
          )}

          {pending && confirmToken ? (
            <form method="post" action="/api/auth/confirm" style={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center", gap: "12px" }}>
              <input type="hidden" name="token" value={confirmToken} />
              <div style={{ display: "flex", alignItems: "center", gap: "12px", width: "100%", background: "rgba(255,255,255,0.05)", padding: "12px 14px" }}>
                {avatarUrl && <img src={avatarUrl} alt="" width={44} height={44} style={{ borderRadius: "50%", flex: "none" }} />}
                <div style={{ textAlign: "left", minWidth: 0 }}>
                  <div className="mut" style={{ fontSize: "12px", color: "var(--vu-ivory-dim)" }}>Signed in to Discord as</div>
                  <div className="bc" style={{ color: "#fff", fontWeight: 700, fontSize: "20px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{pending.name}</div>
                </div>
              </div>
              <button
                type="submit"
                className="dc cs btn-discord"
                style={{ width: "100%", height: "56px", border: 0, cursor: "pointer", fontFamily: "var(--font-head)", textTransform: "uppercase", fontWeight: 700, fontSize: "20px", letterSpacing: "0.05em" }}
              >
                Continue as {pending.name}
              </button>
              <a href="/api/auth/login?switch=1" style={{ color: "var(--vu-ivory-dim)", fontSize: "13px", textDecoration: "underline" }}>
                Not you? Use a different Discord account
              </a>
            </form>
          ) : (
          <a
            className="dc cs btn-discord"
            href={loginHref}
            style={{
              width: "100%",
              height: "56px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              fontFamily: "var(--font-head)",
              textTransform: "uppercase",
              fontWeight: 700,
              fontSize: "20px",
              letterSpacing: "0.05em",
              textDecoration: "none",
            }}
          >
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M20.3 4.4A19.8 19.8 0 0 0 15.4 3l-.3.5a18 18 0 0 1 4.3 1.4 18.7 18.7 0 0 0-14.9 0A18 18 0 0 1 8.9 3.5L8.6 3a19.8 19.8 0 0 0-4.9 1.4C.6 9 .2 13.5.5 18a20 20 0 0 0 6 3l.7-1.1c-1-.4-2-.9-2.9-1.5l.6-.4a14.3 14.3 0 0 0 12.2 0l.6.4c-.9.6-1.9 1.1-2.9 1.5l.7 1.1a20 20 0 0 0 6-3c.4-5.2-.5-9.6-3.2-13.6ZM8.3 15.3c-1.2 0-2.1-1.1-2.1-2.4 0-1.3.9-2.4 2.1-2.4 1.2 0 2.2 1.1 2.1 2.4 0 1.3-.9 2.4-2.1 2.4Zm7.4 0c-1.2 0-2.1-1.1-2.1-2.4 0-1.3.9-2.4 2.1-2.4 1.2 0 2.2 1.1 2.1 2.4 0 1.3-.9 2.4-2.1 2.4Z" />
            </svg>
            {error ? "Try again with Discord" : "Continue with Discord"}
          </a>
          )}

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              marginTop: "14px",
              color: "var(--vu-mute)",
              fontSize: "12px",
            }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="4" y="11" width="16" height="10" rx="1" />
              <path d="M8 11V7a4 4 0 0 1 8 0v4" />
            </svg>
            We only read your Discord username and ID. No posting, no DMs.
          </div>
        </div>
      </main>

      {/* Live stock ticker */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          height: "36px",
          background: "var(--vu-navy-soft)",
          borderTop: "1px solid rgba(255,255,255,0.05)",
          display: "flex",
          alignItems: "center",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            flex: "none",
            height: "100%",
            display: "flex",
            alignItems: "center",
            gap: "7px",
            padding: "0 14px 0 24px",
            background: "var(--vu-navy-soft)",
            position: "relative",
            zIndex: 1,
          }}
        >
          <span
            className="live"
            style={{
              position: "relative",
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "var(--accent-green)",
            }}
          />
          <span
            className="bc"
            style={{
              fontSize: "13px",
              fontWeight: 700,
              color: "var(--accent-green)",
            }}
          >
            Live stock
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
          <div className="marq">
            {feed.map((e, i) => (
              <span
                key={i}
                style={{ fontSize: "12px", color: "var(--vu-mute-soft)" }}
              >
                <b style={{ color: e.c, fontWeight: 600 }}>{e.item}</b> ·{" "}
                {e.r} ·{" "}
                <span className="num">€{e.p}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
