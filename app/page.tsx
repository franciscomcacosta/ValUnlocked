"use client";
import { useCallback, useEffect, useState } from "react";

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const tierLabel = (t: string) => t[0].toUpperCase() + t.slice(1);
const TIER_COLOR: Record<string, string> = {
  standard: "#3b82f6",
  premium: "#ff4655",
  ultra: "#ffd400",
};

interface Me {
  name: string;
  avatar: string;
  creditCents: number;
  isAdmin: boolean;
  sub: { tier: "standard" | "premium" | "ultra"; status: string; periodEnd: string } | null;
}
interface Product {
  id: string;
  slug: string;
  name: string;
  region: string;
  rank: string | null;
  price_cents: number;
  currency: string;
  in_stock: number;
}
interface Order {
  id: string;
  status: string;
  price_cents: number;
  currency: string;
  created_at: string;
  products: { name: string; region: string; rank: string | null };
}

export default function Page() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("shop");

  useEffect(() => {
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then(setMe)
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="center muted">Loading…</div>;
  if (!me) return <LoggedOut />;

  return (
    <>
      <div className="topbar">
        <div className="wrap row spread" style={{ paddingBottom: 16, paddingTop: 16 }}>
          <a href="/" className="brand" style={{ color: "inherit" }}>
            VAL<span>UNLOCKED</span>
          </a>
          <div className="row">
            {me.sub ? (
              <a
                href="/account"
                className="badge"
                style={{
                  color: TIER_COLOR[me.sub.tier],
                  borderColor: TIER_COLOR[me.sub.tier],
                  fontWeight: 700,
                }}
              >
                {me.sub.status === "grace" ? "⚠ " : ""}
                {tierLabel(me.sub.tier)}
              </a>
            ) : (
              <a href="/pricing" className="badge" style={{ color: "var(--accent)" }}>
                + Subscribe
              </a>
            )}
            <a href="/account" className="badge stock">
              Credit: {eur(me.creditCents)}
            </a>
            <img className="avatar" src={me.avatar} alt="" />
            <span className="muted">{me.name}</span>
            <form action="/api/auth/logout" method="post">
              <button className="btn ghost sm">Log out</button>
            </form>
          </div>
        </div>
      </div>
      <div className="wrap">
        <div className="tabs">
          <button className={`tab ${tab === "shop" ? "active" : ""}`} onClick={() => setTab("shop")}>
            Shop
          </button>
          <button className={`tab ${tab === "orders" ? "active" : ""}`} onClick={() => setTab("orders")}>
            My orders
          </button>
          {me.isAdmin && (
            <button className={`tab ${tab === "admin" ? "active" : ""}`} onClick={() => setTab("admin")}>
              Admin
            </button>
          )}
        </div>
        {tab === "shop" && <Shop credit={me.creditCents} />}
        {tab === "orders" && <Orders />}
        {tab === "admin" && me.isAdmin && <Admin />}
      </div>
    </>
  );
}

// ─── Landing page for signed-out visitors ────────────────────────────

function LoggedOut() {
  return (
    <>
      <div className="topbar">
        <div className="wrap row spread" style={{ paddingBottom: 16, paddingTop: 16 }}>
          <div className="brand">
            VAL<span>UNLOCKED</span>
          </div>
          <div className="row">
            <a href="/pricing" className="muted" style={{ marginRight: 8 }}>
              Pricing
            </a>
            <a className="btn sm" href="/api/auth/login">
              Sign in with Discord
            </a>
          </div>
        </div>
      </div>

      <div className="wrap">
        {/* Hero */}
        <div style={{ textAlign: "center", padding: "60px 16px 40px" }}>
          <h1 style={{ fontSize: 52, margin: 0, letterSpacing: "-1px", lineHeight: 1.1 }}>
            Valorant accounts.
            <br />
            <span style={{ color: "var(--accent)" }}>Unlocked.</span>
          </h1>
          <p className="muted" style={{ fontSize: 18, maxWidth: 580, margin: "20px auto 0" }}>
            Full-access Valorant accounts, delivered instantly. Save 10–50% with a membership and get first access to
            fresh drops.
          </p>
          <div className="row" style={{ justifyContent: "center", marginTop: 28, gap: 12 }}>
            <a className="btn" href="/api/auth/login">
              Sign in with Discord
            </a>
            <a className="btn ghost" href="/pricing">
              See pricing
            </a>
          </div>
        </div>

        {/* Quick-glance tier teasers */}
        <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", marginTop: 40 }}>
          <div className="card" style={{ textAlign: "center" }}>
            <div style={{ fontSize: 32 }}>🎟️</div>
            <h3 style={{ color: TIER_COLOR.standard, margin: "6px 0" }}>Standard</h3>
            <div className="muted" style={{ fontSize: 13 }}>€9.99/mo · 10% off</div>
          </div>
          <div
            className="card"
            style={{
              textAlign: "center",
              borderColor: TIER_COLOR.premium,
              borderWidth: 2,
              transform: "scale(1.02)",
            }}
          >
            <div style={{ fontSize: 32 }}>⚡</div>
            <h3 style={{ color: TIER_COLOR.premium, margin: "6px 0" }}>Premium</h3>
            <div className="muted" style={{ fontSize: 13 }}>€24.99/mo · 25% off + 2h early</div>
          </div>
          <div className="card" style={{ textAlign: "center" }}>
            <div style={{ fontSize: 32 }}>👑</div>
            <h3 style={{ color: TIER_COLOR.ultra, margin: "6px 0" }}>Ultra</h3>
            <div className="muted" style={{ fontSize: 13 }}>€59.99/mo · up to 50% + auto-buy</div>
          </div>
        </div>

        <div style={{ textAlign: "center", marginTop: 32, marginBottom: 60 }}>
          <a href="/pricing" className="btn">
            Compare all plans →
          </a>
        </div>

        {/* Trust signals */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: 20,
            padding: "40px 0",
            borderTop: "1px solid var(--border)",
          }}
        >
          <TrustItem emoji="⚡" title="Instant delivery" body="Credentials in your Discord DMs the moment payment confirms on-chain." />
          <TrustItem emoji="🔒" title="Crypto only" body="Pay with BTC, ETH, USDT, LTC, and more. No chargebacks, no card drama." />
          <TrustItem emoji="🔄" title="Replacement policy" body="Account issue? We replace it or credit you — no questions, no tickets lost in a void." />
        </div>
      </div>
    </>
  );
}

function TrustItem({ emoji, title, body }: { emoji: string; title: string; body: string }) {
  return (
    <div style={{ textAlign: "center" }}>
      <div style={{ fontSize: 28 }}>{emoji}</div>
      <div style={{ fontWeight: 700, marginTop: 6 }}>{title}</div>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        {body}
      </p>
    </div>
  );
}

// ─── Signed-in shop (unchanged behavior) ─────────────────────────────

function Shop({ credit }: { credit: number }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState("");

  useEffect(() => {
    fetch("/api/products")
      .then((r) => r.json())
      .then(setProducts);
  }, []);

  async function buy(slug: string) {
    setBusy(slug);
    setErr("");
    const res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ product: slug, useCredit: true }),
    });
    const data = await res.json();
    setBusy(null);
    if (!res.ok) {
      setErr(errorText(data.error));
      return;
    }
    if (data.invoiceUrl) window.location.href = data.invoiceUrl;
    else window.location.href = `/orders/${data.orderId}`;
  }

  return (
    <>
      {credit > 0 && (
        <div className="notice" style={{ marginBottom: 14 }}>
          You have {eur(credit)} in store credit — it&apos;s applied automatically at checkout.
        </div>
      )}
      {err && <p className="err">{err}</p>}
      <div className="grid">
        {products.map((p) => (
          <div className="card" key={p.id}>
            <div className="row spread">
              <span className="badge">
                {p.region}
                {p.rank ? ` · ${p.rank}` : ""}
              </span>
              <span className={`badge ${p.in_stock > 0 ? "stock" : "out"}`}>
                {p.in_stock > 0 ? `${p.in_stock} in stock` : "Sold out"}
              </span>
            </div>
            <h3 style={{ marginTop: 10 }}>{p.name}</h3>
            <div className="row spread" style={{ marginTop: 12 }}>
              <span className="price">{eur(p.price_cents)}</span>
              <button className="btn sm" disabled={p.in_stock < 1 || busy === p.slug} onClick={() => buy(p.slug)}>
                {busy === p.slug ? "…" : "Buy"}
              </button>
            </div>
          </div>
        ))}
        {products.length === 0 && <p className="muted">No accounts listed yet.</p>}
      </div>
    </>
  );
}

function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  useEffect(() => {
    fetch("/api/orders")
      .then((r) => r.json())
      .then(setOrders);
  }, []);
  if (orders.length === 0) return <p className="muted">No orders yet.</p>;
  return (
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
              {o.products.name} <span className="muted">({o.products.region})</span>
            </td>
            <td className="muted">{new Date(o.created_at).toLocaleDateString()}</td>
            <td>{eur(o.price_cents)}</td>
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
  );
}

function errorText(code: string) {
  return (
    {
      out_of_stock: "That account just sold out.",
      not_found: "That product is no longer available.",
      credit_failed: "Couldn't apply your credit — try again.",
      login_required: "Please sign in again.",
      payment_error: "Payment couldn't be started. Try again in a moment.",
    }[code] ?? "Something went wrong."
  );
}

// ---- Admin -----------------------------------------------------------------
interface Overview {
  stats: { revenueCents: number; ordersFulfilled: number; inStock: number; needsAttention: number };
  products: Product[];
  orders: (Order & { users: { discord_username: string; discord_id: string } | null; charge_cents: number })[];
}

function Admin() {
  const [data, setData] = useState<Overview | null>(null);
  const reload = useCallback(() => fetch("/api/admin/overview").then((r) => r.json()).then(setData), []);
  useEffect(() => {
    reload();
  }, [reload]);
  if (!data) return <p className="muted">Loading…</p>;

  return (
    <>
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", marginBottom: 20 }}>
        <div className="stat">
          <div className="muted">Revenue</div>
          <div className="n">{eur(data.stats.revenueCents)}</div>
        </div>
        <div className="stat">
          <div className="muted">Sold</div>
          <div className="n">{data.stats.ordersFulfilled}</div>
        </div>
        <div className="stat">
          <div className="muted">In stock</div>
          <div className="n">{data.stats.inStock}</div>
        </div>
        <div className="stat">
          <div className="muted">Needs attention</div>
          <div className="n" style={{ color: data.stats.needsAttention ? "var(--accent)" : undefined }}>
            {data.stats.needsAttention}
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: "1fr 1fr" }}>
        <AddProduct onDone={reload} />
        <AddStock products={data.products} onDone={reload} />
        <GiveCredit onDone={reload} />
      </div>

      <h3 style={{ marginTop: 28 }}>Recent orders</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Buyer</th>
            <th>Account</th>
            <th>Charge</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {data.orders.map((o) => (
            <tr key={o.id}>
              <td>
                {o.users?.discord_username ?? "—"} <span className="muted">{o.users?.discord_id}</span>
              </td>
              <td>{o.products.name}</td>
              <td>{eur(o.charge_cents)}</td>
              <td>
                <span className={`pill ${o.status}`}>{o.status.replace("_", " ")}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function useForm(url: string, onDone: () => void) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(body: Record<string, unknown>) {
    setBusy(true);
    setMsg("");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    setBusy(false);
    setMsg(res.ok ? "✓ Saved" : `✗ ${data.error}`);
    if (res.ok) onDone();
  }
  return { submit, msg, busy };
}

function AddProduct({ onDone }: { onDone: () => void }) {
  const { submit, msg, busy } = useForm("/api/admin/products", onDone);
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        submit(Object.fromEntries(f));
      }}
    >
      <h3>Add / update product</h3>
      <label>Name</label>
      <input className="input" name="name" placeholder="Plat smurf" required />
      <div className="row" style={{ gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label>Region</label>
          <input className="input" name="region" placeholder="EU" required />
        </div>
        <div style={{ flex: 1 }}>
          <label>Rank</label>
          <input className="input" name="rank" placeholder="Platinum" />
        </div>
      </div>
      <label>Price (€)</label>
      <input className="input" name="price_eur" type="number" step="0.01" placeholder="29.99" required />
      <label>Description</label>
      <input className="input" name="description" placeholder="Full access, original email included" />
      <div className="row spread" style={{ marginTop: 14 }}>
        <button className="btn sm" disabled={busy}>
          Save
        </button>
        <span className="muted">{msg}</span>
      </div>
    </form>
  );
}

function AddStock({ products, onDone }: { products: Product[]; onDone: () => void }) {
  const { submit, msg, busy } = useForm("/api/admin/stock", onDone);
  const [source, setSource] = useState("own");
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        submit(Object.fromEntries(f));
      }}
    >
      <h3>Add account to stock</h3>
      <label>Product</label>
      <select className="select" name="product_slug" required>
        {products.map((p) => (
          <option key={p.id} value={p.slug}>
            {p.name} ({p.region})
          </option>
        ))}
      </select>
      <div className="row" style={{ gap: 10 }}>
        <div style={{ flex: 1 }}>
          <label>Source</label>
          <select className="select" name="source" value={source} onChange={(e) => setSource(e.target.value)}>
            <option value="own">Own (self-leveled)</option>
            <option value="bought">Bought (full access)</option>
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label>Cost (€)</label>
          <input className="input" name="cost_eur" type="number" step="0.01" />
        </div>
      </div>
      {source === "bought" && (
        <>
          <label>Bought from (original owner)</label>
          <input className="input" name="acquired_from" placeholder="seller contact / id" required />
        </>
      )}
      <label>Riot login</label>
      <input className="input" name="login" required />
      <label>Riot password</label>
      <input className="input" name="password" required />
      <label>Email</label>
      <input className="input" name="email" required />
      <label>Email password</label>
      <input className="input" name="email_password" required />
      <div className="row spread" style={{ marginTop: 14 }}>
        <button className="btn sm" disabled={busy}>
          Add
        </button>
        <span className="muted">{msg}</span>
      </div>
    </form>
  );
}

function GiveCredit({ onDone }: { onDone: () => void }) {
  const { submit, msg, busy } = useForm("/api/admin/credit", onDone);
  return (
    <form
      className="card"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        submit(Object.fromEntries(f));
      }}
    >
      <h3>Give store credit</h3>
      <p className="muted" style={{ fontSize: 13, marginTop: 0 }}>
        For refunds and goodwill. The buyer must have logged in at least once.
      </p>
      <label>Buyer Discord ID</label>
      <input className="input" name="discord_id" required />
      <label>Amount (€)</label>
      <input className="input" name="amount_eur" type="number" step="0.01" required />
      <label>Order ID (optional — marks it refunded)</label>
      <input className="input" name="order_id" />
      <label>Reason</label>
      <input className="input" name="reason" placeholder="replacement unavailable" />
      <div className="row spread" style={{ marginTop: 14 }}>
        <button className="btn sm" disabled={busy}>
          Give credit
        </button>
        <span className="muted">{msg}</span>
      </div>
    </form>
  );
}
