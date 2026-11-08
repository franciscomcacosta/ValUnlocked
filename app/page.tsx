"use client";
// Dashboard — the ONLY signed-in page. Middleware gates every route behind
// Discord OAuth, so if we're here we're signed in.
//
// Tabs: Stock · Subscribe · My Purchases · ⚡ X-RAY (Ultra) · Admin
//
// Visual language: Valorant-dark (ported from the design canvas in phase 2).

import { useCallback, useEffect, useState } from "react";
import { LockLogo } from "@/components/lock-logo";

// ----- Types ----------------------------------------------------

const REGIONS = ["EU", "AP", "KR", "LATAM", "BR"] as const;
type Region = typeof REGIONS[number];
type Tier = "standard" | "premium" | "ultra";

const REGION_NAME: Record<Region, string> = {
  EU: "Europe",
  AP: "Asia Pacific",
  KR: "Korea",
  LATAM: "Latin America",
  BR: "Brazil",
};

const TIER_COLOR: Record<Tier, string> = {
  standard: "#3b82f6",
  premium:  "#ff4655",
  ultra:    "#ffd400",
};

const TIER_LABEL: Record<Tier, string> = {
  standard: "Standard",
  premium:  "Premium",
  ultra:    "Ultra",
};

interface Me {
  name: string;
  avatar: string;
  creditCents: number;
  isAdmin: boolean;
  sub: { tier: Tier; status: string; periodEnd: string } | null;
}

interface BracketRow {
  region: Region;
  bracket: string;
  label: string;
  available: number;
  price: {
    publicCents: number;
    finalCents: number;
    discountPct: number;
    savingsCents: number;
  };
}

interface FeaturedSkinRow {
  key: string;
  label: string;
  weapon: string;
  available: number;
  cheapestQvspCents: number | null;
  publicCents: number;
  finalCents: number;
  savingsCents: number;
  discountPct: number;
}

interface Order {
  id: string;
  status: string;
  price_cents: number;
  currency: string;
  created_at: string;
  products: { name: string; region: string; rank: string | null } | null;
}

// ----- Helpers --------------------------------------------------

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

function tierPillColor(tier: Tier): string {
  return TIER_COLOR[tier];
}

// Sample live feed for the marquee until we wire /api/public-stats.
const SAMPLE_FEED = [
  { u: "cyph3r",   item: "Reaver Vandal",       t: "just now", c: "#d1548d" },
  { u: "blitz_",   item: "Prime Vandal",        t: "2m ago",   c: "#d1548d" },
  { u: "neko",     item: "26–50 skins · EU",    t: "5m ago",   c: "#ece8e1" },
  { u: "veyl",     item: "Elderflame Vandal",   t: "8m ago",   c: "#fad663" },
  { u: "ayva",     item: "Oni Phantom",         t: "11m ago",  c: "#d1548d" },
  { u: "mirai",    item: "Araxys Operator",     t: "14m ago",  c: "#f5955b" },
  { u: "hollow",   item: "51–100 skins · AP",   t: "17m ago",  c: "#ece8e1" },
  { u: "pixel",    item: "RGX 11z Pro Vandal",  t: "22m ago",  c: "#f5955b" },
];

// ================================================================
// Root
// ================================================================

type TabKey = "stock" | "subscribe" | "purchases" | "xray" | "admin";

export default function Page() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>("stock");

  useEffect(() => {
    fetch("/api/me")
      .then((r) => {
        if (r.status === 401) {
          window.location.href = "/api/auth/login";
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then(setMe)
      .finally(() => setLoading(false));
  }, []);

  if (loading || !me) {
    return (
      <div
        className="vu"
        style={{
          minHeight: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--vu-navy)",
          color: "var(--vu-ivory-dim)",
        }}
      >
        <span className="bc">Loading…</span>
      </div>
    );
  }

  const isUltra = me.sub?.tier === "ultra";

  return (
    <div
      className="vu"
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        background: "var(--vu-bg-light)",
      }}
    >
      <Header me={me} tab={tab} onTab={setTab} isUltra={isUltra} />

      <main
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          padding: "18px 24px",
          maxWidth: "1480px",
          margin: "0 auto",
          boxSizing: "border-box",
        }}
      >
        {tab === "stock" && <StockTab me={me} />}
        {tab === "subscribe" && (
          <SubscribeTab me={me} reload={() => window.location.reload()} />
        )}
        {tab === "purchases" && <PurchasesTab />}
        {tab === "xray" && <XrayTab isUltra={isUltra} />}
        {tab === "admin" && me.isAdmin && <AdminTab />}
      </main>
    </div>
  );
}

// ================================================================
// Header
// ================================================================

function Header({
  me,
  tab,
  onTab,
  isUltra,
}: {
  me: Me;
  tab: TabKey;
  onTab: (t: TabKey) => void;
  isUltra: boolean;
}) {
  const feed = SAMPLE_FEED.concat(SAMPLE_FEED);
  const subDaysLeft = me.sub
    ? Math.max(
        0,
        Math.floor(
          (new Date(me.sub.periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
        )
      )
    : null;
  const subPips = Array.from({ length: 10 }).map((_, i) => {
    const progress = subDaysLeft != null ? Math.ceil((subDaysLeft / 30) * 10) : 0;
    return i < progress;
  });
  const tierColor = me.sub ? tierPillColor(me.sub.tier) : null;

  return (
    <header style={{ flex: "none", background: "var(--vu-navy)", color: "var(--vu-ivory)" }}>
      <div
        style={{
          padding: "0 24px",
          height: "58px",
          display: "flex",
          alignItems: "center",
          gap: "20px",
        }}
      >
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: "10px", flex: "none" }}>
          <LockLogo size={28} />
          <span className="h" style={{ fontSize: "22px", color: "#fff" }}>
            Val <span style={{ color: "var(--vu-red)" }}>Unlocked</span>
          </span>
        </div>

        {/* Nav tabs */}
        <nav className="nav" aria-label="Sections">
          {([
            { key: "stock",      label: "Stock" },
            { key: "subscribe",  label: "Subscribe" },
            { key: "purchases",  label: "My Purchases" },
            { key: "xray",       label: isUltra ? "⚡ X-RAY" : "🔒 X-RAY", ultra: true },
          ] as const).map((t) => (
            <button
              key={t.key}
              className={`${tab === t.key ? "on" : ""} ${"ultra" in t && t.ultra ? "ul" : ""}`}
              onClick={() => onTab(t.key as TabKey)}
            >
              {t.label}
            </button>
          ))}
          {me.isAdmin && (
            <button
              className={tab === "admin" ? "on" : ""}
              onClick={() => onTab("admin")}
            >
              Admin
            </button>
          )}
        </nav>

        <div style={{ flex: 1 }} />

        {/* Subscription pill */}
        {me.sub && tierColor && (
          <div
            className="cs"
            style={{
              flex: "none",
              display: "flex",
              alignItems: "stretch",
              height: "36px",
              background: "#1f2d3b",
            }}
            title={`${TIER_LABEL[me.sub.tier]}${subDaysLeft != null ? `, ${subDaysLeft} days left` : ""}`}
          >
            <span
              style={{
                width: "36px",
                background: tierColor,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#0f1923",
                fontWeight: 900,
                fontFamily: "var(--font-head)",
                fontSize: "16px",
              }}
            >
              {TIER_LABEL[me.sub.tier][0]}
            </span>
            <span
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: "4px",
                padding: "0 12px",
              }}
            >
              <span style={{ display: "flex", alignItems: "baseline", gap: "8px", whiteSpace: "nowrap" }}>
                <span
                  className="bc"
                  style={{
                    fontWeight: 700,
                    fontSize: "15px",
                    color: "#fff",
                    letterSpacing: "0.08em",
                    lineHeight: 1,
                  }}
                >
                  {TIER_LABEL[me.sub.tier]}
                </span>
                <span
                  className="bc num"
                  style={{
                    fontWeight: 600,
                    fontSize: "13px",
                    color: tierColor,
                    lineHeight: 1,
                  }}
                >
                  {subDaysLeft}d left
                </span>
              </span>
              <span className="pips" style={{ display: "flex", gap: "2px" }} aria-hidden="true">
                {subPips.map((on, i) => (
                  <span
                    key={i}
                    style={{
                      width: "8px",
                      height: "3px",
                      background: on ? tierColor : "rgba(255,255,255,0.15)",
                    }}
                  />
                ))}
              </span>
            </span>
          </div>
        )}

        {/* Credit pill */}
        {me.creditCents > 0 && (
          <div
            className="cs"
            style={{
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: "8px",
              height: "36px",
              padding: "0 12px",
              background: "rgba(255,212,0,0.12)",
            }}
          >
            <span className="bc" style={{ color: "#ffd400", fontWeight: 600, fontSize: "14px" }}>
              Credit
            </span>
            <span className="num" style={{ fontWeight: 700, color: "#ffd400" }}>
              {eur(me.creditCents)}
            </span>
          </div>
        )}

        {/* Avatar */}
        {me.avatar ? (
          <img
            src={me.avatar}
            alt=""
            className="cs"
            style={{
              flex: "none",
              width: "34px",
              height: "34px",
              objectFit: "cover",
              background: "var(--discord)",
            }}
          />
        ) : (
          <span
            aria-hidden="true"
            className="cs"
            style={{
              flex: "none",
              width: "34px",
              height: "34px",
              background: "var(--discord)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              color: "#fff",
            }}
          >
            {me.name[0]?.toUpperCase() ?? "?"}
          </span>
        )}

        {/* Logout */}
        <form action="/api/auth/logout" method="post" style={{ display: "inline" }}>
          <button
            className="bc"
            type="submit"
            style={{
              flex: "none",
              border: 0,
              background: "transparent",
              color: "var(--vu-mute-soft)",
              fontWeight: 600,
              fontSize: "15px",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
            }}
            title={me.name}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Log out
          </button>
        </form>
      </div>

      {/* Live feed */}
      <div
        style={{
          height: "28px",
          background: "#16212d",
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
            gap: "6px",
            padding: "0 12px 0 24px",
            background: "#16212d",
            position: "relative",
            zIndex: 1,
          }}
        >
          <span
            className="live"
            style={{
              width: "6px",
              height: "6px",
              borderRadius: "50%",
              background: "var(--accent-green)",
            }}
          />
          <span className="bc" style={{ fontSize: "13px", fontWeight: 700, color: "var(--accent-green)" }}>
            Live
          </span>
        </div>
        <div style={{ flex: 1, minWidth: 0, overflow: "hidden" }} aria-label="Recent purchases">
          <div className="marq">
            {feed.map((e, i) => (
              <span key={i} style={{ fontSize: "12px", color: "var(--vu-ivory-dim)" }}>
                <b style={{ color: "var(--vu-ivory)", fontWeight: 600 }}>{e.u}</b> unlocked{" "}
                <b style={{ color: e.c, fontWeight: 600 }}>{e.item}</b> · {e.t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </header>
  );
}

// ================================================================
// Stock tab
// ================================================================

type StockMode = "bracket" | "skin";

function StockTab({ me }: { me: Me }) {
  const [mode, setMode] = useState<StockMode>("bracket");
  const [region, setRegion] = useState<Region>("EU");
  const [brackets, setBrackets] = useState<BracketRow[] | null>(null);
  const [featured, setFeatured] = useState<FeaturedSkinRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string>("");
  const [query, setQuery] = useState<string>("");

  const loadBrackets = useCallback(() => {
    fetch("/api/stock/brackets")
      .then((r) => r.json())
      .then((d) => setBrackets(d.brackets ?? []))
      .catch(() => setBrackets([]));
  }, []);

  const loadFeatured = useCallback((r: Region) => {
    setFeatured(null);
    fetch(`/api/stock/featured-skins?region=${r}`)
      .then((res) => res.json())
      .then((d) => setFeatured(d.skins ?? []))
      .catch(() => setFeatured([]));
  }, []);

  useEffect(() => { loadBrackets(); }, [loadBrackets]);
  useEffect(() => { loadFeatured(region); }, [region, loadFeatured]);

  const totalsByRegion: Partial<Record<Region, number>> = {};
  for (const row of brackets ?? []) {
    totalsByRegion[row.region] = (totalsByRegion[row.region] ?? 0) + row.available;
  }

  const visibleBrackets = (brackets ?? []).filter((b) => b.region === region);
  const visibleSkins = (featured ?? []).filter((s) =>
    query ? s.label.toLowerCase().includes(query.toLowerCase()) ||
             s.weapon.toLowerCase().includes(query.toLowerCase())
          : true
  );
  const regionTotal = visibleBrackets.reduce((a, b) => a + b.available, 0);

  const subDiscountPct =
    me.sub?.tier === "ultra" ? 30 :
    me.sub?.tier === "premium" ? 20 :
    me.sub?.tier === "standard" ? 10 : 0;

  async function buyBracket(bracket: string) {
    setBusy(`b:${bracket}`);
    setErr("");
    try {
      const res = await fetch("/api/stock/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ region, bracket, useCredit: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "something went wrong");
      if (data.invoiceUrl) window.location.href = data.invoiceUrl;
      else window.location.href = `/orders/${data.orderId}`;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function buySkin(label: string) {
    setBusy(`s:${label}`);
    setErr("");
    try {
      const res = await fetch("/api/stock/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ region, skin: label, useCredit: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "something went wrong");
      if (data.invoiceUrl) window.location.href = data.invoiceUrl;
      else window.location.href = `/orders/${data.orderId}`;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr",
        gap: "16px",
      }}
    >
      <section
        className="pn cut"
        style={{
          padding: "18px 20px 20px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
        }}
      >
        {/* Mode + region segmented controls */}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            gap: "12px",
            flexWrap: "wrap",
          }}
        >
          <div className="seg" role="group" aria-label="What to buy">
            <button
              className={mode === "bracket" ? "on" : ""}
              onClick={() => setMode("bracket")}
            >
              Random account · skin bracket
            </button>
            <button
              className={mode === "skin" ? "on" : ""}
              onClick={() => setMode("skin")}
            >
              Guaranteed skin · named drops
            </button>
          </div>
          <div className="seg cy" role="group" aria-label="Region">
            {REGIONS.map((r) => (
              <button
                key={r}
                className={region === r ? "on" : ""}
                onClick={() => setRegion(r)}
              >
                {REGION_NAME[r]}{" "}
                <span className="c num">{totalsByRegion[r] ?? 0}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Headline + search */}
        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          <span className="h num" style={{ fontSize: "28px" }}>
            {mode === "bracket" ? regionTotal : visibleSkins.length}{" "}
            <span style={{ color: "var(--vu-mute)", fontSize: "20px" }}>
              {mode === "bracket" ? "accounts" : "matching skins"} · {REGION_NAME[region]}
            </span>
          </span>
          {subDiscountPct > 0 && (
            <span className="pill g">
              {me.sub ? TIER_LABEL[me.sub.tier] : ""} −{subDiscountPct}% applied
            </span>
          )}
          <div style={{ flex: 1, minWidth: 12 }} />
          {mode === "skin" && (
            <div style={{ position: "relative", width: "230px", maxWidth: "100%" }}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="#8b97a5"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                style={{ position: "absolute", left: "10px", top: "11px", pointerEvents: "none" }}
              >
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              <input
                className="inp"
                type="search"
                placeholder="Search named skins…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                style={{ height: "38px", paddingLeft: "34px" }}
                aria-label="Search skins"
              />
            </div>
          )}
        </div>

        {err && (
          <div
            style={{
              padding: "10px 14px",
              background: "#ffe4e6",
              color: "var(--accent-rose)",
              fontSize: "13px",
            }}
          >
            {err}
          </div>
        )}

        {/* BRACKET MODE */}
        {mode === "bracket" && (
          <>
            {brackets === null ? (
              <SkeletonGrid rows={2} cols={3} />
            ) : visibleBrackets.every((b) => b.available === 0) ? (
              <EmptyState region={region} />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                  gap: "10px",
                }}
              >
                {visibleBrackets.map((b) => (
                  <BracketTile
                    key={b.bracket}
                    row={b}
                    busy={busy === `b:${b.bracket}`}
                    onBuy={() => buyBracket(b.bracket)}
                  />
                ))}
              </div>
            )}
            <p
              className="mut num"
              style={{
                fontSize: "12px",
                marginTop: "4px",
                textAlign: "center",
              }}
            >
              A random full-access account from the chosen bracket is delivered after payment
              confirms on-chain. All accounts come with the original email so you can lock them down.
            </p>
          </>
        )}

        {/* SKIN MODE */}
        {mode === "skin" && (
          <>
            {featured === null ? (
              <SkeletonGrid rows={2} cols={3} />
            ) : visibleSkins.length === 0 ? (
              <EmptyState region={region} forSkins />
            ) : (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
                  gap: "10px",
                }}
              >
                {visibleSkins.map((s) => (
                  <SkinTile
                    key={s.key}
                    row={s}
                    busy={busy === `s:${s.label}`}
                    onBuy={() => buySkin(s.label)}
                  />
                ))}
              </div>
            )}
            <p className="mut" style={{ fontSize: "12px", marginTop: "4px", textAlign: "center" }}>
              Price is based on the cheapest available account that has the skin, and updates as
              stock turns over. You get a full-access account with the named skin guaranteed.
            </p>
          </>
        )}
      </section>
    </div>
  );
}

function BracketTile({
  row,
  busy,
  onBuy,
}: {
  row: BracketRow;
  busy: boolean;
  onBuy: () => void;
}) {
  const soldOut = row.available === 0;
  const hasDiscount = row.price.discountPct > 0;
  return (
    <button
      disabled={soldOut}
      onClick={onBuy}
      className="tile cs lift"
      style={{
        ["--tc" as string]: "var(--vu-red)",
        padding: 0,
      }}
    >
      <span className="glow" />
      <span
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 10px 0",
        }}
      >
        <span className="bc" style={{ fontSize: "12px", fontWeight: 600, color: "var(--vu-ivory-dim)" }}>
          Skin bracket
        </span>
        <span className="rg">{row.region}</span>
      </span>
      <span
        style={{
          position: "relative",
          flex: 1,
          minHeight: "80px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "8px",
        }}
      >
        <span className="h num" style={{ fontSize: "34px", color: "#fff" }}>
          {row.label}
        </span>
      </span>
      <span className="strip" style={{ padding: "6px 10px" }}>
        <span style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {hasDiscount && !soldOut && (
            <span
              className="num"
              style={{
                textDecoration: "line-through",
                color: "var(--vu-mute-soft)",
                fontSize: "11px",
              }}
            >
              {eur(row.price.publicCents)}
            </span>
          )}
          <span className="bc num" style={{ fontWeight: 700, fontSize: "18px", color: "#fff" }}>
            {soldOut ? "—" : eur(row.price.finalCents)}
          </span>
        </span>
        <span
          className={`stk ${soldOut ? "out" : row.available < 3 ? "low" : "ok"}`}
        >
          {busy ? "…" : soldOut ? "SOLD OUT" : row.available < 3 ? `${row.available} left` : `${row.available} in stock`}
        </span>
      </span>
    </button>
  );
}

function SkinTile({
  row,
  busy,
  onBuy,
}: {
  row: FeaturedSkinRow;
  busy: boolean;
  onBuy: () => void;
}) {
  const soldOut = row.available === 0;
  const hasDiscount = row.discountPct > 0;
  return (
    <button
      disabled={soldOut}
      onClick={onBuy}
      className="tile cs lift"
      style={{
        ["--tc" as string]: "var(--tier-premium)",
        padding: 0,
      }}
    >
      <span className="glow" />
      <span
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 10px 0",
        }}
      >
        <span
          className="bc"
          style={{ fontSize: "12px", fontWeight: 600, color: "var(--tier-premium)" }}
        >
          {row.weapon}
        </span>
        <span className="rg">EU</span>
      </span>
      <span
        style={{
          position: "relative",
          flex: 1,
          minHeight: "80px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "12px",
        }}
      >
        <span className="h" style={{ fontSize: "22px", color: "#fff", textAlign: "center" }}>
          {row.label}
        </span>
      </span>
      <span className="strip" style={{ padding: "6px 10px" }}>
        <span style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
          {hasDiscount && !soldOut && (
            <span
              className="num"
              style={{
                textDecoration: "line-through",
                color: "var(--vu-mute-soft)",
                fontSize: "11px",
              }}
            >
              {eur(row.publicCents)}
            </span>
          )}
          <span className="bc num" style={{ fontWeight: 700, fontSize: "18px", color: "#fff" }}>
            {soldOut ? "—" : eur(row.finalCents)}
          </span>
        </span>
        <span className={`stk ${soldOut ? "out" : row.available < 3 ? "low" : "ok"}`}>
          {busy ? "…" : soldOut ? "N/A" : `${row.available} match`}
        </span>
      </span>
    </button>
  );
}

function EmptyState({ region, forSkins = false }: { region: Region; forSkins?: boolean }) {
  return (
    <div
      className="cut"
      style={{
        padding: "60px 40px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "10px",
        textAlign: "center",
        background: "var(--vu-navy)",
        color: "var(--vu-ivory)",
      }}
    >
      <span className="h" style={{ fontSize: "44px", color: "var(--vu-red)" }}>
        0
      </span>
      <span className="h" style={{ fontSize: "24px" }}>
        {forSkins ? `No matching skins in ${REGION_NAME[region]}` : `No stock in ${REGION_NAME[region]}`}
      </span>
      <span style={{ color: "var(--vu-ivory-dim)" }}>
        Supplier stock refreshes every 5 minutes. Check back soon or try another region.
      </span>
    </div>
  );
}

function SkeletonGrid({ rows, cols }: { rows: number; cols: number }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gap: "10px",
      }}
    >
      {Array.from({ length: rows * cols }).map((_, i) => (
        <div key={i} className="skel cs" style={{ aspectRatio: "1.6 / 1" }} />
      ))}
    </div>
  );
}

// ================================================================
// Subscribe tab
// ================================================================

type TierSpec = {
  tier: Tier;
  name: string;
  priceCents: number;
  color: string;
  tagline: string;
  perks: string[];
  badge?: string;
  featured?: boolean;
};

const TIER_CARDS: TierSpec[] = [
  {
    tier: "standard",
    name: "Standard",
    priceCents: 999,
    color: TIER_COLOR.standard,
    tagline: "The toolkit — cheaper accounts + the method.",
    perks: ["10% off every account", "Discord + written method", "Monthly drops channel access"],
  },
  {
    tier: "premium",
    name: "Premium",
    priceCents: 2499,
    color: TIER_COLOR.premium,
    tagline: "See the drops first.",
    badge: "Most popular",
    featured: true,
    perks: [
      "20% off every account",
      "Server-side email delivery (no bookmarklet needed)",
      "2-hour early access on new drops",
      "Custom stock alerts (/snipe)",
    ],
  },
  {
    tier: "ultra",
    name: "Ultra",
    priceCents: 5999,
    color: TIER_COLOR.ultra,
    tagline: "Pick the exact account you want.",
    badge: "Best value",
    perks: [
      "30% off every account",
      "⚡ X-RAY — see every skin before you buy",
      "Auto-buy matching drops",
      "Priority replacement handling",
    ],
  },
];

function SubscribeTab({ me, reload }: { me: Me; reload: () => void }) {
  const [busy, setBusy] = useState<Tier | null>(null);
  const [err, setErr] = useState<string>("");

  async function subscribe(tier: Tier) {
    setBusy(tier);
    setErr("");
    try {
      const res = await fetch("/api/sub/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "something went wrong");
      window.location.href = data.invoiceUrl;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!confirm("Cancel your subscription? Your tier stays active until the end of the paid month.")) return;
    const res = await fetch("/api/sub/cancel", { method: "POST" });
    if (res.ok) reload();
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {me.sub && (
        <section
          className="pn cut"
          style={{
            padding: "20px 24px",
            borderLeft: `4px solid ${TIER_COLOR[me.sub.tier]}`,
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              flexWrap: "wrap",
              gap: "16px",
            }}
          >
            <div>
              <span className="lbl">Current plan</span>
              <div
                className="h"
                style={{ fontSize: "28px", color: TIER_COLOR[me.sub.tier], marginTop: "4px" }}
              >
                {TIER_LABEL[me.sub.tier]}
              </div>
            </div>
            <div>
              <span className="lbl">
                {me.sub.status === "grace" ? "Grace ends" : "Renews"}
              </span>
              <div className="num" style={{ fontSize: "20px", fontWeight: 700, marginTop: "4px" }}>
                {new Date(me.sub.periodEnd).toLocaleDateString()}
              </div>
            </div>
            <button
              className="btn btn-soft cs"
              onClick={cancel}
              disabled={busy !== null}
            >
              Cancel
            </button>
          </div>
        </section>
      )}

      {err && (
        <div style={{ padding: "10px 14px", background: "#ffe4e6", color: "var(--accent-rose)" }}>
          {err}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: "20px",
          alignItems: "stretch",
        }}
      >
        {TIER_CARDS.map((t) => {
          const isCurrent =
            me.sub?.tier === t.tier &&
            (me.sub.status === "active" || me.sub.status === "grace");
          return (
            <section
              key={t.tier}
              className={`pn cut lift ${t.featured ? "feat" : ""}`}
              style={{
                padding: "28px 24px",
                display: "flex",
                flexDirection: "column",
                gap: "14px",
                borderTop: `6px solid ${t.color}`,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <span className="lbl" style={{ color: t.color }}>
                    {t.name}
                  </span>
                  <div className="h" style={{ fontSize: "44px", marginTop: "4px" }}>
                    {eur(t.priceCents)}
                    <span className="mut bc" style={{ fontSize: "14px", marginLeft: "6px" }}>
                      / month
                    </span>
                  </div>
                </div>
                {t.badge && (
                  <span
                    className="bc"
                    style={{
                      background: t.color,
                      color: "var(--vu-navy)",
                      padding: "3px 10px",
                      fontSize: "12px",
                      fontWeight: 700,
                    }}
                  >
                    {t.badge}
                  </span>
                )}
              </div>
              <p className="mut" style={{ fontSize: "14px", margin: 0, minHeight: "40px" }}>
                {t.tagline}
              </p>
              <ul
                style={{
                  listStyle: "none",
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  flexDirection: "column",
                  gap: "8px",
                }}
              >
                {t.perks.map((p) => (
                  <li key={p} style={{ display: "flex", alignItems: "flex-start", gap: "8px" }}>
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={t.color}
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      style={{ marginTop: "3px", flex: "none" }}
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                    <span style={{ fontSize: "14px" }}>{p}</span>
                  </li>
                ))}
              </ul>
              <div style={{ flex: 1 }} />
              <button
                className="btn btn-lg cut"
                disabled={busy === t.tier || isCurrent}
                onClick={() => subscribe(t.tier)}
                style={{
                  background: isCurrent ? "var(--vu-divider-strong)" : t.color,
                  color: isCurrent ? "var(--vu-mute)" : "var(--vu-navy)",
                }}
              >
                {isCurrent ? "Current plan" : busy === t.tier ? "…" : `Get ${t.name}`}
              </button>
            </section>
          );
        })}
      </div>
      <p className="mut" style={{ fontSize: "12px", marginTop: "4px", textAlign: "center" }}>
        Monthly, in crypto. Cancel anytime — tier stays until the end of the paid month.
      </p>
    </div>
  );
}

// ================================================================
// Purchases tab
// ================================================================

function PurchasesTab() {
  const [orders, setOrders] = useState<Order[] | null>(null);

  useEffect(() => {
    fetch("/api/orders")
      .then((r) => r.json())
      .then((d) => setOrders(Array.isArray(d) ? d : d.orders ?? []))
      .catch(() => setOrders([]));
  }, []);

  if (orders === null) {
    return (
      <div style={{ padding: "40px", textAlign: "center" }} className="bc mut">
        Loading…
      </div>
    );
  }
  if (orders.length === 0) {
    return (
      <section className="pn cut" style={{ padding: "60px 40px", textAlign: "center" }}>
        <span className="lbl">Your orders</span>
        <div className="h" style={{ fontSize: "28px", marginTop: "12px" }}>
          No purchases yet
        </div>
        <p className="mut" style={{ marginTop: "8px" }}>
          Head to the <b>Stock</b> tab to grab your first account.
        </p>
      </section>
    );
  }

  return (
    <section className="pn cut" style={{ padding: "18px 20px" }}>
      <span className="lbl">Your orders</span>
      <table className="tbl click" style={{ marginTop: "12px" }}>
        <thead>
          <tr>
            <th>Account</th>
            <th>Region</th>
            <th>Date</th>
            <th>Price</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr
              key={o.id}
              onClick={() => (window.location.href = `/orders/${o.id}`)}
            >
              <td>{o.products?.name ?? "Random account"}</td>
              <td className="mut">{o.products?.region ?? "—"}</td>
              <td className="mut num">
                {new Date(o.created_at).toLocaleDateString()}
              </td>
              <td className="num" style={{ fontWeight: 600 }}>
                {eur(o.price_cents)}
              </td>
              <td>
                <span className={`pill ${orderPillClass(o.status)}`}>
                  {o.status.replace("_", " ")}
                </span>
              </td>
              <td>
                <a href={`/orders/${o.id}`} className="bc" style={{ fontWeight: 700, color: "var(--accent-link)" }}>
                  View →
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function orderPillClass(status: string): string {
  switch (status) {
    case "delivered": return "g";
    case "pending":
    case "awaiting_payment": return "a";
    case "failed": return "r";
    case "refunded": return "b";
    default: return "x";
  }
}

// ================================================================
// X-RAY tab (Ultra-only)
// ================================================================

function XrayTab({ isUltra }: { isUltra: boolean }) {
  if (!isUltra) {
    return (
      <section
        className="pn cut"
        style={{
          padding: "60px 40px",
          textAlign: "center",
          borderTop: "6px solid #ffd400",
        }}
      >
        <span className="lbl" style={{ color: "#ffd400" }}>
          Ultra only
        </span>
        <div className="h" style={{ fontSize: "36px", marginTop: "12px" }}>
          ⚡ X-RAY
        </div>
        <p className="mut" style={{ marginTop: "8px", maxWidth: "440px", margin: "8px auto 20px" }}>
          See every skin on every account before you buy it. Ultra members can
          inspect the full inventory, pick a specific account, and auto-buy.
        </p>
        <a
          href="?tab=subscribe"
          className="btn btn-gold cut"
          style={{ height: "48px", padding: "0 32px" }}
        >
          Upgrade to Ultra
        </a>
      </section>
    );
  }

  return (
    <section className="pn cut" style={{ padding: "20px 24px" }}>
      <span className="lbl" style={{ color: "#ffd400" }}>
        ⚡ X-RAY · account inspector
      </span>
      <p className="mut" style={{ marginTop: "8px" }}>
        Full inventory search is coming next — pick an account by its exact
        skinset. Meanwhile, this tab is reserved for Ultra members.
      </p>
    </section>
  );
}

// ================================================================
// Admin tab (minimal, same as before)
// ================================================================

function AdminTab() {
  return (
    <section className="pn cut" style={{ padding: "20px 24px" }}>
      <span className="lbl">Admin</span>
      <p className="mut" style={{ marginTop: "8px" }}>
        Admin controls — manage credit grants, review orders, trigger qvsp sync.
      </p>
    </section>
  );
}
