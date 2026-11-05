"use client";
// Dashboard — the ONLY page. Middleware gates every route behind Discord
// OAuth, so if we're here we're signed in.
//
// Tabs: STOCK (qvsp skin-range browse) · SUBSCRIBE · PURCHASES · ADMIN
import { useCallback, useEffect, useState } from "react";

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const tierLabel = (t: string | null) => (t ? t[0].toUpperCase() + t.slice(1) : "Guest");

const TIER_COLOR: Record<string, string> = {
  standard: "#3b82f6",
  premium: "#ff4655",
  ultra: "#ffd400",
};

const REGIONS = ["EU", "AP", "KR", "LATAM", "BR"] as const;
type Region = typeof REGIONS[number];
type Tier = "standard" | "premium" | "ultra";

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
  price: { publicCents: number; finalCents: number; discountPct: number; savingsCents: number };
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

export default function Page() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"stock" | "subscribe" | "purchases" | "admin">("stock");

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

  if (loading || !me) return <div className="center muted">Loading…</div>;

  return (
    <>
      <Topbar me={me} />
      <div className="wrap">
        <div className="tabs-primary">
          <button className={`tab ${tab === "stock" ? "active" : ""}`} onClick={() => setTab("stock")}>
            Stock
          </button>
          <button className={`tab ${tab === "subscribe" ? "active" : ""}`} onClick={() => setTab("subscribe")}>
            Subscribe
          </button>
          <button
            className={`tab ${tab === "purchases" ? "active-gold" : ""}`}
            onClick={() => setTab("purchases")}
          >
            My Purchases
          </button>
          {me.isAdmin && (
            <button className={`tab ${tab === "admin" ? "active" : ""}`} onClick={() => setTab("admin")}>
              Admin
            </button>
          )}
        </div>

        <div style={{ marginTop: 24 }}>
          {tab === "stock" && <Stock me={me} />}
          {tab === "subscribe" && <Subscribe me={me} reload={() => window.location.reload()} />}
          {tab === "purchases" && <Purchases />}
          {tab === "admin" && me.isAdmin && <Admin />}
        </div>
      </div>
    </>
  );
}

function Topbar({ me }: { me: Me }) {
  return (
    <div className="topbar">
      <div className="wrap row spread" style={{ padding: "14px 20px", maxWidth: 1240 }}>
        <a href="/" className="brand" style={{ color: "inherit" }}>
          VAL<span>UNLOCKED</span>
        </a>
        <div className="row" style={{ gap: 10 }}>
          {me.sub && (
            <span
              className="badge"
              style={{
                color: TIER_COLOR[me.sub.tier],
                borderColor: TIER_COLOR[me.sub.tier],
                fontWeight: 700,
                letterSpacing: 1,
                textTransform: "uppercase",
                fontSize: 11,
              }}
            >
              {me.sub.status === "grace" ? "⚠ " : ""}
              {tierLabel(me.sub.tier)}
            </span>
          )}
          <span
            className="badge"
            style={{ color: me.creditCents > 0 ? "var(--gold)" : "var(--muted)", fontWeight: 700 }}
            title="Store credit"
          >
            {eur(me.creditCents)}
          </span>
          <img className="avatar" src={me.avatar} alt="" />
          <form action="/api/auth/logout" method="post" style={{ display: "inline" }}>
            <button className="btn ghost sm" title={me.name}>
              Log out
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ─── STOCK tab ─────────────────────────────────────────────────

function Stock({ me }: { me: Me }) {
  const [region, setRegion] = useState<Region>("EU");
  const [brackets, setBrackets] = useState<BracketRow[] | null>(null);
  const [featured, setFeatured] = useState<FeaturedSkinRow[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  const loadBrackets = useCallback(() => {
    fetch("/api/stock/brackets")
      .then((r) => r.json())
      .then((d) => setBrackets(d.brackets ?? []));
  }, []);

  const loadFeatured = useCallback((r: Region) => {
    setFeatured(null);
    fetch(`/api/stock/featured-skins?region=${r}`)
      .then((res) => res.json())
      .then((d) => setFeatured(d.skins ?? []));
  }, []);

  useEffect(() => {
    loadBrackets();
  }, [loadBrackets]);

  useEffect(() => {
    loadFeatured(region);
  }, [region, loadFeatured]);

  const totalsByRegion: Record<string, number> = {};
  for (const row of brackets ?? []) {
    totalsByRegion[row.region] = (totalsByRegion[row.region] ?? 0) + row.available;
  }

  const visible = (brackets ?? []).filter((b) => b.region === region);

  async function buyBracket(bracket: string) {
    setBusy(`b:${bracket}`);
    setErr("");
    const res = await fetch("/api/stock/buy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region, bracket, useCredit: true }),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) { setErr(data.error ?? "something went wrong"); return; }
    if (data.invoiceUrl) window.location.href = data.invoiceUrl;
    else window.location.href = `/orders/${data.orderId}`;
  }

  async function buySkin(label: string) {
    setBusy(`s:${label}`);
    setErr("");
    const res = await fetch("/api/stock/buy", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ region, skin: label, useCredit: true }),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) { setErr(data.error ?? "something went wrong"); return; }
    if (data.invoiceUrl) window.location.href = data.invoiceUrl;
    else window.location.href = `/orders/${data.orderId}`;
  }

  return (
    <>
      <div className="section-label">Random Account · Skin Bracket</div>

      {/* Region tabs */}
      <div className="tabs-secondary">
        {REGIONS.map((r) => (
          <button key={r} className={`tab ${region === r ? "active" : ""}`} onClick={() => setRegion(r)}>
            {regionLabel(r)}
            <span className="count">{totalsByRegion[r] ?? 0}</span>
          </button>
        ))}
      </div>

      {me.creditCents > 0 && (
        <div className="notice" style={{ marginBottom: 16 }}>
          {eur(me.creditCents)} store credit — applied automatically at checkout.
        </div>
      )}
      {err && <p className="err" style={{ marginBottom: 12 }}>{errorText(err)}</p>}

      {brackets === null ? (
        <p className="muted" style={{ padding: 40, textAlign: "center" }}>
          Loading inventory…
        </p>
      ) : visible.every((b) => b.available === 0) ? (
        <p className="muted" style={{ padding: 40, textAlign: "center" }}>
          No stock in {regionLabel(region)} right now. Check a different region or check back soon.
        </p>
      ) : (
        <div className="grid">
          {visible.map((b) => (
            <div key={b.bracket} className={`stock-card ${b.available === 0 ? "sold-out" : ""}`}>
              <span className="region-badge">{region}</span>
              <div>
                <div className="bracket-title">Skin Range</div>
                <div className="bracket-name">{b.label}</div>
              </div>
              <div className="stat-row">
                <span className="label">Available</span>
                <span className="value">{b.available}</span>
              </div>
              <div className="stat-row">
                <span className="label">Delivery</span>
                <span className="value" style={{ color: "var(--ok)" }}>Instant</span>
              </div>
              <div className="price-row">
                <div>
                  {b.price.discountPct > 0 && (
                    <span className="price-strike">{eur(b.price.publicCents)}</span>
                  )}
                  <span className="price">{eur(b.price.finalCents)}</span>
                  {b.price.discountPct > 0 && (
                    <span className="discount-badge">-{Math.round(b.price.discountPct * 100)}%</span>
                  )}
                </div>
                <button
                  className="btn sm"
                  disabled={b.available === 0 || busy === `b:${b.bracket}`}
                  onClick={() => buyBracket(b.bracket)}
                >
                  {busy === `b:${b.bracket}` ? "…" : b.available === 0 ? "SOLD OUT" : "BUY"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="muted" style={{ fontSize: 12, marginTop: 16, marginBottom: 32, textAlign: "center" }}>
        A random full-access account from the chosen bracket is delivered after payment confirms on-chain.
        All accounts come with the original email so you can lock them down.
      </p>

      {/* ── FEATURED (guaranteed) skins ───────────────────── */}
      <div className="section-label" style={{ marginTop: 8 }}>Guaranteed Skin · Named Drops</div>

      {featured === null ? (
        <p className="muted" style={{ padding: 40, textAlign: "center" }}>Loading featured skins…</p>
      ) : featured.every((s) => s.available === 0) ? (
        <p className="muted" style={{ padding: 40, textAlign: "center" }}>
          No featured-skin inventory in {regionLabel(region)} right now.
        </p>
      ) : (
        <div className="grid">
          {featured.map((s) => (
            <div key={s.key} className={`stock-card ${s.available === 0 ? "sold-out" : ""}`}>
              <span className="region-badge">{region}</span>
              <div>
                <div className="bracket-title">{s.weapon}</div>
                <div className="bracket-name" style={{ fontSize: 18 }}>{s.label}</div>
              </div>
              <div className="stat-row">
                <span className="label">Matching stock</span>
                <span className="value">{s.available}</span>
              </div>
              <div className="stat-row">
                <span className="label">Delivery</span>
                <span className="value" style={{ color: "var(--ok)" }}>Instant</span>
              </div>
              <div className="price-row">
                <div>
                  {s.available > 0 ? (
                    <>
                      {s.discountPct > 0 && (
                        <span className="price-strike">{eur(s.publicCents)}</span>
                      )}
                      <span className="price">{eur(s.finalCents)}</span>
                      {s.discountPct > 0 && (
                        <span className="discount-badge">-{Math.round(s.discountPct * 100)}%</span>
                      )}
                    </>
                  ) : (
                    <span className="price muted" style={{ fontSize: 16 }}>—</span>
                  )}
                </div>
                <button
                  className="btn sm"
                  disabled={s.available === 0 || busy === `s:${s.label}`}
                  onClick={() => buySkin(s.label)}
                >
                  {busy === `s:${s.label}` ? "…" : s.available === 0 ? "N/A" : "BUY"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="muted" style={{ fontSize: 12, marginTop: 16, textAlign: "center" }}>
        Price is based on the cheapest available account that has the skin, and updates as stock turns over.
        You get a full-access account with the named skin guaranteed.
      </p>
    </>
  );
}

function regionLabel(r: Region): string {
  return { EU: "Europe", AP: "Asia Pacific", KR: "Korea", LATAM: "Latin America", BR: "Brazil" }[r];
}

// ─── SUBSCRIBE tab ────────────────────────────────────────────

const TIER_CARDS = [
  {
    tier: "standard" as Tier,
    emoji: "🎟️",
    name: "Standard",
    priceCents: 999,
    color: "#3b82f6",
    tagline: "The toolkit — cheaper accounts + the method.",
    perks: ["10% off every account", "Discord + written method", "Email Grabber tool"],
  },
  {
    tier: "premium" as Tier,
    emoji: "⚡",
    name: "Premium",
    priceCents: 2499,
    color: "#ff4655",
    tagline: "See the drops first.",
    badge: "MOST POPULAR",
    perks: ["25% off every account", "2-hour early access on new drops", "Custom stock alerts (/snipe)"],
  },
  {
    tier: "ultra" as Tier,
    emoji: "👑",
    name: "Ultra",
    priceCents: 5999,
    color: "#ffd400",
    tagline: "Let the bot buy for you.",
    badge: "BEST VALUE",
    perks: ["40% off (up to 50% whales)", "Auto-buy for matching drops", "Priority replacement handling"],
  },
];

function Subscribe({ me, reload }: { me: Me; reload: () => void }) {
  const [busy, setBusy] = useState<Tier | null>(null);
  const [err, setErr] = useState("");

  async function subscribe(tier: Tier) {
    setBusy(tier);
    setErr("");
    const res = await fetch("/api/sub/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tier }),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) { setErr(data.error ?? "something went wrong"); return; }
    window.location.href = data.invoiceUrl;
  }

  async function renew() {
    setBusy(me.sub!.tier);
    const res = await fetch("/api/sub/renew", { method: "POST" });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) { setErr(data.error ?? "something went wrong"); return; }
    window.location.href = data.invoiceUrl;
  }

  async function cancel() {
    if (!confirm("Cancel your subscription? You keep your tier until the end of the paid month.")) return;
    const res = await fetch("/api/sub/cancel", { method: "POST" });
    if (res.ok) reload();
  }

  return (
    <>
      <div className="section-label">Membership</div>

      {me.sub && (
        <div className="card" style={{ marginBottom: 20, borderLeft: `4px solid ${TIER_COLOR[me.sub.tier]}` }}>
          <div className="row spread" style={{ flexWrap: "wrap", gap: 12 }}>
            <div>
              <div className="muted" style={{ fontSize: 11, letterSpacing: 1.5, textTransform: "uppercase" }}>
                Current Plan
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: TIER_COLOR[me.sub.tier] }}>
                {tierLabel(me.sub.tier)}
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div className="muted" style={{ fontSize: 11, letterSpacing: 1.5 }}>
                {me.sub.status === "grace" ? "GRACE ENDS" : "RENEWS"}
              </div>
              <div style={{ fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
                {new Date(me.sub.periodEnd).toLocaleDateString()}
              </div>
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn sm" onClick={renew} disabled={busy !== null}>Renew</button>
              <button className="btn ghost sm" onClick={cancel} disabled={busy !== null}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {err && <p className="err" style={{ marginBottom: 12 }}>{err}</p>}

      <div className="tier-grid">
        {TIER_CARDS.map((t) => {
          const isCurrent = me.sub?.tier === t.tier && (me.sub.status === "active" || me.sub.status === "grace");
          return (
            <div
              key={t.tier}
              className={`tier-card ${t.badge ? "featured" : ""}`}
              style={{ borderColor: t.badge ? t.color : undefined }}
            >
              {t.badge && (
                <div className="tier-badge" style={{ background: t.color, color: t.tier === "ultra" ? "#000" : "#fff" }}>
                  {t.badge}
                </div>
              )}
              <div className="row spread" style={{ alignItems: "flex-start" }}>
                <div>
                  <div className="tier-emoji">{t.emoji}</div>
                  <div className="tier-name" style={{ color: t.color, marginTop: 4 }}>{t.name}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div className="tier-price">{eur(t.priceCents)}</div>
                  <small style={{ color: "var(--muted)" }}>/ month</small>
                </div>
              </div>
              <p className="muted" style={{ fontSize: 13, margin: 0, minHeight: 36 }}>
                {t.tagline}
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, minHeight: 100 }}>
                {t.perks.map((p) => (
                  <div key={p} className="perk">
                    <span className="perk-check" style={{ color: t.color }}>✓</span>
                    <span>{p}</span>
                  </div>
                ))}
              </div>
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
                {isCurrent ? "Current plan" : busy === t.tier ? "…" : `Get ${t.name}`}
              </button>
            </div>
          );
        })}
      </div>

      <p className="muted" style={{ fontSize: 12, marginTop: 20, textAlign: "center" }}>
        Monthly, in crypto. Cancel anytime — tier stays until the end of the paid month.
      </p>
    </>
  );
}

// ─── PURCHASES tab ────────────────────────────────────────────

function Purchases() {
  const [orders, setOrders] = useState<Order[] | null>(null);

  useEffect(() => {
    fetch("/api/orders")
      .then((r) => r.json())
      .then(setOrders);
  }, []);

  if (orders === null) return <p className="muted">Loading…</p>;
  if (orders.length === 0)
    return (
      <>
        <div className="section-label">Order History</div>
        <p className="muted" style={{ padding: 40, textAlign: "center" }}>
          No purchases yet. Head to <strong>Stock</strong> to buy your first account.
        </p>
      </>
    );

  return (
    <>
      <div className="section-label">Order History</div>
      <table className="table">
        <thead>
          <tr>
            <th>Account</th>
            <th>Date</th>
            <th>Price</th>
            <th>Status</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.id}>
              <td>
                {o.products?.name ?? "Random account"}{" "}
                <span className="muted">({o.products?.region ?? "—"})</span>
              </td>
              <td className="muted">{new Date(o.created_at).toLocaleDateString()}</td>
              <td style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{eur(o.price_cents)}</td>
              <td>
                <span className={`pill ${o.status}`}>{o.status.replace("_", " ")}</span>
              </td>
              <td>
                <a href={`/orders/${o.id}`}>View</a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function errorText(code: string) {
  return (
    {
      out_of_stock: "No accounts left in that bracket right now.",
      invalid_region: "Invalid region.",
      invalid_bracket: "Invalid bracket.",
      auth_required: "Please sign in again.",
      payment_provider_error: "Payment couldn't be started. Try again in a moment.",
      order_create_failed: "Couldn't create the order — try again.",
    }[code] ?? code
  );
}

// ─── ADMIN tab (unchanged, inherits new styling) ─────────────

interface AdminProduct {
  id: string;
  slug: string;
  name: string;
  region: string;
  rank: string | null;
  price_cents: number;
  currency: string;
  in_stock: number;
}
interface Overview {
  stats: { revenueCents: number; ordersFulfilled: number; inStock: number; needsAttention: number };
  products: AdminProduct[];
  orders: (Order & { users: { discord_username: string; discord_id: string } | null; charge_cents: number })[];
}

function Admin() {
  const [data, setData] = useState<Overview | null>(null);
  const reload = useCallback(() => fetch("/api/admin/overview").then((r) => r.json()).then(setData), []);
  useEffect(() => { reload(); }, [reload]);
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="section-label">Overview</div>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", marginBottom: 20 }}>
        <div className="stat"><div className="muted">Revenue</div><div className="n">{eur(data.stats.revenueCents)}</div></div>
        <div className="stat"><div className="muted">Sold</div><div className="n">{data.stats.ordersFulfilled}</div></div>
        <div className="stat"><div className="muted">In stock</div><div className="n">{data.stats.inStock}</div></div>
        <div className="stat"><div className="muted">Attention</div><div className="n" style={{ color: data.stats.needsAttention ? "var(--accent)" : undefined }}>{data.stats.needsAttention}</div></div>
      </div>

      <div className="section-label">Give Credit</div>
      <div className="grid" style={{ gridTemplateColumns: "1fr" }}>
        <GiveCredit onDone={reload} />
      </div>

      <div className="section-label" style={{ marginTop: 28 }}>Recent Orders</div>
      <table className="table">
        <thead><tr><th>Buyer</th><th>Account</th><th>Charge</th><th>Status</th></tr></thead>
        <tbody>
          {data.orders.map((o) => (
            <tr key={o.id}>
              <td>{o.users?.discord_username ?? "—"} <span className="muted">{o.users?.discord_id}</span></td>
              <td>{o.products?.name ?? "—"}</td>
              <td>{eur(o.charge_cents)}</td>
              <td><span className={`pill ${o.status}`}>{o.status.replace("_", " ")}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function GiveCredit({ onDone }: { onDone: () => void }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true); setMsg("");
    const res = await fetch("/api/admin/credit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(Object.fromEntries(f)),
    });
    const data = await res.json();
    setBusy(false);
    setMsg(res.ok ? "✓ Saved" : `✗ ${data.error}`);
    if (res.ok) onDone();
  }
  return (
    <form className="card" onSubmit={submit}>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>For refunds and goodwill. The buyer must have logged in at least once.</p>
      <label>Buyer Discord ID</label><input className="input" name="discord_id" required />
      <label>Amount (€)</label><input className="input" name="amount_eur" type="number" step="0.01" required />
      <label>Order ID (optional — marks it refunded)</label><input className="input" name="order_id" />
      <label>Reason</label><input className="input" name="reason" placeholder="replacement unavailable" />
      <div className="row spread" style={{ marginTop: 14 }}><button className="btn sm" disabled={busy}>Give credit</button><span className="muted">{msg}</span></div>
    </form>
  );
}
