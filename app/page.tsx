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
  // Added phase 2.2: art from valorant-api.com
  icon?: string | null;
  tier?: string | null;        // "Premium" | "Ultra" | ...
  tierColor?: string | null;   // "#rrggbb"
  tierIcon?: string | null;    // small badge
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

type TabKey = "stock" | "subscribe" | "purchases" | "xray" | "autobuy" | "admin";

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
        {tab === "xray" && <XrayTab isUltra={isUltra} onSub={() => setTab("subscribe")} onOrders={() => setTab("purchases")} />}
        {tab === "autobuy" && <AutobuyTab me={me} isUltra={isUltra} onSub={() => setTab("subscribe")} />}
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
            { key: "autobuy",    label: isUltra ? "AUTO-BUY" : "🔒 AUTO-BUY", ultra: true },
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

const SKINS_PER_PAGE = 12;

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
  const [skinPage, setSkinPage] = useState<number>(0);
  // Weapon sub-tab filter inside the skin mode.
  // "" = Featured (top-tier curated-ish view: Ultra + Exclusive + a couple Premiums)
  // "Vandal" | "Phantom" | ... = exact weapon match
  // "Melee" = any knife / dagger / sword / karambit / kunai (not real "melee" weapon)
  const [weaponTab, setWeaponTab] = useState<string>("");

  const loadBrackets = useCallback(() => {
    fetch("/api/stock/brackets")
      .then((r) => r.json())
      .then((d) => setBrackets(d.brackets ?? []))
      .catch(() => setBrackets([]));
  }, []);

  const loadFeatured = useCallback((r: Region) => {
    setFeatured(null);
    // all-skins returns every named-tier skin in stock for the region,
    // sorted Ultra → Select then alphabetically. Heavier than the old
    // featured list (one query + N art lookups) but complete.
    fetch(`/api/stock/all-skins?region=${r}`)
      .then((res) => res.json())
      .then((d) => setFeatured(d.skins ?? []))
      .catch(() => setFeatured([]));
  }, []);

  useEffect(() => { loadBrackets(); }, [loadBrackets]);
  useEffect(() => { loadFeatured(region); }, [region, loadFeatured]);

  // Clear selection + reset pagination when switching mode/region
  useEffect(() => { setSel(null); setSkinPage(0); setWeaponTab(""); }, [mode, region]);
  // Reset pagination when the filter result set changes
  useEffect(() => { setSkinPage(0); }, [query, weaponTab]);

  const totalsByRegion: Partial<Record<Region, number>> = {};
  for (const row of brackets ?? []) {
    totalsByRegion[row.region] = (totalsByRegion[row.region] ?? 0) + row.available;
  }

  const visibleBrackets = (brackets ?? []).filter((b) => b.region === region);

  // Bracket auto-select — mirror the skin-grid behaviour: whenever the
  // bracket data loads for the current region, pick the first available
  // one so the checkout panel never sits empty.
  useEffect(() => {
    if (mode !== "bracket") return;
    if (sel && sel.kind === "bracket" && visibleBrackets.some((b) => b.bracket === sel.row.bracket)) return;
    const firstAvailable = visibleBrackets.find((b) => b.available > 0);
    if (firstAvailable) setSel({ kind: "bracket", row: firstAvailable });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, region, visibleBrackets.length, visibleBrackets[0]?.bracket]);

  // --- Skin tab filters: search + weapon sub-tab ---
  const MELEE_WEAPONS = ["Knife", "Melee", "Karambit", "Kunai", "Dagger", "Sword", "Claw", "Axe", "Blade"];
  function isMelee(weapon: string): boolean {
    return MELEE_WEAPONS.some((w) => weapon.toLowerCase().includes(w.toLowerCase()));
  }

  // Featured = top-tier skins across weapons (Ultra + Exclusive).
  // The designer's "Featured" tab was a curated highlight reel of the
  // 8 flashiest skins; we approximate by showing the highest-tier ones
  // first, which is already how /api/stock/all-skins sorts.
  function matchesWeaponTab(s: FeaturedSkinRow): boolean {
    if (!weaponTab) {
      // Featured: Ultra + Exclusive only
      return s.tier === "Ultra" || s.tier === "Exclusive";
    }
    if (weaponTab === "Melee") return isMelee(s.weapon);
    return s.weapon.toLowerCase() === weaponTab.toLowerCase();
  }

  const searchFiltered = (featured ?? []).filter((s) =>
    query
      ? s.label.toLowerCase().includes(query.toLowerCase()) ||
        s.weapon.toLowerCase().includes(query.toLowerCase())
      : true
  );
  const visibleSkins = searchFiltered.filter(matchesWeaponTab);

  // Weapon tab counts (post-search, so when you type "reaver" the counts
  // reflect what's actually matched).
  const weaponTabs: Array<{ label: string; count: number }> = [
    { label: "Featured", count: searchFiltered.filter((s) => s.tier === "Ultra" || s.tier === "Exclusive").length },
    { label: "Melee",    count: searchFiltered.filter((s) => isMelee(s.weapon)).length },
  ];
  const weaponsSeen = new Map<string, number>();
  for (const s of searchFiltered) {
    if (isMelee(s.weapon)) continue;
    weaponsSeen.set(s.weapon, (weaponsSeen.get(s.weapon) ?? 0) + 1);
  }
  const ORDERED_WEAPONS = ["Vandal", "Phantom", "Operator", "Sheriff", "Ghost", "Classic", "Spectre", "Bulldog", "Guardian", "Marshal", "Judge", "Bucky", "Stinger", "Ares", "Odin", "Shorty", "Frenzy", "Outlaw"];
  for (const w of ORDERED_WEAPONS) {
    const c = weaponsSeen.get(w);
    if (c && c > 0) weaponTabs.push({ label: w, count: c });
  }
  // Catch-all for weapons we didn't pre-order
  for (const [w, c] of weaponsSeen.entries()) {
    if (!ORDERED_WEAPONS.includes(w)) weaponTabs.push({ label: w, count: c });
  }

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
        range: bracketRange(sel.row.label),
        tc: bracketTierColor(sel.row.bracket),
        // Name shown in the title row under the hero. Just the range —
        // the hero already says "Skins · random account" so appending
        // "skins" again would read "1-25 Skins" (above) then "1-25 skins
        // skins" (below).
        name: `${sel.row.label} skins`,
        titleName: `${sel.row.label}`,      // ← used under the hero, no "skins" tail
        oldCents: sel.row.price.publicCents,
        finalCents: sel.row.price.finalCents,
        saveCents: sel.row.price.savingsCents,
        stock: sel.row.available,
        icon: null as string | null,
        tierIcon: null as string | null,
        tierLabel: null as string | null,
      };
    }
    // Skin name: if the label already ends with the weapon ("Prime Vandal"
    // + weapon "Vandal"), use the label alone to avoid "Prime Vandal Vandal".
    const skinName = sel.row.label.endsWith(` ${sel.row.weapon}`)
      ? sel.row.label
      : `${sel.row.label} ${sel.row.weapon}`;
    return {
      kind: "skin" as const,
      name: skinName,
      titleName: skinName,
      tc: sel.row.tierColor ?? "var(--tier-premium)",
      oldCents: sel.row.publicCents,
      finalCents: sel.row.finalCents,
      saveCents: sel.row.savingsCents,
      stock: sel.row.available,
      icon: sel.row.icon ?? null,
      tierIcon: sel.row.tierIcon ?? null,
      tierLabel: sel.row.tier ?? null,
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
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" }}>
              {/* Popular-query chips — one-click search shortcuts. Click
                  the active one to clear the search. */}
              {["champ", "kuro", "reaver"].map((q) => {
                const active = query.toLowerCase() === q;
                return (
                  <button
                    key={q}
                    className="chip"
                    onClick={() => setQuery(active ? "" : q)}
                    style={{
                      cursor: "pointer",
                      background: active ? "var(--vu-navy)" : "var(--vu-divider)",
                      color: active ? "#fff" : "#334155",
                      border: 0,
                      textTransform: "lowercase",
                      letterSpacing: "0.02em",
                      fontWeight: 600,
                      transition: "background-color 140ms, color 140ms",
                    }}
                    title={active ? "Clear search" : `Search "${q}"`}
                  >
                    {q}
                  </button>
                );
              })}
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
                    height: "100%",
                    minHeight: "380px",
                    gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
                    gridTemplateRows: "repeat(2, minmax(0, 1fr))",
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
                <SkeletonGrid rows={3} cols={4} />
              ) : (
                <SkinGrid
                  visibleSkins={visibleSkins}
                  weaponTabs={weaponTabs}
                  weaponTab={weaponTab}
                  onWeaponTab={setWeaponTab}
                  region={region}
                  skinPage={skinPage}
                  setSkinPage={setSkinPage}
                  sel={sel}
                  setSel={setSel}
                />
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
                <>
                  {selDisplay.tierLabel && (
                    <span
                      className="tier-ribbon"
                      style={{ fontSize: "11.5px", padding: "6px 16px 6px 12px" }}
                    >
                      {selDisplay.tierIcon ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={selDisplay.tierIcon}
                          alt=""
                          style={{ width: "13px", height: "13px", objectFit: "contain" }}
                        />
                      ) : (
                        <span style={{ fontSize: "10px" }}>◆</span>
                      )}
                      <span>{selDisplay.tierLabel} edition</span>
                    </span>
                  )}
                  {selDisplay.icon ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={selDisplay.icon}
                      alt=""
                      style={{
                        position: "absolute",
                        inset: "30px 20px 14px",
                        width: "calc(100% - 40px)",
                        height: "calc(100% - 44px)",
                        objectFit: "contain",
                        filter: "drop-shadow(0 6px 8px rgba(0,0,0,0.5))",
                      }}
                    />
                  ) : (
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        color: "#fff",
                        padding: "16px",
                      }}
                    >
                      <span className="h" style={{ fontSize: "28px", textAlign: "center" }}>
                        {selDisplay.name}
                      </span>
                    </div>
                  )}
                </>
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
              <span style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                <span className="h" style={{ fontSize: "22px" }}>{selDisplay.titleName}</span>
                {selDisplay.kind === "bracket" && selDisplay.range === "1-25" && (
                  <span className="bc" style={{ fontSize: "11px", color: "var(--accent-success)", letterSpacing: "0.1em" }}>
                    Always includes a shop skin
                  </span>
                )}
              </span>
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

            {/* CREDIT APPLIED yellow banner — mirrors the designer's
                "€12.40 applied · €3.59 left via crypto" row. */}
            {useCredit && creditUsed > 0 && (
              <div
                style={{
                  display: "flex",
                  gap: "12px",
                  padding: "10px 12px",
                  background: "rgba(255, 212, 0, 0.1)",
                  borderLeft: "3px solid #ffd400",
                  fontSize: "12px",
                  color: "var(--vu-ivory)",
                }}
              >
                <span
                  className="bc"
                  style={{
                    fontSize: "10px",
                    fontWeight: 800,
                    color: "#a16207",
                    letterSpacing: "0.14em",
                    minWidth: "90px",
                  }}
                >
                  CREDIT<br />APPLIED
                </span>
                <span style={{ flex: 1, lineHeight: 1.4 }}>
                  <b className="num">€{eur(creditUsed)}</b> applied
                  {dueCents > 0 ? (
                    <>
                      {" · "}
                      <b className="num">€{eur(dueCents)}</b> left via crypto
                    </>
                  ) : (
                    <> — nothing left to pay</>
                  )}
                </span>
              </div>
            )}

            <div style={{ flex: 1 }} />

            <button
              className="btn btn-red btn-lg cut"
              onClick={buyNow}
              disabled={busy || selDisplay.stock === 0}
            >
              {busy
                ? "…"
                : selDisplay.stock === 0
                ? "Sold out"
                : dueCents === 0
                ? `Unlock with credit`
                : `Unlock · €${eur(dueCents)}`}
            </button>
          </div>
        )}
      </aside>
    </div>
  );
}

// ---- Skin grid with weapon sub-tabs + auto-select + entrance animation ----

function SkinGrid({
  visibleSkins, weaponTabs, weaponTab, onWeaponTab,
  region, skinPage, setSkinPage, sel, setSel,
}: {
  visibleSkins: FeaturedSkinRow[];
  weaponTabs: Array<{ label: string; count: number }>;
  weaponTab: string;
  onWeaponTab: (t: string) => void;
  region: Region;
  skinPage: number;
  setSkinPage: (n: number | ((p: number) => number)) => void;
  sel: Selected | null;
  setSel: (s: Selected | null) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(visibleSkins.length / SKINS_PER_PAGE));
  const page = Math.min(skinPage, Math.max(0, totalPages - 1));
  const start = page * SKINS_PER_PAGE;
  const slice = visibleSkins.slice(start, start + SKINS_PER_PAGE);

  // Auto-select the first tile of the current slice whenever the page or
  // filter changes — sidebar is never empty if there's stock. Preserve
  // user's active selection if it's still visible on this page.
  useEffect(() => {
    if (slice.length === 0) return;
    const currentVisible = slice.some(
      (s) => sel?.kind === "skin" && sel.row.label === s.label
    );
    if (!currentVisible) {
      setSel({ kind: "skin", row: slice[0] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `sel` is in the deps because the parent clears the selection on
    // mode/region change AFTER this effect runs (parent effects fire after
    // child effects), which used to leave the side panel empty.
  }, [page, weaponTab, visibleSkins.length === 0 ? 0 : visibleSkins[0]?.label, region, sel === null || sel.kind !== "skin"]);

  // Bump a keyframe key when the slice changes so each tile's rise-in
  // entrance animation replays. React keys on the grid container.
  const pageKey = `${region}:${weaponTab}:${page}`;

  if (visibleSkins.length === 0) {
    return <EmptyState region={region} forSkins />;
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: "10px" }}>
      {/* Weapon sub-tabs */}
      <div className="seg" role="group" aria-label="Weapon" style={{ flexWrap: "wrap", alignSelf: "flex-start" }}>
        {weaponTabs.map((w) => {
          const label = w.label === "Featured" ? "" : w.label;
          const active = weaponTab === label;
          return (
            <button
              key={w.label}
              className={active ? "on" : ""}
              onClick={() => onWeaponTab(label)}
              disabled={w.count === 0}
              title={w.count === 0 ? "No stock in this weapon class" : undefined}
            >
              {w.label} <span className="c num">{w.count}</span>
            </button>
          );
        })}
      </div>

      {/* Grid */}
      <div
        key={pageKey}
        className="skin-grid-rise"
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
          gridTemplateRows: "repeat(3, minmax(0, 1fr))",
          gap: "10px",
        }}
      >
        {slice.map((s, i) => (
          <div
            key={s.key}
            style={{
              // Stagger each tile's entrance animation by ~40ms so the
              // whole page doesn't fade in as one block.
              animation: "skin-rise 420ms cubic-bezier(.2,.8,.2,1) both",
              animationDelay: `${i * 40}ms`,
              minWidth: 0,
              minHeight: 0,
              width: "100%",
              height: "100%",
              display: "flex",
            }}
          >
            <SkinTile
              row={s}
              region={region}
              selected={sel?.kind === "skin" && sel.row.label === s.label}
              onPick={() => setSel({ kind: "skin", row: s })}
            />
          </div>
        ))}
      </div>

      {/* Pager */}
      <div
        style={{
          flex: "none",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <button
          className="btn btn-soft cs"
          style={{ height: "34px", fontSize: "15px" }}
          onClick={() => setSkinPage((p) => Math.max(0, p - 1))}
          disabled={page === 0}
        >
          ← Prev
        </button>
        <span className="bc num" style={{ fontWeight: 600, fontSize: "15px" }}>
          Page {page + 1} of {totalPages} · {visibleSkins.length} skins
        </span>
        <button
          className="btn btn-soft cs"
          style={{ height: "34px", fontSize: "15px" }}
          onClick={() => setSkinPage((p) => Math.min(totalPages - 1, p + 1))}
          disabled={page >= totalPages - 1}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

// Bracket → tile accent, keyed by bracket id (s_1_25 …) so it never depends
// on the human label's dash/suffix. Colours follow the designer's canvas:
// blue → teal → pink → orange → gold → red as the skin count climbs.
const BRACKET_COLOR: Record<string, string> = {
  s_1_25: "#5a9fe2",
  s_26_50: "#009587",
  s_51_100: "#d1548d",
  s_101_150: "#f5955b",
  s_151_200: "#fad663",
  s_200_plus: "#ff4655",
};

function bracketTierColor(bracket: string): string {
  return BRACKET_COLOR[bracket] ?? "var(--vu-red)";
}

// "1–25 skins" → "1–25"
function bracketRange(label: string): string {
  return label.replace(/\s*skins?$/i, "").trim();
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
  const tc = bracketTierColor(row.bracket);
  const range = bracketRange(row.label);
  const availColor = soldOut ? "#cbd5e1" : row.available < 10 ? "#fcd34d" : "#86efac";
  return (
    <button
      disabled={soldOut}
      onClick={onPick}
      className={`tile cs ${selected ? "on" : ""}`}
      style={{ ["--tc" as string]: tc, width: "100%", height: "100%" }}
      aria-label={`${range} skins, €${eur(row.price.finalCents)}`}
    >
      <span className="glow" style={{ opacity: 0.5 }} />
      <span
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "10px 12px 0",
        }}
      >
        <span className="bc" style={{ fontSize: "13px", fontWeight: 600, color: "#9aa5b1" }}>
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
        <span className="h num" style={{ fontSize: "52px", color: "#fff" }}>{range}</span>
        <span className="bc" style={{ fontSize: "15px", fontWeight: 600, color: tc }}>Skins</span>
      </span>
      <span
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "center",
          gap: "14px",
          padding: "0 0 8px",
          fontSize: "12px",
          color: "#9aa5b1",
        }}
      >
        <span>
          Available <b className="num" style={{ color: availColor }}>{soldOut ? "Sold out" : row.available}</b>
        </span>
        <span>Delivery <b style={{ color: "#86efac" }}>Instant</b></span>
      </span>
      <span className="strip">
        <span className="num" style={{ display: "flex", alignItems: "baseline", gap: "6px" }}>
          <span className="bc" style={{ fontWeight: 700, fontSize: "22px", color: "#fff" }}>
            €{eur(row.price.finalCents)}
          </span>
          {hasDiscount && (
            <span style={{ fontSize: "12px", color: "#8b97a5", textDecoration: "line-through" }}>
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
  // Prefer real tier color from valorant-api; fall back to inferred.
  const tc = row.tierColor
    ?? (row.label.includes("Elderflame") || row.label.includes("Araxys")
        ? "var(--tier-ultra)"
        : row.label.includes("Oni") || row.label.includes("Reaver") || row.label.includes("Prime")
        ? "var(--tier-premium)"
        : row.label.includes("RGX") || row.label.includes("Glitchpop")
        ? "var(--tier-exclusive)"
        : "var(--tier-standard)");

  return (
    <button
      disabled={soldOut}
      onClick={onPick}
      className={`tile cs ${selected ? "on" : ""}`}
      style={{ ["--tc" as string]: tc, width: "100%", height: "100%" }}
      aria-label={`${row.label} ${row.weapon}, from €${eur(row.finalCents)}`}
    >
      <span className="glow" />
      {/* Tier ribbon top-left (ULTRA / EXCLUSIVE / PREMIUM / SELECT) +
          HOT chip for in-stock skins, mirrors the designer. */}
      {row.tier && (
        <span className="tier-ribbon">
          {row.tierIcon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.tierIcon}
              alt=""
              style={{ width: "11px", height: "11px", objectFit: "contain" }}
            />
          ) : (
            <span style={{ fontSize: "9px", opacity: 0.9 }}>◆</span>
          )}
          <span>{row.tier}</span>
          {!soldOut && (
            <span
              style={{
                marginLeft: "4px",
                background: "#ffd400",
                color: "#111",
                fontWeight: 900,
                fontSize: "9px",
                letterSpacing: "0.1em",
                padding: "1px 5px 1px 4px",
                clipPath: "polygon(0 0, 100% 0, calc(100% - 3px) 100%, 0 100%)",
              }}
            >
              HOT
            </span>
          )}
        </span>
      )}
      <span
        style={{
          position: "relative",
          display: "flex",
          justifyContent: "flex-end",
          alignItems: "center",
          padding: "8px 10px 0",
          minHeight: "28px",
        }}
      >
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
        {row.icon ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            className="gun"
            src={row.icon}
            alt={`${row.label} ${row.weapon}`}
            style={{
              width: "100%",
              height: "100%",
              maxHeight: "66px",
              objectFit: "contain",
              filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.5))",
            }}
          />
        ) : (
          <span className="h" style={{ fontSize: "20px", color: "#fff", lineHeight: 1.1 }}>
            {row.label}
          </span>
        )}
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
      <span className="strip skin-strip">
        <span style={{ minWidth: 0, display: "flex", flexDirection: "column", lineHeight: 1.05 }}>
          <span className="bc" style={{ fontSize: "9.5px", fontWeight: 700, color: "var(--vu-ivory-dim)", letterSpacing: "0.16em", textTransform: "uppercase" }}>
            {row.weapon}
          </span>
          <span
            className="bc"
            style={{
              fontWeight: 800,
              fontSize: "14px",
              color: "#fff",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              letterSpacing: "0.04em",
              textTransform: "uppercase",
            }}
          >
            {/* Strip weapon from label so "Phaseguard Ghost" → "Phaseguard". */}
            {row.label.endsWith(` ${row.weapon}`)
              ? row.label.slice(0, -row.weapon.length - 1)
              : row.label}
          </span>
        </span>
        <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1 }}>
          {soldOut ? (
            <span className="bc" style={{ fontSize: "12px", color: "#f87171", fontWeight: 700 }}>
              Sold out
            </span>
          ) : (
            <>
              <span className="bc" style={{ fontSize: "9px", fontWeight: 700, color: "var(--vu-ivory-dim)", letterSpacing: "0.18em", marginBottom: "2px" }}>
                FROM
              </span>
              <span className="bc num" style={{ fontWeight: 800, fontSize: "17px", color: "#fff" }}>
                €{eur(row.finalCents)}
              </span>
            </>
          )}
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
            {orders.map((o) => {
              // Scrub any upstream-supplier string that might sneak in from
              // legacy DB rows. User-facing copy only.
              const scrub = (s: string | null | undefined, fallback: string): string => {
                if (!s) return fallback;
                const cleaned = s.replace(/qvsp\s*·\s*/i, "").replace(/qvsp/gi, "").trim();
                return cleaned || fallback;
              };
              const accountName = scrub(o.products?.name, "Random account");
              const regionLabel = scrub(o.products?.region, "—");
              return (
              <tr key={o.id} onClick={() => (window.location.href = `/orders/${o.id}`)}>
                <td style={{ paddingLeft: "16px" }}>
                  <span style={{ display: "flex", flexDirection: "column" }}>
                    <span className="bc" style={{ fontWeight: 700, fontSize: "17px", lineHeight: 1.1 }}>
                      {accountName}
                    </span>
                    <span className="mut mono" style={{ fontSize: "11px" }}>
                      VU-{o.id.slice(0, 8).toUpperCase()}{regionLabel && regionLabel !== "—" ? ` · ${regionLabel}` : ""}
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
              );
            })}
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

function XrayTab({
  isUltra, onSub, onOrders,
}: {
  isUltra: boolean;
  onSub: () => void;
  onOrders: () => void;
}) {
  if (!isUltra) {
    return (
      <LockedOverlay
        title="X-Ray is Ultra-only"
        perks={[
          "Full skin inventory per account",
          "Current + peak rank visible",
          "VP balance + buddies",
          "Buy the exact account — no random pick",
        ]}
        onSub={onSub}
      >
        <XrayInspector onOrders={onOrders} />
      </LockedOverlay>
    );
  }
  return <XrayInspector onOrders={onOrders} />;
}

// ---- X-RAY inspector --------------------------------------------

type XrayItem = {
  account_id: string;
  region: Region;
  level: number;
  peak: string;
  rank: string;
  rankIcon: string | null;
  rankColor: string | null;
  rankName: string | null;
  peakIcon: string | null;
  peakColor: string | null;
  peakName: string | null;
  skin_count: number;
  skins: string[] | null;
  buddies: string[] | null;
  vp: number | null;
  vp_value_cents: number | null;
  last_played: string | null;
  first_seen_at: string | null;
  publicCents: number;
  finalCents: number;
  savingsCents: number;
  discountPct: number;
};

type XraySort = "newest" | "cheapest" | "most_skins" | "highest_peak" | "highest_vp";

const XRAY_SORTS: Array<{ k: XraySort; l: string; asc: boolean }> = [
  { k: "newest", l: "Newest", asc: false },
  { k: "cheapest", l: "Cheapest", asc: true },
  { k: "most_skins", l: "Most skins", asc: false },
  { k: "highest_peak", l: "Highest peak", asc: false },
  { k: "highest_vp", l: "Highest VP", asc: false },
];

const XRAY_ONBOARD = [
  ["Filter & sort", "Narrow by region, min skins or a skin name. Click a sort twice to flip the direction."],
  ["Inspect any account", "Click a row to see its full inventory, rank, VP and buddies in the side panel."],
  ["Buy the exact one", "No random pick — hit Buy on the account you actually want."],
  ["Automate it", "Set up an Auto-buy rule and the bot grabs matching drops for you."],
];

const ULTRA_TIER_ICON =
  "https://media.valorant-api.com/contenttiers/411e4a55-4e59-7757-41f0-86a53f101bb5/displayicon.png";

// Readable rank colour on white (valorant-api's rank colours are pastel).
function rankTextColor(name: string | null | undefined): string {
  const n = (name ?? "").toLowerCase();
  if (n.startsWith("radiant")) return "#b59a00";
  if (n.startsWith("immortal")) return "#bb3d65";
  if (n.startsWith("ascendant")) return "#1f9d6e";
  if (n.startsWith("diamond")) return "#8e5aa3";
  if (n.startsWith("platinum")) return "#2b8a9a";
  if (n.startsWith("gold")) return "#b8860b";
  if (n.startsWith("silver") || n.startsWith("bronze") || n.startsWith("iron")) return "#6b7280";
  return "#5b6474";
}

function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

const TIER_ORDER: Record<string, number> = { Ultra: 5, Exclusive: 4, Premium: 3, Deluxe: 2, Select: 1 };

type SkinArtMap = Record<string, { icon: string | null; tier: string | null; tierColor: string | null }>;

function XrayInspector({ onOrders }: { onOrders: () => void }) {
  const [region, setRegion] = useState<Region>("EU");
  const [minSkins, setMinSkins] = useState<string>("0");
  const [skinSearch, setSkinSearch] = useState<string>("");
  const [sort, setSort] = useState<XraySort>("newest");
  const [asc, setAsc] = useState<boolean>(false);
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: XrayItem[]; total: number; totalPages: number } | null>(null);
  const [selected, setSelected] = useState<XrayItem | null>(null);
  const [step, setStep] = useState<"idle" | "processing" | "done">("idle");
  const [err, setErr] = useState<string>("");
  const [art, setArt] = useState<SkinArtMap>({});
  const [onboarded, setOnboarded] = useState<boolean>(true);

  // First visit → show the "How it works" sheet once per browser.
  useEffect(() => {
    try { setOnboarded(localStorage.getItem("vu_xray_onboarded") === "1"); } catch { /* storage blocked */ }
  }, []);
  function finishOnboard() {
    setOnboarded(true);
    try { localStorage.setItem("vu_xray_onboarded", "1"); } catch { /* storage blocked */ }
  }

  useEffect(() => {
    const params = new URLSearchParams({ region, page: String(page), sort, dir: asc ? "asc" : "desc" });
    const ms = parseInt(minSkins, 10) || 0;
    if (ms > 0) params.set("minSkins", String(ms));
    if (skinSearch.trim()) params.set("skin", skinSearch.trim());

    let cancelled = false;
    const h = setTimeout(() => {
      setData(null);
      fetch(`/api/stock/xray?${params}`)
        .then((r) => r.json())
        .then((d) => {
          if (cancelled) return;
          if (!d.ok) throw new Error(d.error);
          setData({ items: d.items, total: d.total, totalPages: d.totalPages });
          setSelected((cur) =>
            cur && d.items.some((i: XrayItem) => i.account_id === cur.account_id) ? cur : d.items[0] ?? null
          );
        })
        .catch(() => { if (!cancelled) setData({ items: [], total: 0, totalPages: 0 }); });
    }, skinSearch ? 250 : 0);
    return () => { cancelled = true; clearTimeout(h); };
  }, [region, page, sort, asc, minSkins, skinSearch]);

  useEffect(() => { setPage(1); }, [region, sort, asc, minSkins, skinSearch]);
  useEffect(() => { setStep("idle"); setErr(""); }, [selected?.account_id]);

  // Resolve skin art for the inspected account only.
  useEffect(() => {
    const names = (selected?.skins ?? []).filter((n) => !(n in art));
    if (names.length === 0) return;
    let cancelled = false;
    fetch("/api/stock/skin-art", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ names }),
    })
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d.ok) setArt((a) => ({ ...a, ...d.art })); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.account_id]);

  function pickSort(k: XraySort) {
    const def = XRAY_SORTS.find((s) => s.k === k)!.asc;
    if (sort === k) setAsc((a) => !a);
    else { setSort(k); setAsc(def); }
  }

  async function buy(item: XrayItem) {
    if (step === "processing") return;
    setSelected(item);
    setStep("processing"); setErr("");
    try {
      const res = await fetch("/api/stock/buy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ region: item.region, account_id: item.account_id, useCredit: true }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "buy_failed");
      if (d.invoiceUrl) { window.location.href = d.invoiceUrl; return; }
      setStep("done");
    } catch (e) {
      setStep("idle");
      setErr(e instanceof Error ? e.message : String(e));
    }
  }

  const inventory = useMemo(() => {
    const list = (selected?.skins ?? []).map((n) => {
      const a = art[n];
      return {
        name: n.replace(/\s*\(.*\)\s*$/, ""),
        icon: a?.icon ?? null,
        tier: a?.tier ?? null,
        tc: a?.tierColor ?? "#5b6474",
      };
    });
    list.sort((p, q) => (TIER_ORDER[q.tier ?? ""] ?? 0) - (TIER_ORDER[p.tier ?? ""] ?? 0));
    return list;
  }, [selected, art]);

  const totalPages = Math.max(1, data?.totalPages ?? 1);
  const sel = selected;
  const buyLabel = step === "processing" ? "Paying…" : step === "done" ? "Unlocked" : "Buy";

  return (
    <div style={{ height: "100%", position: "relative" }}>
      <div style={{ height: "100%", display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 1fr)", gap: "16px" }}>
        {/* LEFT: filters + table */}
        <section className="pn cut" style={{ padding: "16px 0 0", display: "flex", flexDirection: "column", gap: "10px", minHeight: 0 }}>
          <div style={{ padding: "0 16px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "8px" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "10px" }}>
              <span className="h" style={{ fontSize: "26px", color: "var(--vu-navy)" }}>
                X-Ray <span style={{ color: "#c9a800" }}>terminal</span>
              </span>
              <button
                className="bc"
                style={{ border: 0, background: "var(--vu-surface-alt)", color: "var(--vu-mute)", height: "26px", padding: "0 10px", cursor: "pointer", fontWeight: 600, fontSize: "13px" }}
                onClick={() => setOnboarded(false)}
              >
                How it works
              </button>
            </span>
            <div className="seg cy" role="group" aria-label="Region">
              {REGIONS.map((r) => (
                <button key={r} className={region === r ? "on" : ""} onClick={() => setRegion(r)}>
                  {REGION_NAME[r]}
                </button>
              ))}
            </div>
          </div>

          <div style={{ padding: "0 16px", display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) 110px auto", gap: "8px", alignItems: "end" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span className="lbl" style={{ fontSize: "11px" }}>Skin search</span>
                <input className="inp" type="search" placeholder="e.g. Reaver, Elderflame…" value={skinSearch} onChange={(e) => setSkinSearch(e.target.value)} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span className="lbl" style={{ fontSize: "11px" }}>Min skins</span>
                <input className="inp num" type="number" min="0" value={minSkins} onChange={(e) => setMinSkins(e.target.value)} />
              </label>
              <span className="bc num" style={{ height: "38px", display: "inline-flex", alignItems: "center", fontWeight: 700, fontSize: "18px", whiteSpace: "nowrap", color: "var(--vu-navy)" }}>
                {data ? `${data.total} accounts` : "…"}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
              <span className="lbl" style={{ fontSize: "11px" }}>Sort</span>
              <div className="seg" role="group" aria-label="Sort" style={{ flexWrap: "wrap" }}>
                {XRAY_SORTS.map((o) => {
                  const on = sort === o.k;
                  return (
                    <button key={o.k} className={on ? "on" : ""} onClick={() => pickSort(o.k)}>
                      {o.l}{" "}
                      <span style={{ color: on ? (asc ? "#16a34a" : "#e11d48") : "transparent" }}>
                        {on ? (asc ? "▲" : "▼") : "▼"}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
            {data === null ? (
              <div style={{ padding: "0 16px", display: "flex", flexDirection: "column", gap: "6px" }}>
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="skel l" style={{ height: "42px" }} />
                ))}
              </div>
            ) : data.items.length === 0 ? (
              <div style={{ padding: "32px 16px", textAlign: "center" }} className="mut">
                No accounts match these filters. Try a lower minimum or another region.
              </div>
            ) : (
              <table className="tbl click">
                <thead>
                  <tr>
                    <th style={{ paddingLeft: "16px" }}>Rank</th>
                    <th>Peak</th>
                    <th style={{ textAlign: "right" }}>Level</th>
                    <th style={{ textAlign: "right" }}>Skins</th>
                    <th style={{ textAlign: "right" }}>VP</th>
                    <th style={{ textAlign: "right" }}>Price</th>
                    <th style={{ paddingRight: "16px" }} />
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((a) => {
                    const on = sel?.account_id === a.account_id;
                    return (
                      <tr key={a.account_id} className={on ? "on" : ""} onClick={() => setSelected(a)}>
                        <td style={{ paddingLeft: "16px" }}>
                          <span style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                            {a.rankIcon && <img src={a.rankIcon} alt="" style={{ width: "26px", height: "26px" }} />}
                            <span className="bc" style={{ fontWeight: 700, fontSize: "16px" }}>
                              {a.rankName ?? titleCase(a.rank || "Unranked")}
                            </span>
                            <span className="rg" style={{ background: "var(--vu-navy)" }}>{a.region}</span>
                          </span>
                        </td>
                        <td>
                          <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                            {a.peakIcon && <img src={a.peakIcon} alt="" style={{ width: "20px", height: "20px" }} />}
                            <span className="mut" style={{ fontSize: "12px" }}>{a.peakName ?? (titleCase(a.peak || "") || "—")}</span>
                          </span>
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>{a.level}</td>
                        <td className="num" style={{ textAlign: "right", fontWeight: 700 }}>{a.skin_count}</td>
                        <td className="num mut" style={{ textAlign: "right" }}>{(a.vp ?? 0).toLocaleString("en")}</td>
                        <td style={{ textAlign: "right" }}>
                          <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                            <span className="bc num" style={{ fontWeight: 700, fontSize: "18px", color: on ? "#ffd400" : "#a68a00", lineHeight: 1 }}>
                              €{eur(a.finalCents)}
                            </span>
                            {a.discountPct > 0 && (
                              <span className="num mut" style={{ fontSize: "11px", textDecoration: "line-through" }}>
                                €{eur(a.publicCents)}
                              </span>
                            )}
                          </span>
                        </td>
                        <td style={{ paddingRight: "16px", textAlign: "right" }}>
                          <button
                            className="btn btn-red cs btn-sm"
                            disabled={step === "processing"}
                            onClick={(e) => { e.stopPropagation(); buy(a); }}
                          >
                            Buy
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div style={{ flex: "none", display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 16px 12px", borderTop: "1px solid var(--vu-divider)" }}>
            <button className="btn btn-soft cs btn-sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              ← Prev
            </button>
            <span className="bc num" style={{ fontWeight: 600, fontSize: "15px" }}>Page {page} of {totalPages}</span>
            <button className="btn btn-soft cs btn-sm" onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}>
              Next →
            </button>
          </div>
        </section>

        {/* RIGHT: inspector */}
        <section className="pn cut" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: "12px", minHeight: 0 }}>
          {!sel ? (
            <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }} className="mut">
              Pick an account to inspect it.
            </div>
          ) : (
            <div key={sel.account_id} className="rise" style={{ display: "flex", flexDirection: "column", gap: "12px", flex: 1, minHeight: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                {sel.rankIcon && <img src={sel.rankIcon} alt="" style={{ width: "52px", height: "52px" }} />}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" }}>
                  <span className="h" style={{ fontSize: "28px", color: rankTextColor(sel.rankName ?? sel.rank) }}>
                    {sel.rankName ?? titleCase(sel.rank || "Unranked")}
                  </span>
                  <span className="mut num" style={{ fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                    {REGION_NAME[sel.region]} · <span className="mono">{sel.account_id.slice(0, 10)}</span>
                    {sel.first_seen_at && ` · listed ${timeAgo(sel.first_seen_at)}`}
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                  <span className="h num" style={{ fontSize: "30px", color: "#a68a00" }}>€{eur(sel.finalCents)}</span>
                  {sel.discountPct > 0 && (
                    <span className="num" style={{ fontSize: "12px" }}>
                      <span className="mut" style={{ textDecoration: "line-through" }}>€{eur(sel.publicCents)}</span>{" "}
                      <span style={{ color: "var(--accent-success)", fontWeight: 600 }}>−{Math.round(sel.discountPct * 100)}%</span>
                    </span>
                  )}
                </div>
                <button
                  className="btn btn-red cut"
                  style={{ height: "50px", minWidth: "120px" }}
                  onClick={() => buy(sel)}
                  disabled={step !== "idle"}
                >
                  {buyLabel}
                </button>
              </div>

              {step === "done" && (
                <div className="rise" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px", background: "var(--vu-navy)", color: "#fff" }}>
                  <span className="bc" style={{ color: "#4ade80", fontWeight: 700, fontSize: "16px" }}>Unlocked</span>
                  <span style={{ flex: 1, color: "var(--vu-ivory-dim)" }}>Login details are in My purchases.</span>
                  <button className="btn btn-soft cs btn-sm" onClick={onOrders}>Open</button>
                </div>
              )}
              {err && (
                <div className="rise" style={{ padding: "8px 12px", background: "#ffe4e6", color: "var(--accent-rose)", fontSize: "13px" }}>
                  {err}
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gap: "4px" }}>
                {[
                  { k: "Peak", v: sel.peakName ?? (titleCase(sel.peak || "") || "—"), c: rankTextColor(sel.peakName ?? sel.peak) },
                  { k: "Level", v: String(sel.level ?? "—"), c: "var(--vu-navy)" },
                  { k: "Skins", v: String(sel.skin_count), c: "var(--vu-navy)" },
                  {
                    k: "VP",
                    v: sel.vp ? `${sel.vp.toLocaleString("en")}${sel.vp_value_cents ? ` ≈€${eur(sel.vp_value_cents)}` : ""}` : "0",
                    c: sel.vp ? "#1d4ed8" : "#8b97a5",
                  },
                  { k: "Buddies", v: String(sel.buddies?.length ?? 0), c: "var(--vu-navy)" },
                  { k: "Last played", v: sel.last_played ? (/^\d{4}-/.test(sel.last_played) ? timeAgo(sel.last_played) : sel.last_played) : "—", c: "var(--vu-navy)" },
                ].map((s) => (
                  <div key={s.k} style={{ background: "var(--vu-surface-alt)", padding: "5px 8px", display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span className="lbl" style={{ fontSize: "11px" }}>{s.k}</span>
                    <span className="bc num" title={s.v} style={{ fontWeight: 700, fontSize: "18px", color: s.c, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {s.v}
                    </span>
                  </div>
                ))}
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span className="lbl" style={{ color: "var(--vu-navy)" }}>Inventory</span>
                <span className="mut num" style={{ fontSize: "12px" }}>{sel.skin_count} skins · every skin shown</span>
              </div>
              <div
                style={{
                  flex: 1, minHeight: "90px", overflowY: "auto", display: "grid",
                  gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gridAutoRows: "80px",
                  gap: "6px", alignContent: "start", paddingRight: "4px",
                }}
              >
                {inventory.map((k, i) => (
                  <div
                    key={`${k.name}-${i}`}
                    className="tile cs"
                    title={k.name}
                    style={{ ["--tc" as string]: k.tc, cursor: "default", height: "80px", animationDelay: `${Math.min(i, 24) * 20}ms` }}
                  >
                    <span className="glow" />
                    <span style={{ position: "relative", flex: 1, minHeight: "16px", display: "flex", alignItems: "center", justifyContent: "center", padding: "3px 6px" }}>
                      {k.icon ? (
                        <img src={k.icon} alt="" loading="lazy" style={{ width: "100%", height: "100%", maxHeight: "40px", objectFit: "contain", filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.5))" }} />
                      ) : (
                        <span className="bc" style={{ fontSize: "10px", color: "var(--vu-ivory-dim)", textAlign: "center", lineHeight: 1.1 }}>No art</span>
                      )}
                    </span>
                    <span className="strip" style={{ padding: "3px 6px" }}>
                      <span className="bc" style={{ fontWeight: 700, fontSize: "11px", color: "#fff", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {k.name}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>

      {!onboarded && (
        <div style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(15,25,35,0.55)" }}>
          <div role="dialog" aria-modal="true" aria-label="Welcome to X-Ray" className="cut rise" style={{ width: "540px", maxWidth: "100%", background: "#fff", display: "flex", flexDirection: "column" }}>
            <div style={{ background: "var(--vu-navy)", color: "#fff", padding: "16px 20px", borderBottom: "3px solid #ffd400", display: "flex", alignItems: "center", gap: "12px" }}>
              <img src={ULTRA_TIER_ICON} alt="" style={{ width: "34px", height: "34px" }} />
              <div style={{ display: "flex", flexDirection: "column" }}>
                <span className="h" style={{ fontSize: "26px" }}>Welcome to X-Ray</span>
                <span className="num" style={{ fontSize: "12px", color: "var(--vu-ivory-dim)" }}>Ultra · see inside any account before you buy</span>
              </div>
            </div>
            <div style={{ padding: "18px 20px", display: "flex", flexDirection: "column", gap: "12px" }}>
              {XRAY_ONBOARD.map(([t, d], i) => (
                <div key={t} className="rise" style={{ display: "flex", gap: "12px", alignItems: "flex-start", animationDelay: `${120 + i * 70}ms` }}>
                  <span className="cs bc" style={{ width: "26px", height: "26px", flex: "none", background: "#ffd400", color: "var(--vu-navy)", display: "inline-flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: "15px" }}>
                    {i + 1}
                  </span>
                  <div style={{ display: "flex", flexDirection: "column" }}>
                    <span style={{ fontWeight: 600 }}>{t}</span>
                    <span className="mut" style={{ fontSize: "12px" }}>{d}</span>
                  </div>
                </div>
              ))}
              <button className="btn btn-gold cut btn-lg" onClick={finishOnboard}>Start browsing</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ================================================================
// Auto-Buy tab (Ultra-only)
// ================================================================

type AutobuyRule = {
  id: string;
  name: string;
  active: boolean;
  regions: string[];
  kinds: string[];
  min_skins: number | null;
  max_price_cents: number;
  min_level: number | null;
  min_peak: string | null;
  max_peak?: string | null;
  min_vp?: number | null;
  budget_cents?: number | null;
  required_skins: string[];
  max_buys_per_day: number;
  min_credit_cents: number;
  bought_today: number;
  bought_today_date: string;
  last_fired_at: string | null;
  created_at: string;
};

function AutobuyTab({
  me, isUltra, onSub,
}: {
  me: Me;
  isUltra: boolean;
  onSub: () => void;
}) {
  if (!isUltra) {
    return (
      <LockedOverlay
        title="Auto-buy is Ultra-only"
        description="Set filters for price, rank, skins, level and VP. The bot buys matching drops the moment they land, paid from your credit."
        onSub={onSub}
      >
        <AutobuyManager me={me} />
      </LockedOverlay>
    );
  }
  return <AutobuyManager me={me} />;
}

// ---- Shared Ultra-lock overlay ---------------------------------------
// The gated UI renders live behind a blur so non-Ultra users see what
// they'd unlock; pointer events are off so nothing under it can be used.

function LockedOverlay({
  title, perks, description, onSub, children,
}: {
  title: string;
  perks?: string[];
  description?: string;
  onSub: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ position: "relative", height: "100%" }}>
      <div aria-hidden="true" style={{ height: "100%", filter: "blur(6px)", pointerEvents: "none", userSelect: "none" }}>
        {children}
      </div>
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(15,25,35,0.35)", padding: "24px" }}>
        <div className="cut rise" style={{ width: "460px", maxWidth: "100%", padding: "28px", display: "flex", flexDirection: "column", gap: "14px", background: "var(--vu-navy)", color: "var(--vu-ivory)" }}>
          {perks ? (
            <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
              <span className="cs" style={{ width: "44px", height: "44px", background: "#ffd400", color: "var(--vu-navy)", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="4" y="11" width="16" height="10" rx="1" />
                  <path d="M8 11V7a4 4 0 0 1 8 0v4" />
                </svg>
              </span>
              <span className="h" style={{ fontSize: "30px", color: "#ffd400" }}>{title}</span>
            </div>
          ) : (
            <span className="h" style={{ fontSize: "30px", color: "#ffd400" }}>{title}</span>
          )}
          {description && <span style={{ color: "var(--vu-ivory-dim)" }}>{description}</span>}
          {perks && (
            <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
              {perks.map((p, i) => (
                <span key={p} className="rise" style={{ display: "flex", gap: "10px", alignItems: "center", animationDelay: `${100 + i * 60}ms` }}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ffd400" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6 9 17l-5-5" />
                  </svg>
                  {p}
                </span>
              ))}
            </div>
          )}
          <button className="btn btn-gold cut btn-lg" onClick={onSub}>Upgrade to Ultra — €59.99/mo</button>
        </div>
      </div>
    </div>
  );
}

// Peak-rank range options. Min uses the tier's floor ("gold"), max the
// tier's top division ("gold 3") so rankIndex() comparisons include every
// division of the chosen tier.
const RANK_TIERS = ["Unranked", "Iron", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Ascendant", "Immortal", "Radiant"];
const minRankValue = (t: string) => (t === "Unranked" ? "" : t.toLowerCase());
const maxRankValue = (t: string) => (t === "Radiant" ? "" : t === "Unranked" ? "unranked" : `${t.toLowerCase()} 3`);
const tierOfValue = (v: string | null | undefined, fallback: string) => {
  if (!v) return fallback;
  const w = v.split(" ")[0];
  return w.charAt(0).toUpperCase() + w.slice(1);
};

type RuleDraft = {
  name: string;
  active: boolean;
  region: "ANY" | Region;
  max_price_cents: number;
  min_peak: string;
  max_peak: string;
  min_skins: number;
  min_level: number;
  min_vp: number;
  max_buys_per_day: number;
  budget_cents: number;
  required_skins: string[];
};

const NEW_RULE: RuleDraft = {
  name: "New rule",
  active: true,
  region: "ANY",
  max_price_cents: 6000,
  min_peak: "",
  max_peak: "",
  min_skins: 10,
  min_level: 0,
  min_vp: 0,
  max_buys_per_day: 1,
  budget_cents: 10000,
  required_skins: [],
};

function draftFromRule(r: AutobuyRule): RuleDraft {
  return {
    name: r.name ?? "Untitled rule",
    active: r.active,
    region: (r.regions?.[0] as Region | undefined) ?? "ANY",
    max_price_cents: r.max_price_cents,
    min_peak: r.min_peak ?? "",
    max_peak: r.max_peak ?? "",
    min_skins: r.min_skins ?? 0,
    min_level: r.min_level ?? 0,
    min_vp: r.min_vp ?? 0,
    max_buys_per_day: r.max_buys_per_day,
    budget_cents: r.budget_cents ?? 0,
    required_skins: r.required_skins ?? [],
  };
}

function draftToBody(d: RuleDraft) {
  return {
    name: d.name,
    active: d.active,
    regions: d.region === "ANY" ? [] : [d.region],
    kinds: ["skinned"],
    max_price_cents: d.max_price_cents,
    min_peak: d.min_peak || null,
    max_peak: d.max_peak || null,
    min_skins: d.min_skins,
    min_level: d.min_level,
    min_vp: d.min_vp,
    max_buys_per_day: d.max_buys_per_day,
    budget_cents: d.budget_cents,
    required_skins: d.required_skins,
  };
}

function rankRangeLabel(d: RuleDraft): string {
  const lo = tierOfValue(d.min_peak, "Unranked");
  const hi = tierOfValue(d.max_peak, "Radiant");
  if (lo === "Unranked" && hi === "Radiant") return "Any rank";
  if (hi === "Radiant") return `${lo}+`;
  return `${lo}–${hi}`;
}

function ruleSummary(r: AutobuyRule): string {
  const d = draftFromRule(r);
  return [
    d.region === "ANY" ? "Any region" : d.region,
    `≤€${Math.round(d.max_price_cents / 100)}`,
    rankRangeLabel(d),
    ...(d.required_skins.length ? [d.required_skins.join(", ")] : []),
  ].join(" · ");
}

type MatchRow = { id: string; rank: string; rankIcon: string | null; region: string; skins: number; level: number; finalCents: number };
type CatalogSkin = { key: string; label: string; icon: string | null; tier: string | null; tierColor: string | null };

function AutobuyManager({ me }: { me: Me }) {
  const [rules, setRules] = useState<AutobuyRule[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<RuleDraft>(NEW_RULE);
  const [matches, setMatches] = useState<{ n: number; total: number; list: MatchRow[] } | null>(null);
  const [catalog, setCatalog] = useState<CatalogSkin[] | null>(null);
  const [mustQ, setMustQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [agree, setAgree] = useState(false);
  const [saved, setSaved] = useState(false);

  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => { setDraft((d) => ({ ...d, [k]: v })); setSaved(false); };

  async function reload(selectId?: string) {
    try {
      const res = await fetch("/api/autobuy");
      const d = await res.json();
      if (!d.ok) { setRules([]); return; }
      setRules(d.rules);
      const pick = selectId ?? selectedId;
      const r = (d.rules as AutobuyRule[]).find((x) => x.id === pick) ?? (pick === null && !selectId ? d.rules[0] : null);
      if (r) { setSelectedId(r.id); setDraft(draftFromRule(r)); }
    } catch { setRules([]); }
  }
  useEffect(() => { reload(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Skin catalogue for "Must include" — skins currently in stock.
  const catalogRegion = draft.region === "ANY" ? "EU" : draft.region;
  useEffect(() => {
    let cancelled = false;
    setCatalog(null);
    fetch(`/api/stock/all-skins?region=${catalogRegion}`)
      .then((r) => r.json())
      .then((d) => { if (!cancelled) setCatalog(d.ok ? d.skins : []); })
      .catch(() => { if (!cancelled) setCatalog([]); });
    return () => { cancelled = true; };
  }, [catalogRegion]);

  // Live "matching right now" preview of the draft.
  const body = JSON.stringify(draftToBody(draft));
  useEffect(() => {
    let cancelled = false;
    const h = setTimeout(async () => {
      try {
        const res = await fetch("/api/autobuy/matches", { method: "POST", headers: { "content-type": "application/json" }, body });
        const d = await res.json();
        if (!cancelled && d.ok) setMatches({ n: d.matching, total: d.total ?? d.scanned, list: d.matches ?? [] });
      } catch { /* preview only */ }
    }, 350);
    return () => { cancelled = true; clearTimeout(h); };
  }, [body]);

  function selectRule(r: AutobuyRule) {
    setSelectedId(r.id); setDraft(draftFromRule(r)); setErr(""); setSaved(false);
  }
  function newRule() {
    setSelectedId(null); setDraft(NEW_RULE); setErr(""); setSaved(false);
  }

  async function persist(d: RuleDraft) {
    setBusy(true); setErr("");
    try {
      const url = selectedId ? `/api/autobuy/${selectedId}` : "/api/autobuy";
      const res = await fetch(url, {
        method: selectedId ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draftToBody(d)),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error ?? "save_failed");
      await reload(out.rule?.id ?? selectedId ?? undefined);
      setSaved(true);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule() {
    const r = rules?.find((x) => x.id === selectedId);
    if (!r || !confirm(`Delete rule "${r.name}"?`)) return;
    setBusy(true);
    await fetch(`/api/autobuy/${r.id}`, { method: "DELETE" });
    setSelectedId(null);
    setDraft(NEW_RULE);
    await reload("__none__");
    setBusy(false);
  }

  const current = rules?.find((r) => r.id === selectedId) ?? null;
  // Turning a rule on (new, or previously paused) goes through the
  // "credit will be spent automatically" confirmation.
  const needsConfirm = draft.active && (!current || !current.active);
  function onSave() {
    if (needsConfirm) { setAgree(false); setConfirmOpen(true); }
    else persist(draft);
  }

  const credit = me.creditCents;
  const low = credit < draft.max_price_cents;
  const mq = mustQ.trim().toLowerCase();
  const mustList = useMemo(() => {
    const base = catalog ?? [];
    const req = new Set(draft.required_skins.map((s) => s.toLowerCase()));
    const known = new Set(base.map((s) => s.label.toLowerCase()));
    // Required skins that aren't in today's stock still show (and stay removable).
    const extra: CatalogSkin[] = draft.required_skins
      .filter((s) => !known.has(s.toLowerCase()))
      .map((s) => ({ key: s, label: s, icon: null, tier: null, tierColor: null }));
    return extra.concat(base)
      .filter((s) => !mq || s.label.toLowerCase().includes(mq))
      .sort((a, b) => Number(req.has(b.label.toLowerCase())) - Number(req.has(a.label.toLowerCase())))
      .slice(0, 120);
  }, [catalog, draft.required_skins, mq]);

  function toggleMust(label: string) {
    const has = draft.required_skins.some((s) => s.toLowerCase() === label.toLowerCase());
    set("required_skins", has ? draft.required_skins.filter((s) => s.toLowerCase() !== label.toLowerCase()) : draft.required_skins.concat([label]));
  }

  const slider = (label: string, value: string, input: React.ReactNode) => (
    <label style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
      <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span className="lbl" style={{ fontSize: "12px" }}>{label}</span>
        <span className="bc num" style={{ fontWeight: 700, fontSize: "20px" }}>{value}</span>
      </span>
      {input}
    </label>
  );

  const sumStats = [
    { k: "Region", v: draft.region === "ANY" ? "Any" : draft.region },
    { k: "Max price", v: `€${Math.round(draft.max_price_cents / 100)}` },
    { k: "Rank", v: rankRangeLabel(draft) },
    { k: "Min skins", v: `${draft.min_skins}+` },
    { k: "Per day", v: String(draft.max_buys_per_day) },
    { k: "Budget", v: draft.budget_cents ? `€${Math.round(draft.budget_cents / 100)}` : "No cap" },
  ];

  return (
    <div style={{ height: "100%", position: "relative" }}>
      <div style={{ height: "100%", display: "grid", gridTemplateColumns: "280px minmax(0, 1fr) 320px", gap: "16px" }}>
        {/* LEFT: rules */}
        <section className="pn cut" style={{ padding: "16px 0 12px", display: "flex", flexDirection: "column", gap: "10px", minHeight: 0 }}>
          <div style={{ padding: "0 16px", display: "flex", flexDirection: "column", gap: "4px" }}>
            <span className="h" style={{ fontSize: "26px" }}>Auto-buy <span style={{ color: "#c9a800" }}>rules</span></span>
            <span className="mut" style={{ fontSize: "12px" }}>Rules buy matching X-Ray drops the instant they land, paid from your credit.</span>
          </div>
          <div style={{ display: "flex", flexDirection: "column", overflow: "auto", minHeight: 0 }}>
            {rules === null ? (
              Array.from({ length: 3 }).map((_, i) => <div key={i} className="skel l" style={{ height: "58px", margin: "4px 12px" }} />)
            ) : rules.length === 0 && selectedId === null ? (
              <button className="xrow on" style={{ height: "66px" }}>
                <span style={{ width: "10px", height: "10px", flex: "none", transform: "rotate(45deg)", background: "#8b97a5" }} />
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                  <span className="bc" style={{ fontWeight: 700, fontSize: "17px" }}>{draft.name || "Untitled rule"}</span>
                  <span className="mut" style={{ fontSize: "12px" }}>Not saved yet</span>
                </span>
              </button>
            ) : (
              rules.map((r, i) => (
                <button
                  key={r.id}
                  className={`xrow rise ${selectedId === r.id ? "on" : ""}`}
                  onClick={() => selectRule(r)}
                  style={{ height: "66px", animationDelay: `${i * 40}ms` }}
                >
                  <span style={{ width: "10px", height: "10px", flex: "none", transform: "rotate(45deg)", background: r.active ? "#16a34a" : "#8b97a5" }} />
                  <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                    <span className="bc" style={{ fontWeight: 700, fontSize: "17px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {r.name || "Untitled rule"}
                    </span>
                    <span className="mut num" style={{ fontSize: "12px", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {ruleSummary(r)}
                    </span>
                  </span>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
                    <span className="bc" style={{ fontWeight: 700, fontSize: "14px", color: r.active ? "#16a34a" : "#8b97a5" }}>
                      {r.active ? "Active" : "Paused"}
                    </span>
                    <span className="mut num" style={{ fontSize: "11px" }}>{r.bought_today} today</span>
                  </span>
                </button>
              ))
            )}
          </div>
          <div style={{ flex: 1 }} />
          <div style={{ padding: "0 12px" }}>
            <button className="btn btn-soft cs" style={{ width: "100%" }} onClick={newRule}>+ New rule</button>
          </div>
        </section>

        {/* CENTER: editor */}
        <section key={selectedId ?? "new"} className="pn cut rise" style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: "14px", minHeight: 0 }}>
          <div style={{ display: "flex", gap: "10px", alignItems: "flex-end" }}>
            <label style={{ flex: 1, display: "flex", flexDirection: "column", gap: "4px" }}>
              <span className="lbl" style={{ fontSize: "12px" }}>Rule name</span>
              <input className="inp" type="text" value={draft.name} onChange={(e) => set("name", e.target.value)} style={{ fontWeight: 600 }} />
            </label>
            <div className="seg" role="group" aria-label="Status">
              <button className={draft.active ? "on" : ""} onClick={() => set("active", true)}>Active</button>
              <button className={!draft.active ? "on" : ""} onClick={() => set("active", false)}>Paused</button>
            </div>
            {selectedId && (
              <button className="ico" aria-label="Delete rule" title="Delete rule" onClick={deleteRule} style={{ height: "38px", width: "38px", color: "var(--accent-rose)" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M19 6l-1 14H6L5 6" />
                </svg>
              </button>
            )}
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
            <span className="lbl" style={{ fontSize: "12px" }}>Region</span>
            <div className="seg cy" role="group" aria-label="Region" style={{ display: "flex" }}>
              {(["ANY", ...REGIONS] as const).map((g) => (
                <button key={g} className={draft.region === g ? "on" : ""} style={{ flex: 1, justifyContent: "center" }} onClick={() => set("region", g)}>
                  {g === "ANY" ? "Any" : g}
                </button>
              ))}
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "14px 24px" }}>
            {slider("Max price (after −30%)", `€${Math.round(draft.max_price_cents / 100)}`,
              <input type="range" min="10" max="200" step="5" value={Math.round(draft.max_price_cents / 100)}
                onChange={(e) => set("max_price_cents", Number(e.target.value) * 100)} style={{ width: "100%", accentColor: "#ff4655" }} />)}
            <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
              <span className="lbl" style={{ fontSize: "12px" }}>Peak rank range</span>
              <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
                <select className="inp" aria-label="Lowest peak rank" value={tierOfValue(draft.min_peak, "Unranked")} onChange={(e) => set("min_peak", minRankValue(e.target.value))}>
                  {RANK_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
                <span className="mut">to</span>
                <select className="inp" aria-label="Highest peak rank" value={tierOfValue(draft.max_peak, "Radiant")} onChange={(e) => set("max_peak", maxRankValue(e.target.value))}>
                  {RANK_TIERS.map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
            </div>
            {slider("Min skins", `${draft.min_skins}+`,
              <input type="range" min="0" max="100" step="1" value={draft.min_skins}
                onChange={(e) => set("min_skins", Number(e.target.value))} style={{ width: "100%", accentColor: "#ff4655" }} />)}
            {slider("Min level", `${draft.min_level}+`,
              <input type="range" min="0" max="300" step="5" value={draft.min_level}
                onChange={(e) => set("min_level", Number(e.target.value))} style={{ width: "100%", accentColor: "#ff4655" }} />)}
            {slider("Min VP", `${draft.min_vp}+`,
              <input type="range" min="0" max="2500" step="50" value={draft.min_vp}
                onChange={(e) => set("min_vp", Number(e.target.value))} style={{ width: "100%", accentColor: "#ff4655" }} />)}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: "8px" }}>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span className="lbl" style={{ fontSize: "12px" }}>Max buys / day</span>
                <input className="inp num" type="number" min="1" max="10" value={draft.max_buys_per_day}
                  onChange={(e) => set("max_buys_per_day", Math.min(10, Math.max(1, parseInt(e.target.value, 10) || 1)))} />
              </label>
              <label style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <span className="lbl" style={{ fontSize: "12px" }}>Total budget €</span>
                <input className="inp num" type="number" min="0" step="10" value={Math.round(draft.budget_cents / 100)}
                  onChange={(e) => set("budget_cents", Math.max(0, parseInt(e.target.value, 10) || 0) * 100)} />
              </label>
            </div>
          </div>

          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "8px" }}>
              <span className="lbl" style={{ fontSize: "12px" }}>Must include skins</span>
              <div style={{ position: "relative", width: "210px" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#8b97a5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ position: "absolute", left: "10px", top: "9px", pointerEvents: "none" }}>
                  <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
                </svg>
                <input className="inp" type="search" placeholder="Search skins…" value={mustQ} onChange={(e) => setMustQ(e.target.value)} style={{ height: "32px", paddingLeft: "30px" }} aria-label="Search must-include skins" />
              </div>
            </div>
            <span className="mut" style={{ fontSize: "12px" }}>
              {draft.required_skins.length ? `${draft.required_skins.length} required · account must have all` : "None · any skins"}
            </span>
            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "grid", gridTemplateColumns: "repeat(6, minmax(0, 1fr))", gridAutoRows: "72px", gap: "6px", alignContent: "start" }}>
              {catalog === null
                ? Array.from({ length: 12 }).map((_, i) => <div key={i} className="skel cs" />)
                : mustList.map((k) => {
                  const on = draft.required_skins.some((s) => s.toLowerCase() === k.label.toLowerCase());
                  const tc = k.tierColor ?? "#5b6474";
                  return (
                    <button
                      key={k.key}
                      className="tile cs"
                      style={{ ["--tc" as string]: tc, boxShadow: on ? `inset 0 0 0 2px ${tc}` : "none", animation: "none" }}
                      onClick={() => toggleMust(k.label)}
                      aria-pressed={on}
                      aria-label={k.label}
                      title={k.label}
                    >
                      <span className="glow" style={{ opacity: on ? 0.9 : 0.25 }} />
                      <span style={{ position: "relative", flex: 1, minHeight: "20px", display: "flex", alignItems: "center", justifyContent: "center", padding: "4px 8px" }}>
                        {k.icon && <img src={k.icon} alt="" loading="lazy" style={{ width: "100%", height: "100%", maxHeight: "34px", objectFit: "contain", opacity: on ? 1 : 0.55, transition: "opacity 160ms" }} />}
                      </span>
                      <span className="bc" style={{ position: "relative", fontSize: "12px", fontWeight: 700, padding: "2px 6px 4px", color: on ? "#fff" : "#9aa5b1", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {k.label}
                      </span>
                    </button>
                  );
                })}
            </div>
          </div>
        </section>

        {/* RIGHT: matches + wallet */}
        <aside style={{ display: "flex", flexDirection: "column", gap: "16px", minHeight: 0 }}>
          <section className="pn cut" style={{ padding: "16px", flex: 1, minHeight: 0, display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span className="lbl" style={{ color: "var(--vu-navy)" }}>Matching right now</span>
              <span className="h num" style={{ fontSize: "26px", color: matches?.n ? "#16a34a" : "#8b97a5" }}>
                {matches ? matches.n : "…"}
                <span style={{ color: "#8b97a5", fontSize: "18px" }}> / {matches ? matches.total : "…"}</span>
              </span>
            </div>
            {matches && matches.n === 0 ? (
              <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "0 12px" }} className="mut">
                No listed account fits this rule right now. It fires on the next drop that does.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", overflow: "auto" }}>
                {(matches?.list ?? []).map((m, i) => (
                  <div key={m.id} className="rise" style={{ display: "flex", alignItems: "center", gap: "10px", height: "44px", borderBottom: "1px solid var(--vu-divider)", animationDelay: `${Math.min(i, 10) * 30}ms` }}>
                    {m.rankIcon ? <img src={m.rankIcon} alt="" style={{ width: "26px", height: "26px" }} /> : <span style={{ width: "26px" }} />}
                    <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
                      <span className="bc" style={{ fontWeight: 700, fontSize: "15px" }}>{m.rank} · {m.region}</span>
                      <span className="mut num" style={{ fontSize: "11px" }}>{m.skins} skins · Lvl {m.level}</span>
                    </span>
                    <span className="bc num" style={{ fontWeight: 700, fontSize: "17px" }}>€{eur(m.finalCents)}</span>
                  </div>
                ))}
                {matches && matches.n > matches.list.length && (
                  <span className="mut num" style={{ fontSize: "12px", padding: "8px 0" }}>+{matches.n - matches.list.length} more</span>
                )}
              </div>
            )}
          </section>
          <section className="pn cut" style={{ padding: "16px", display: "flex", flexDirection: "column", gap: "10px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span className="lbl" style={{ color: "var(--vu-navy)" }}>Wallet</span>
              <span className="h num" style={{ fontSize: "28px", color: "#a68a00" }}>€{eur(credit)}</span>
            </div>
            {low && (
              <div className="rise" style={{ background: "#fef3c7", color: "#713f12", fontSize: "12px", padding: "8px 10px" }}>
                Your credit is below this rule&apos;s max price (€{Math.round(draft.max_price_cents / 100)}). A match you can&apos;t cover is skipped and goes to the next buyer.
              </div>
            )}
            {err && <div className="rise" style={{ background: "#ffe4e6", color: "var(--accent-rose)", fontSize: "12px", padding: "8px 10px" }}>{err}</div>}
            {saved && !err && <div className="rise" style={{ background: "#dcfce7", color: "#15803d", fontSize: "12px", padding: "8px 10px" }}>Rule saved.</div>}
            <button className="btn btn-red cs" style={{ width: "100%" }} onClick={onSave} disabled={busy}>
              {busy ? "Saving…" : needsConfirm ? "Save & activate" : current ? "Save changes" : "Save rule"}
            </button>
          </section>
        </aside>
      </div>

      {confirmOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(15,25,35,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
          <div role="dialog" aria-modal="true" aria-label="Activate auto-buy" className="cut rise" style={{ width: "100%", maxWidth: "520px", maxHeight: "100%", overflow: "auto", background: "#fff", display: "flex", flexDirection: "column" }}>
            <div style={{ background: "var(--vu-navy)", color: "#fff", padding: "14px 18px", display: "flex", alignItems: "center", gap: "12px", borderBottom: "3px solid #ffd400" }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                <span className="h" style={{ fontSize: "24px" }}>Activate auto-buy?</span>
                <span style={{ fontSize: "12px", color: "var(--vu-ivory-dim)" }}>{draft.name}</span>
              </div>
              <button className="ico" style={{ color: "var(--vu-ivory-dim)" }} aria-label="Close" onClick={() => setConfirmOpen(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>
            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "4px" }}>
                {sumStats.map((a) => (
                  <div key={a.k} style={{ background: "var(--vu-surface-alt)", padding: "6px 10px", display: "flex", flexDirection: "column" }}>
                    <span className="lbl" style={{ fontSize: "11px" }}>{a.k}</span>
                    <span className="bc num" style={{ fontWeight: 700, fontSize: "17px" }}>{a.v}</span>
                  </div>
                ))}
              </div>
              <div style={{ background: "#fff1f2", padding: "12px 14px", display: "flex", flexDirection: "column", gap: "8px", fontSize: "13px", color: "#4c0519" }}>
                {[
                  "Credit is taken from your wallet automatically the moment a match is found. There is no extra confirmation per purchase.",
                  "If your credit is below the price when a match drops, the purchase is skipped and the account goes to the next buyer. You lose that drop.",
                  "When several Ultra rules match the same drop, it goes round-robin. Matching doesn't guarantee you get it.",
                  "Auto-bought accounts are final once delivered. Refunds and replacements follow the normal rules.",
                ].map((t, i) => (
                  <span key={i} style={{ display: "flex", gap: "8px" }}><b style={{ color: "#e11d48" }}>{i + 1}</b>{t}</span>
                ))}
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: "10px", fontWeight: 600, cursor: "pointer" }}>
                <input type="checkbox" checked={agree} onChange={() => setAgree((a) => !a)} style={{ width: "18px", height: "18px", accentColor: "#ff4655" }} />
                I understand credit will be spent automatically.
              </label>
              <div style={{ display: "flex", gap: "8px" }}>
                <button className="btn btn-soft cs" style={{ flex: 1 }} onClick={() => setConfirmOpen(false)}>Cancel</button>
                <button className="btn btn-red cs" style={{ flex: 2 }} disabled={!agree || busy} onClick={() => { setConfirmOpen(false); persist({ ...draft, active: true }); }}>
                  Activate rule
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
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
        Admin controls — manage credit grants, review orders, trigger inventory sync.
      </p>
    </section>
  );
}
