"use client";
import { useEffect, useState } from "react";

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const tierLabel = (t: string) => t[0].toUpperCase() + t.slice(1);

const TIER_COLOR: Record<string, string> = {
  standard: "#3b82f6",
  premium: "#ff4655",
  ultra: "#ffd400",
};

const TIER_PRICE_CENTS: Record<string, number> = {
  standard: 999,
  premium: 2499,
  ultra: 5999,
};

interface Me {
  name: string;
  avatar: string;
  creditCents: number;
  isAdmin: boolean;
  sub: { tier: "standard" | "premium" | "ultra"; status: string; periodEnd: string; graceUntil: string | null } | null;
}

export default function AccountPage() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"renew" | "cancel" | null>(null);
  const [msg, setMsg] = useState("");

  const load = () =>
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, []);

  if (loading) return <div className="center muted">Loading…</div>;

  if (!me) {
    return (
      <div className="center">
        <h2>Sign in to see your account</h2>
        <a className="btn" href="/api/auth/login">
          Sign in with Discord
        </a>
      </div>
    );
  }

  async function renew() {
    setBusy("renew");
    setMsg("");
    const res = await fetch("/api/sub/renew", { method: "POST" });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) {
      setMsg(`❌ ${data.error}`);
      return;
    }
    window.location.href = data.invoiceUrl;
  }

  async function cancel() {
    if (!confirm("Cancel your subscription? You'll keep your tier until the end of the paid month.")) return;
    setBusy("cancel");
    setMsg("");
    const res = await fetch("/api/sub/cancel", { method: "POST" });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) {
      setMsg(`❌ ${data.error}`);
      return;
    }
    setMsg("✓ Cancelled. Your tier remains until the end of the month.");
    load();
  }

  const sub = me.sub;
  const color = sub ? TIER_COLOR[sub.tier] : "var(--muted)";
  const endDate = sub ? new Date(sub.periodEnd) : null;
  const daysLeft = endDate ? Math.ceil((endDate.getTime() - Date.now()) / 86400_000) : 0;

  return (
    <>
      <div className="topbar">
        <div className="wrap row spread" style={{ paddingBottom: 16, paddingTop: 16 }}>
          <a href="/" className="brand" style={{ color: "inherit" }}>
            VAL<span>UNLOCKED</span>
          </a>
          <div className="row">
            <img className="avatar" src={me.avatar} alt="" />
            <span className="muted">{me.name}</span>
            <form action="/api/auth/logout" method="post">
              <button className="btn ghost sm">Log out</button>
            </form>
          </div>
        </div>
      </div>

      <div className="wrap" style={{ maxWidth: 680 }}>
        <h1 style={{ marginBottom: 24 }}>Your account</h1>

        {/* Subscription card */}
        {sub ? (
          <div className="card" style={{ borderLeft: `4px solid ${color}` }}>
            <div className="row spread" style={{ flexWrap: "wrap", gap: 8 }}>
              <div>
                <div className="muted" style={{ fontSize: 12, letterSpacing: 1, textTransform: "uppercase" }}>
                  Current plan
                </div>
                <h2 style={{ margin: "4px 0 0", color }}>{tierLabel(sub.tier)}</h2>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="muted" style={{ fontSize: 12 }}>
                  {sub.status === "grace" ? "GRACE PERIOD ENDS" : "RENEWS"}
                </div>
                <div style={{ fontWeight: 700 }}>
                  {sub.status === "grace" && sub.graceUntil
                    ? new Date(sub.graceUntil).toLocaleString()
                    : endDate?.toLocaleDateString()}
                </div>
                <div className="muted" style={{ fontSize: 12 }}>
                  {daysLeft > 0 ? `${daysLeft} day${daysLeft === 1 ? "" : "s"} left` : "Due now"}
                </div>
              </div>
            </div>

            {sub.status === "grace" && (
              <div className="notice" style={{ marginTop: 16, borderLeftColor: "var(--accent)" }}>
                ⚠️ Your sub expired but you&apos;re in a 48-hour grace period. Renew now to keep your role.
              </div>
            )}

            <div className="row" style={{ marginTop: 20, gap: 10 }}>
              <button
                className="btn"
                disabled={busy !== null}
                onClick={renew}
                style={{ background: color, color: sub.tier === "ultra" ? "#000" : "#fff" }}
              >
                {busy === "renew" ? "Creating invoice…" : `Renew — ${eur(TIER_PRICE_CENTS[sub.tier])}`}
              </button>
              <button className="btn ghost" disabled={busy !== null} onClick={cancel}>
                {busy === "cancel" ? "Cancelling…" : "Cancel"}
              </button>
            </div>
            {msg && <p style={{ marginTop: 10 }}>{msg}</p>}
          </div>
        ) : (
          <div className="card">
            <h3 style={{ marginTop: 0 }}>No active subscription</h3>
            <p className="muted" style={{ marginBottom: 16 }}>
              Subscribe to unlock discounts, early drops, and premium tools.
            </p>
            <a className="btn" href="/pricing">
              See plans
            </a>
          </div>
        )}

        {/* Store credit */}
        <div className="card" style={{ marginTop: 20 }}>
          <div className="row spread">
            <div>
              <div className="muted" style={{ fontSize: 12, letterSpacing: 1, textTransform: "uppercase" }}>
                Store credit
              </div>
              <div style={{ fontSize: 28, fontWeight: 800, marginTop: 4 }}>{eur(me.creditCents)}</div>
            </div>
            <a className="btn ghost sm" href="/">
              Shop
            </a>
          </div>
          {me.creditCents > 0 && (
            <p className="muted" style={{ fontSize: 13, marginTop: 10, marginBottom: 0 }}>
              Credit is applied automatically at checkout.
            </p>
          )}
        </div>

        <div style={{ marginTop: 24, textAlign: "center" }}>
          <a href="/" className="muted" style={{ fontSize: 13 }}>
            ← Back to shop
          </a>
        </div>
      </div>
    </>
  );
}
