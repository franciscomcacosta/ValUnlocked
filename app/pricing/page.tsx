"use client";
import { useEffect, useState } from "react";

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

interface Me {
  name: string;
  avatar: string;
  creditCents: number;
  isAdmin: boolean;
  sub: { tier: "standard" | "premium" | "ultra"; status: string; periodEnd: string } | null;
}

type Tier = "standard" | "premium" | "ultra";

interface TierCard {
  tier: Tier;
  emoji: string;
  name: string;
  priceCents: number;
  color: string;
  tagline: string;
  perks: string[];
  badge?: string;
}

const TIERS: TierCard[] = [
  {
    tier: "standard",
    emoji: "🎟️",
    name: "Standard",
    priceCents: 999,
    color: "#3b82f6",
    tagline: "The toolkit — cheaper accounts + the method.",
    perks: [
      "10% off every account",
      "Full method guide + Discord access",
      "Email Grabber tool",
    ],
  },
  {
    tier: "premium",
    emoji: "⚡",
    name: "Premium",
    priceCents: 2499,
    color: "#ff4655",
    tagline: "See the drops first.",
    badge: "MOST POPULAR",
    perks: [
      "25% off every account",
      "2-hour early access on new drops",
      "Custom stock alerts (/snipe)",
      "Everything in Standard",
    ],
  },
  {
    tier: "ultra",
    emoji: "👑",
    name: "Ultra",
    priceCents: 5999,
    color: "#ffd400",
    tagline: "Let the bot buy for you.",
    badge: "BEST VALUE",
    perks: [
      "40% off (up to 50% on whale accounts)",
      "Auto-buy — bot snipes matching drops",
      "Priority replacement handling",
      "Everything in Premium",
    ],
  },
];

export default function PricingPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<Tier | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .finally(() => setLoaded(true));
  }, []);

  async function subscribe(tier: Tier) {
    if (!me) {
      // Not logged in — bounce to Discord OAuth; pricing survives round-trip
      window.location.href = "/api/auth/login";
      return;
    }
    setBusy(tier);
    setErr("");
    const res = await fetch("/api/sub/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier }),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) {
      setErr(data.error ?? "Something went wrong");
      return;
    }
    // Redirect to NOWPayments invoice page
    window.location.href = data.invoiceUrl;
  }

  return (
    <>
      <div className="topbar">
        <div className="wrap row spread" style={{ paddingBottom: 16, paddingTop: 16 }}>
          <a href="/" className="brand" style={{ color: "inherit" }}>
            VAL<span>UNLOCKED</span>
          </a>
          <div className="row">
            {loaded && me ? (
              <>
                <img className="avatar" src={me.avatar} alt="" />
                <a href="/account" className="muted">
                  {me.name}
                </a>
              </>
            ) : (
              loaded && (
                <a className="btn sm" href="/api/auth/login">
                  Sign in with Discord
                </a>
              )
            )}
          </div>
        </div>
      </div>

      <div className="wrap">
        <div style={{ textAlign: "center", padding: "40px 16px 24px" }}>
          <h1 style={{ fontSize: 44, margin: 0, letterSpacing: "-0.5px" }}>Pick your edge.</h1>
          <p className="muted" style={{ fontSize: 18, maxWidth: 580, margin: "16px auto 0" }}>
            Three tiers. Pay in crypto, monthly. Cancel anytime. Role granted the moment payment confirms on-chain.
          </p>
        </div>

        {err && (
          <p className="err" style={{ textAlign: "center" }}>
            {err}
          </p>
        )}

        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", marginTop: 24 }}>
          {TIERS.map((t) => {
            const isCurrent = me?.sub?.tier === t.tier && (me?.sub?.status === "active" || me?.sub?.status === "grace");
            return (
              <div
                key={t.tier}
                className="card"
                style={{
                  position: "relative",
                  borderColor: t.badge ? t.color : undefined,
                  borderWidth: t.badge ? 2 : 1,
                  transform: t.tier === "premium" ? "translateY(-8px)" : undefined,
                }}
              >
                {t.badge && (
                  <div
                    style={{
                      position: "absolute",
                      top: -12,
                      left: "50%",
                      transform: "translateX(-50%)",
                      background: t.color,
                      color: t.tier === "ultra" ? "#000" : "#fff",
                      fontSize: 11,
                      fontWeight: 800,
                      letterSpacing: 1,
                      padding: "4px 12px",
                      borderRadius: 999,
                    }}
                  >
                    {t.badge}
                  </div>
                )}
                <div style={{ fontSize: 36, marginBottom: 4 }}>{t.emoji}</div>
                <h3 style={{ color: t.color, margin: 0 }}>{t.name}</h3>
                <p className="muted" style={{ fontSize: 13, marginTop: 4, minHeight: 36 }}>
                  {t.tagline}
                </p>
                <div style={{ fontSize: 32, fontWeight: 800, margin: "12px 0" }}>
                  {eur(t.priceCents)}
                  <span className="muted" style={{ fontSize: 14, fontWeight: 400 }}>
                    {" "}
                    / month
                  </span>
                </div>
                <ul style={{ padding: 0, listStyle: "none", margin: "16px 0", minHeight: 140 }}>
                  {t.perks.map((p) => (
                    <li key={p} style={{ padding: "6px 0", fontSize: 14 }}>
                      <span style={{ color: t.color, marginRight: 8 }}>✓</span>
                      {p}
                    </li>
                  ))}
                </ul>
                <button
                  className="btn"
                  style={{
                    width: "100%",
                    background: isCurrent ? "var(--panel-2)" : t.color,
                    color: isCurrent ? "var(--muted)" : t.tier === "ultra" ? "#000" : "#fff",
                  }}
                  disabled={busy === t.tier || isCurrent}
                  onClick={() => subscribe(t.tier)}
                >
                  {isCurrent
                    ? "Your current plan"
                    : busy === t.tier
                    ? "Creating invoice…"
                    : me
                    ? `Subscribe ${t.name}`
                    : `Sign in to get ${t.name}`}
                </button>
              </div>
            );
          })}
        </div>

        <div style={{ marginTop: 48, textAlign: "center" }}>
          <p className="muted" style={{ fontSize: 13 }}>
            All tiers get access to the base shop. Discounts apply automatically at checkout once you're signed in.
            <br />
            Cancel anytime — your tier stays active until the end of the paid month.
          </p>
        </div>
      </div>
    </>
  );
}
