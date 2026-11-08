"use client";
// Dashboard — the ONLY signed-in page. Middleware gates every route behind
// Discord OAuth, so if we're here we're signed in.
//
// Layout follows the designer's Main artboard: single-viewport-height,
// no page scroll. Header strip → live feed → main area with left-list +
// right-checkout panel. Tabs switch the main area contents without changing
// the shell.

import { useCallback, useEffect, useMemo, useState } from "react";
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

const TIER_DISCOUNT_PCT: Record<Tier, number> = {
  standard: 10,
  premium:  20,
  ultra:    30,
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

const eur = (c: number) => (c / 100).toFixed(2);

// Sample live feed until /api/public-stats exists.
const SAMPLE_FEED = [
  { u: "cyph3r",   item: "Reaver Vandal",       t: "just now", c: "#d1548d" },
  { u: "blitz_",   item: "Prime Vandal",        t: "2m ago",   c: "#d1548d" },
  { u: "neko",     item: "26–50 skins · EU", t: "5m ago", c: "#ece8e1" },
  { u: "veyl",     item: "Elderflame Vandal",   t: "8m ago",   c: "#fad663" },
  { u: "ayva",     item: "Oni Phantom",         t: "11m ago",  c: "#d1548d" },
  { u: "mirai",    item: "Araxys Operator",     t: "14m ago",  c: "#f5955b" },
  { u: "hollow",   item: "51–100 skins · AP", t: "17m ago", c: "#ece8e1" },
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
        height: "100vh",
        minHeight: "600px",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <Header me={me} tab={tab} onTab={setTab} isUltra={isUltra} />

      <main
        style={{
          flex: 1,
          minHeight: 0,
          width: "100%",
          padding: "18px 24px",
        }}
      >
        {tab === "stock" && <StockTab me={me} />}
        {tab === "subscribe" && (
          <SubscribeTab me={me} reload={() => window.location.reload()} />
        )}
        {tab === "purchases" && <PurchasesTab />}
        {tab === "xray" && <XrayTab isUltra={isUltra} onSub={() => setTab("subscribe")} />}
        {tab === "admin" && me.isAdmin && <AdminTab />}
      </main>
    </div>
  );
}

// ================================================================
// Header
// ================================================================

function Header({
  me, tab, onTab, isUltra,
}: { me: Me; tab: TabKey; onTab: (t: TabKey) => void; isUltra: boolean }) {
  const feed = SAMPLE_FEED.concat(SAMPLE_FEED);
  const subDaysLeft = me.sub
    ? Math.max(0, Math.floor(
        (new Date(me.sub.periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      ))
    : null;
  const subPips = Array.from({ length: 10 }).map((_, i) => {
    const progress = subDaysLeft != null ? Math.ceil((subDaysLeft / 30) * 10) : 0;
    return i < progress;
  });
  const tierColor = me.sub ? TIER_COLOR[me.sub.tier] : null;

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
            { key: "stock",      label: "Stock",         ultra: false },
            { key: "subscribe",  label: "Subscribe",     ultra: false },
            { key: "purchases",  label: "My Purchases",  ultra: false },
            { key: "xray",       label: isUltra ? "⚡ X-RAY" : "🔒 X-RAY", ultra: true },
          ] as const).map((t) => (
            <button
              key={t.key}
              className={`${tab === t.key ? "on" : ""} ${t.ultra ? "ul" : ""}`}
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
                <span className="bc" style={{ fontWeight: 700, fontSize: "15px", color: "#fff", letterSpacing: "0.08em", lineHeight: 1 }}>
                  {TIER_LABEL[me.sub.tier]}
                </span>
                <span className="bc num" style={{ fontWeight: 600, fontSize: "13px", color: tierColor, lineHeight: 1 }}>
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
              €{eur(me.creditCents)}
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
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
type Selected =
  | { kind: "bracket"; row: BracketRow }
  | { kind: "skin";    row: FeaturedSkinRow };

function StockTab({ me }: { me: Me }) {
  const [mode, setMode] = useState<StockMode>("bracket");
  const [region, setRegion] = useState<Region>("EU");
  const [brackets, setBrackets] = useState<BracketRow[] | null>(null);
  const [featured, setFeatured] = useState<FeaturedSkinRow[] | null>(null);
  const [sel, setSel] = useState<Selected | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [useCredit, setUseCredit] = useState(true);
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

  // Clear selection when switching mode/region
  useEffect(() => { setSel(null); }, [mode, region]);

  const totalsByRegion: Partial<Record<Region, number>> = {};
  for (const row of brackets ?? []) {
    totalsByRegion[row.region] = (totalsByRegion[row.region] ?? 0) + row.available;
  }

  const visibleBrackets = (brackets ?? []).filter((b) => b.region === region);
  const visibleSkins = (featured ?? []).filter((s) =>
    query
      ? s.label.toLowerCase().includes(query.toLowerCase()) ||
        s.weapon.toLowerCase().includes(query.toLowerCase())
      : true
  );
  const regionTotal = visibleBrackets.reduce((a, b) => a + b.available, 0);

  const subDiscountPct = me.sub ? TIER_DISCOUNT_PCT[me.sub.tier] : 0;

  async function buyNow() {
    if (!sel) return;
    setBusy(true);
    setErr("");
    try {
      const body =
        sel.kind === "bracket"
          ? { region, bracket: sel.row.bracket, useCredit }
          : { region, skin: sel.row.label, useCredit };
      const res = await fetch("/api/stock/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "something went wrong");
      if (data.invoiceUrl) window.location.href = data.invoiceUrl;
      else window.location.href = `/orders/${data.orderId}`;
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const selDisplay = useMemo(() => {
    if (!sel) return null;
    if (sel.kind === "bracket") {
      return {
        kind: "bracket" as const,
        range: sel.row.label,
        tc: "var(--vu-red)",
        name: `${sel.row.label} skins`,
        oldCents: sel.row.price.publicCents,
        finalCents: sel.row.price.finalCents,
        saveCents: sel.row.price.savingsCents,
        stock: sel.row.available,
      };
    }
    return {
      kind: "skin" as const,
      name: `${sel.row.label} ${sel.row.weapon}`,
      tc: "var(--tier-premium)",
      oldCents: sel.row.publicCents,
      finalCents: sel.row.finalCents,
      saveCents: sel.row.savingsCents,
      stock: sel.row.available,
    };
  }, [sel]);

  const creditAvailable = me.creditCents;
  const creditUsed = selDisplay && useCredit
    ? Math.min(creditAvailable, selDisplay.finalCents)
    : 0;
  const dueCents = selDisplay ? Math.max(0, selDisplay.finalCents - creditUsed) : 0;

  return (
    <div
      style={{
        height: "100%",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr) 350px",
        gap: "16px",
      }}
    >
      {/* Left: list */}
      <section
        className="pn cut"
        style={{
          padding: "18px 20px 20px",
          display: "flex",
          flexDirection: "column",
          gap: "14px",
          minHeight: 0,
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

        {/* Headline row */}
        <div style={{ display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap" }}>
          <span className="h num" style={{ fontSize: "28px" }}>
            {mode === "bracket" ? regionTotal : visibleSkins.length}{" "}
            <span style={{ color: "var(--vu-mute)", fontSize: "20px" }}>
              {mode === "bracket" ? "accounts" : "matching skins"} · {REGION_NAME[region]}
            </span>
          </span>
          {subDiscountPct > 0 && me.sub && (
            <span className="pill g">
              {TIER_LABEL[me.sub.tier]} −{subDiscountPct}% applied
            </span>
          )}
          <div style={{ flex: 1, minWidth: 12 }} />
          {mode === "skin" && (
            <div style={{ position: "relative", width: "230px", maxWidth: "100%" }}>
              <svg
                width="16" height="16" viewBox="0 0 24 24" fill="none"
                stroke="#8b97a5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
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
          <div style={{ padding: "10px 14px", background: "#ffe4e6", color: "var(--accent-rose)", fontSize: "13px" }}>
            {err}
          </div>
        )}

        {/* GRID: fills remaining space, scrolls if overflowing */}
        <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
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
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                    gridAutoRows: "minmax(180px, 1fr)",
                    gap: "10px",
                  }}
                >
                  {visibleBrackets.map((b) => (
                    <BracketTile
                      key={b.bracket}
                      row={b}
                      region={region}
                      selected={sel?.kind === "bracket" && sel.row.bracket === b.bracket}
                      onPick={() => setSel({ kind: "bracket", row: b })}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {mode === "skin" && (
            <>
              {featured === null ? (
                <SkeletonGrid rows={2} cols={4} />
              ) : visibleSkins.length === 0 ? (
                <EmptyState region={region} forSkins />
              ) : (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                    gridAutoRows: "minmax(160px, 1fr)",
                    gap: "10px",
                  }}
                >
                  {visibleSkins.map((s) => (
                    <SkinTile
                      key={s.key}
                      row={s}
                      region={region}
                      selected={sel?.kind === "skin" && sel.row.label === s.label}
                      onPick={() => setSel({ kind: "skin", row: s })}
                    />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Right: checkout panel */}
      <aside
        className="pn cut"
        style={{
          padding: "18px",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        {!selDisplay && (
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              textAlign: "center",
              padding: "24px",
            }}
            className="mut"
          >
            Select an item to see the price breakdown.
          </div>
        )}

        {selDisplay && (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: "12px" }}>
            {/* Hero */}
            <div
              className="cut"
              style={{
                position: "relative",
                height: "clamp(90px, 18vh, 150px)",
                flex: "none",
                background: "var(--vu-navy-tile)",
                overflow: "hidden",
                ["--tc" as string]: selDisplay.tc,
              }}
            >
              <span
                style={{
                  position: "absolute",
                  inset: 0,
                  background: `linear-gradient(to top, ${selDisplay.tc} -30%, transparent 70%)`,
                  opacity: 0.7,
                }}
              />
              {selDisplay.kind === "bracket" ? (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                  }}
                >
                  <span className="h num" style={{ fontSize: "56px" }}>{selDisplay.range}</span>
                  <span className="bc" style={{ color: "var(--vu-ivory-dim)", fontSize: "16px" }}>
                    Skins · random account
                  </span>
                </div>
              ) : (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "#fff",
                    padding: "16px",
                  }}
                >
                  <span className="h" style={{ fontSize: "28px", textAlign: "center" }}>{selDisplay.name}</span>
                </div>
              )}
            </div>

            {/* Title + region */}
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "flex-end",
                gap: "8px",
              }}
            >
              <span className="h" style={{ fontSize: "22px" }}>{selDisplay.name}</span>
              <span className="rg" style={{ background: "var(--vu-navy)" }}>{region}</span>
            </div>

            {/* Breakdown */}
            <div style={{ background: "var(--vu-surface-alt)", padding: "2px 12px" }}>
              <div className="kv">
                <span className="mut">List price</span>
                <span className="num mut" style={{ textDecoration: "line-through" }}>
                  €{eur(selDisplay.oldCents)}
                </span>
              </div>
              {subDiscountPct > 0 && me.sub && (
                <div className="kv">
                  <span style={{ color: "var(--accent-success)", fontWeight: 500 }}>
                    {TIER_LABEL[me.sub.tier]} −{subDiscountPct}%
                  </span>
                  <span className="num" style={{ color: "var(--accent-success)", fontWeight: 600 }}>
                    −€{eur(selDisplay.saveCents)}
                  </span>
                </div>
              )}
              {useCredit && creditUsed > 0 && (
                <div className="kv">
                  <span style={{ color: "#a16207", fontWeight: 500 }}>Store credit</span>
                  <span className="num" style={{ color: "#a16207", fontWeight: 600 }}>
                    −€{eur(creditUsed)}
                  </span>
                </div>
              )}
              <div className="kv" style={{ borderTop: "1px solid var(--vu-divider-strong)", height: "46px" }}>
                <span className="bc" style={{ fontWeight: 700, fontSize: "16px" }}>Due now</span>
                <span className="h num" style={{ fontSize: "32px" }}>€{eur(dueCents)}</span>
              </div>
            </div>

            {/* Credit toggle */}
            {creditAvailable > 0 && (
              <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
                <button
                  className={`sw ${useCredit ? "on" : ""}`}
                  role="switch"
                  aria-checked={useCredit}
                  aria-label="Use store credit"
                  onClick={() => setUseCredit((v) => !v)}
                />
                <span style={{ flex: 1 }}>
                  Use store credit{" "}
                  <span className="num mut">(€{eur(creditAvailable)})</span>
                </span>
                <span className="mut num" style={{ fontSize: "12px" }}>
                  {selDisplay.stock} in stock
                </span>
              </div>
            )}

            <div style={{ flex: 1 }} />

            <button
              className="btn btn-red btn-lg cut"
              onClick={buyNow}
              disabled={busy || selDisplay.stock === 0}
            >
              {busy ? "…" : selDisplay.stock === 0 ? "Sold out" : `Buy — €${eur(dueCents)}`}
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

function BracketTile({
  row, region, selected, onPick,
}: {
  row: BracketRow;
  region: Region;
  selected: boolean;
  onPick: () => void;
}) {
  const soldOut = row.available === 0;
  const hasDiscount = row.price.discountPct > 0;
  return (
    <button
      disabled={soldOut}
      onClick={onPick}
      className={`tile cs ${selected ? "on" : ""}`}
      style={{ ["--tc" as string]: "var(--vu-red)" }}
      aria-label={`${row.label} skins`}
    >
      <span className="glow" />
      <span
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 12px 0",
        }}
      >
        <span className="bc" style={{ fontSize: "13px", fontWeight: 600, color: "var(--vu-ivory-dim)" }}>
          Random account
        </span>
        <span className="rg">{region}</span>
      </span>
      <span
        style={{
          position: "relative",
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <span className="h num" style={{ fontSize: "52px", color: "#fff" }}>
          {row.label}
        </span>
        <span className="bc" style={{ fontSize: "15px", fontWeight: 600, color: "var(--vu-red)" }}>
          Skins
        </span>
      </span>
      <span
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "center",
          gap: "14px",
          padding: "0 0 8px",
          fontSize: "12px",
          color: "var(--vu-ivory-dim)",
        }}
      >
        <span>
          Available{" "}
          <b
            className="num"
            style={{ color: soldOut ? "#f87171" : row.available < 3 ? "#fcd34d" : "#86efac" }}
          >
            {row.available}
          </b>
        </span>
        <span>Delivery <b style={{ color: "#86efac" }}>Instant</b></span>
      </span>
      <span className="strip">
        <span className="num" style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
          <span className="bc" style={{ fontWeight: 700, fontSize: "22px", color: "#fff" }}>
            €{eur(row.price.finalCents)}
          </span>
          {hasDiscount && (
            <span style={{ fontSize: "12px", color: "var(--vu-mute-soft)", textDecoration: "line-through" }}>
              €{eur(row.price.publicCents)}
            </span>
          )}
        </span>
        {hasDiscount && !soldOut && (
          <span className="stk ok">−{Math.round(row.price.discountPct * 100)}%</span>
        )}
      </span>
    </button>
  );
}

function SkinTile({
  row, region, selected, onPick,
}: {
  row: FeaturedSkinRow;
  region: Region;
  selected: boolean;
  onPick: () => void;
}) {
  const soldOut = row.available === 0;
  const hasDiscount = row.discountPct > 0;
  // Tier color: infer from skin name family
  const tc = row.label.includes("Elderflame") || row.label.includes("Araxys")
    ? "var(--tier-ultra)"
    : row.label.includes("Oni") || row.label.includes("Reaver") || row.label.includes("Prime")
    ? "var(--tier-premium)"
    : row.label.includes("RGX") || row.label.includes("Glitchpop")
    ? "var(--tier-exclusive)"
    : "var(--tier-standard)";

  return (
    <button
      disabled={soldOut}
      onClick={onPick}
      className={`tile cs ${selected ? "on" : ""}`}
      style={{ ["--tc" as string]: tc }}
      aria-label={`${row.label} ${row.weapon}, from €${eur(row.finalCents)}`}
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
        <span style={{ display: "inline-flex", alignItems: "center", gap: "5px" }}>
          <span className="bc" style={{ fontSize: "12px", fontWeight: 600, color: tc }}>
            {row.weapon}
          </span>
        </span>
        <span className="rg">{region}</span>
      </span>
      <span
        style={{
          position: "relative",
          flex: 1,
          minHeight: "34px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "2px 14px",
          textAlign: "center",
        }}
      >
        <span className="h" style={{ fontSize: "20px", color: "#fff", lineHeight: 1.1 }}>
          {row.label}
        </span>
      </span>
      <span
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "space-between",
          padding: "0 10px 6px",
          fontSize: "11px",
          color: "var(--vu-ivory-dim)",
        }}
      >
        <span>
          Matching stock{" "}
          <b
            className={`num stk ${soldOut ? "out" : row.available < 3 ? "low" : "ok"}`}
            style={{ padding: "1px 5px" }}
          >
            {row.available}
          </b>
        </span>
        <span>Instant</span>
      </span>
      <span className="strip">
        <span style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
          <span className="bc" style={{ fontSize: "11px", color: "var(--vu-ivory-dim)", lineHeight: 1.1 }}>
            {row.weapon}
          </span>
          <span
            className="bc"
            style={{
              fontWeight: 700,
              fontSize: "16px",
              color: "#fff",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              lineHeight: 1.1,
            }}
          >
            {row.label}
          </span>
        </span>
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
          <span className="bc" style={{ fontSize: "11px", color: "var(--vu-ivory-dim)", lineHeight: 1.1 }}>
            from
          </span>
          <span className="bc num" style={{ fontWeight: 700, fontSize: "20px", color: "#fff", lineHeight: 1.1 }}>
            €{eur(row.finalCents)}
          </span>
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
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: "10px",
        textAlign: "center",
        background: "var(--vu-navy)",
        color: "var(--vu-ivory)",
        padding: "40px",
      }}
    >
      <span className="h" style={{ fontSize: "44px", color: "var(--vu-red)" }}>0</span>
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
        gridAutoRows: "minmax(160px, 1fr)",
        gap: "10px",
      }}
    >
      {Array.from({ length: rows * cols }).map((_, i) => (
        <div key={i} className="skel cs" />
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
    perks: [
      "10% off every account",
      "Discord members channel",
      "Written method + guides",
      "Monthly drops feed",
    ],
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
      "Server-side email delivery",
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
      "⚡ X-RAY account inspector",
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

  async function renew() {
    setBusy(me.sub!.tier);
    try {
      const res = await fetch("/api/sub/renew", { method: "POST" });
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

  const currentTier = me.sub ? TIER_LABEL[me.sub.tier] : null;
  const renewDate = me.sub ? new Date(me.sub.periodEnd).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  }) : null;

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        gap: "22px",
      }}
    >
      {/* Current plan banner */}
      {me.sub && (
        <section
          className="cut"
          style={{
            flex: "none",
            padding: "14px 24px",
            display: "flex",
            alignItems: "center",
            gap: "32px",
            flexWrap: "wrap",
            background: "var(--vu-navy)",
            color: "var(--vu-ivory)",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span className="lbl" style={{ color: "var(--vu-ivory-dim)", fontSize: "12px" }}>
              Current plan
            </span>
            <span className="h" style={{ fontSize: "28px", color: TIER_COLOR[me.sub.tier] }}>
              {currentTier}
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <span className="lbl" style={{ color: "var(--vu-ivory-dim)", fontSize: "12px" }}>
              {me.sub.status === "grace" ? "Grace ends" : "Renews"}
            </span>
            <span className="bc num" style={{ fontSize: "22px", fontWeight: 700 }}>
              {renewDate}
            </span>
          </div>
          {me.creditCents > 0 && (
            <div style={{ display: "flex", flexDirection: "column" }}>
              <span className="lbl" style={{ color: "var(--vu-ivory-dim)", fontSize: "12px" }}>
                Store credit
              </span>
              <span className="bc num" style={{ fontSize: "22px", fontWeight: 700, color: "#ffd400" }}>
                €{eur(me.creditCents)}
              </span>
            </div>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn btn-red cs" onClick={renew} disabled={busy !== null}>
            Renew now
          </button>
          <button
            className="btn cs"
            style={{
              background: "transparent",
              color: "var(--vu-ivory-dim)",
              boxShadow: "inset 0 0 0 1px #34404d",
            }}
            onClick={cancel}
            disabled={busy !== null}
          >
            Cancel
          </button>
        </section>
      )}

      {err && (
        <div style={{ padding: "10px 14px", background: "#ffe4e6", color: "var(--accent-rose)" }}>
          {err}
        </div>
      )}

      {/* Tier cards */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: "16px",
          alignItems: "stretch",
        }}
      >
        {TIER_CARDS.map((t) => {
          const isCurrent =
            me.sub?.tier === t.tier &&
            (me.sub.status === "active" || me.sub.status === "grace");
          // 3-up metric strip math
          const saved30d = Math.round(t.priceCents * (TIER_DISCOUNT_PCT[t.tier] / 10) * 1.2); // rough est
          const breakevenCents = Math.round(t.priceCents / (TIER_DISCOUNT_PCT[t.tier] / 100));
          return (
            <section
              key={t.tier}
              className={`pn cut ${t.featured ? "feat" : "lift"}`}
              style={{
                display: "flex",
                flexDirection: "column",
                minHeight: 0,
                boxShadow: isCurrent
                  ? `inset 0 0 0 2px ${t.color}`
                  : t.featured
                  ? `inset 0 0 0 2px ${t.color}`
                  : "none",
              }}
            >
              {/* Header */}
              <div
                style={{
                  position: "relative",
                  overflow: "hidden",
                  background: "var(--vu-navy)",
                  color: "#fff",
                  padding: "16px 22px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "6px",
                  borderBottom: `3px solid ${t.color}`,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    position: "absolute",
                    right: "-30px",
                    top: "-20px",
                    width: "140px",
                    height: "140px",
                    background: t.color,
                    opacity: 0.12,
                    transform: "rotate(45deg)",
                  }}
                />
                <div
                  style={{
                    position: "relative",
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "8px",
                  }}
                >
                  <span className="h" style={{ fontSize: "26px", color: t.color, letterSpacing: "0.06em" }}>
                    {t.name}
                  </span>
                  <span style={{ display: "flex", gap: "4px" }}>
                    {isCurrent && (
                      <span className="bc" style={{ color: "#fff", fontWeight: 700, fontSize: "13px", background: "rgba(255,255,255,0.14)", padding: "2px 8px" }}>
                        Your plan
                      </span>
                    )}
                    {t.badge && !isCurrent && (
                      <span className="bc" style={{ color: "var(--vu-navy)", fontWeight: 700, fontSize: "13px", background: t.color, padding: "2px 8px" }}>
                        {t.badge}
                      </span>
                    )}
                  </span>
                </div>
                <div style={{ position: "relative", display: "flex", alignItems: "baseline", gap: "8px" }}>
                  <span className="h num" style={{ fontSize: "48px" }}>€{eur(t.priceCents)}</span>
                  <span style={{ color: "var(--vu-ivory-dim)" }}>/ month</span>
                </div>
                <span style={{ position: "relative", fontSize: "13px", color: "#cbd5e1" }}>
                  {t.tagline}
                </span>
              </div>

              {/* Body */}
              <div
                style={{
                  padding: "16px 22px 20px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "14px",
                  flex: 1,
                  minHeight: 0,
                }}
              >
                {/* 3-up metric strip */}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1.2fr) minmax(0, 1.1fr)",
                    background: "var(--vu-surface-alt)",
                    whiteSpace: "nowrap",
                  }}
                >
                  <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column" }}>
                    <span className="lbl" style={{ fontSize: "12px" }}>Discount</span>
                    <span className="bc num" style={{ fontSize: "26px", fontWeight: 700, color: "var(--accent-success)", lineHeight: 1.1 }}>
                      −{TIER_DISCOUNT_PCT[t.tier]}%
                    </span>
                  </div>
                  <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", borderLeft: "1px solid var(--vu-divider-strong)" }}>
                    <span className="lbl" style={{ fontSize: "12px" }}>On your 30d</span>
                    <span className="bc num" style={{ fontSize: "26px", fontWeight: 700, lineHeight: 1.1 }}>
                      −€{eur(saved30d)}
                    </span>
                  </div>
                  <div style={{ padding: "8px 12px", display: "flex", flexDirection: "column", borderLeft: "1px solid var(--vu-divider-strong)" }}>
                    <span className="lbl" style={{ fontSize: "12px" }}>Pays off at</span>
                    <span className="bc num" style={{ fontSize: "26px", fontWeight: 700, lineHeight: 1.1 }}>
                      €{eur(breakevenCents)}
                    </span>
                  </div>
                </div>

                {/* Perks */}
                <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                  {t.perks.map((p) => (
                    <div
                      key={p}
                      style={{ display: "flex", gap: "12px", alignItems: "center" }}
                    >
                      <span
                        className="cs"
                        aria-hidden="true"
                        style={{
                          width: "22px",
                          height: "22px",
                          flex: "none",
                          background: t.color,
                          color: "var(--vu-navy)",
                          display: "inline-flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M20 6 9 17l-5-5" />
                        </svg>
                      </span>
                      <span style={{ fontWeight: 500 }}>{p}</span>
                    </div>
                  ))}
                </div>

                <div style={{ flex: 1 }} />

                {isCurrent ? (
                  <button className="btn btn-lg cut" disabled>Current plan</button>
                ) : (
                  <button
                    className="btn btn-lg cut"
                    style={{ background: t.color, color: "var(--vu-navy)" }}
                    disabled={busy === t.tier}
                    onClick={() => subscribe(t.tier)}
                  >
                    {busy === t.tier ? "…" : `Get ${t.name}`}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
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

  const spent = (orders ?? []).reduce((a, o) => a + o.price_cents, 0);
  const deliveredCount = (orders ?? []).filter((o) => o.status === "delivered").length;

  if (orders === null) {
    return (
      <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <span className="bc mut">Loading…</span>
      </div>
    );
  }
  if (orders.length === 0) {
    return (
      <section
        className="pn cut"
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "8px",
          padding: "40px",
          textAlign: "center",
        }}
      >
        <span className="h" style={{ fontSize: "28px" }}>No purchases yet</span>
        <p className="mut">
          Head to the <b>Stock</b> tab to grab your first account.
        </p>
      </section>
    );
  }

  return (
    <section
      className="pn cut"
      style={{
        height: "100%",
        padding: "18px 0 0",
        display: "flex",
        flexDirection: "column",
        gap: "14px",
        minHeight: 0,
      }}
    >
      <div style={{ padding: "0 16px", display: "flex", gap: "28px", alignItems: "flex-end" }}>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="lbl" style={{ fontSize: "12px" }}>Orders</span>
          <span className="h num" style={{ fontSize: "32px" }}>{orders.length}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="lbl" style={{ fontSize: "12px" }}>Spent</span>
          <span className="h num" style={{ fontSize: "32px" }}>€{eur(spent)}</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <span className="lbl" style={{ fontSize: "12px" }}>Delivered</span>
          <span className="h num" style={{ fontSize: "32px", color: "var(--accent-success)" }}>{deliveredCount}</span>
        </div>
      </div>
      <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
        <table className="tbl click">
          <thead>
            <tr>
              <th style={{ paddingLeft: "16px" }}>Account</th>
              <th>Date</th>
              <th style={{ textAlign: "right" }}>Price</th>
              <th>Status</th>
              <th style={{ textAlign: "right", paddingRight: "16px" }}></th>
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => (
              <tr key={o.id} onClick={() => (window.location.href = `/orders/${o.id}`)}>
                <td style={{ paddingLeft: "16px" }}>
                  <span style={{ display: "flex", flexDirection: "column" }}>
                    <span className="bc" style={{ fontWeight: 700, fontSize: "17px", lineHeight: 1.1 }}>
                      {o.products?.name ?? "Random account"}
                    </span>
                    <span className="mut mono" style={{ fontSize: "11px" }}>
                      {o.id.slice(0, 8)} · {o.products?.region ?? "—"}
                    </span>
                  </span>
                </td>
                <td className="num mut">
                  {new Date(o.created_at).toLocaleDateString()}
                </td>
                <td className="bc num" style={{ textAlign: "right", fontWeight: 700, fontSize: "18px" }}>
                  €{eur(o.price_cents)}
                </td>
                <td>
                  <span className={`pill ${orderPillClass(o.status)}`}>
                    {o.status.replace("_", " ")}
                  </span>
                </td>
                <td style={{ textAlign: "right", paddingRight: "16px" }}>
                  <a href={`/orders/${o.id}`} className="bc" style={{ fontWeight: 700, color: "inherit" }}>
                    View →
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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

function XrayTab({ isUltra, onSub }: { isUltra: boolean; onSub: () => void }) {
  if (!isUltra) {
    return (
      <div
        style={{
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div
          className="cut"
          style={{
            width: "460px",
            maxWidth: "100%",
            padding: "28px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            background: "var(--vu-navy)",
            color: "var(--vu-ivory)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <span
              className="cs"
              style={{
                width: "44px",
                height: "44px",
                background: "#ffd400",
                color: "var(--vu-navy)",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="4" y="11" width="16" height="10" rx="1" />
                <path d="M8 11V7a4 4 0 0 1 8 0v4" />
              </svg>
            </span>
            <span className="h" style={{ fontSize: "30px", color: "#ffd400" }}>
              X-RAY is Ultra-only
            </span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            {[
              "See every skin on every account before you buy",
              "Pick the exact account you want",
              "Auto-buy accounts matching your filters",
              "Priority replacement handling",
            ].map((p) => (
              <span key={p} style={{ display: "flex", gap: "10px", alignItems: "center" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffd400" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {p}
              </span>
            ))}
          </div>
          <button className="btn btn-gold cut btn-lg" onClick={onSub}>
            Upgrade to Ultra — €59.99/mo
          </button>
        </div>
      </div>
    );
  }

  return (
    <section
      className="pn cut"
      style={{
        height: "100%",
        padding: "24px",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        gap: "12px",
        flexDirection: "column",
      }}
    >
      <span className="lbl" style={{ color: "#c9a800" }}>
        ⚡ X-RAY · account inspector
      </span>
      <span className="h" style={{ fontSize: "28px" }}>Coming next</span>
      <p className="mut" style={{ maxWidth: "440px" }}>
        Full inventory search is landing in the next phase — pick accounts by
        exact skinset, min skin count, rank, and region.
      </p>
    </section>
  );
}

// ================================================================
// Admin tab (minimal, same as before)
// ================================================================

function AdminTab() {
  return (
    <section className="pn cut" style={{ height: "100%", padding: "20px 24px" }}>
      <span className="lbl">Admin</span>
      <p className="mut" style={{ marginTop: "8px" }}>
        Admin controls — manage credit grants, review orders, trigger qvsp sync.
      </p>
    </section>
  );
}
