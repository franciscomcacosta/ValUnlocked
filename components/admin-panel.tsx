"use client";

// Admin panel — Overview, Users, Orders, Claims, Tools.
// Every action goes through /api/admin/* (requireAdmin on the server) and is
// logged to the staff channel there.

import { useCallback, useEffect, useState, type ReactNode } from "react";

// ----- helpers ---------------------------------------------------

type Json = Record<string, unknown>;

async function api<T = Json>(path: string, body?: unknown): Promise<T & { ok?: boolean; error?: string; message?: string }> {
  const res = await fetch(path, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok && !data.error) data.error = `HTTP ${res.status}`;
  return data;
}

const eur = (c: number | null | undefined) => `€${((c ?? 0) / 100).toFixed(2)}`;
const ref = (id: string) => `VU-${id.slice(0, 8).toUpperCase()}`;
const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" }) : "—");
const ago = (iso: string | null | undefined) => {
  if (!iso) return "never";
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const paid = (o: { credit_used_cents?: number | null; charge_cents?: number | null }) => (o.credit_used_cents ?? 0) + (o.charge_cents ?? 0);

const STATUS_PILL: Record<string, string> = {
  fulfilled: "g", paid: "a", confirmed: "a", confirming: "b", sending: "b", waiting: "x", pending: "x",
  partially_paid: "r", failed: "r", expired: "x", cancelled: "x", refunded_credit: "t",
  submitted: "a", under_review: "b", refunded: "t", replaced: "g", reissued: "g", denied: "r",
  active: "g", grace: "a",
};
function Pill({ s }: { s: string }) {
  return <span className={`pill ${STATUS_PILL[s] ?? "x"}`}>{s.replace(/_/g, " ")}</span>;
}

function Card({ children, style }: { children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div className="cs" style={{ padding: "14px 16px", background: "var(--vu-surface-alt)", display: "flex", flexDirection: "column", gap: "8px", ...style }}>
      {children}
    </div>
  );
}

function Note({ msg }: { msg: { ok: boolean; text: string } | null }) {
  if (!msg) return null;
  return <span style={{ fontSize: "13px", color: msg.ok ? "var(--accent-success)" : "var(--accent-rose)" }}>{msg.text}</span>;
}

/** Runs an admin action and turns its reply into a status line. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = useCallback(async (path: string, body: unknown, after?: () => void) => {
    setBusy(true);
    setMsg(null);
    try {
      const d = await api(path, body);
      setMsg(d.error ? { ok: false, text: d.error } : { ok: true, text: d.message ?? "Done." });
      if (!d.error) after?.();
    } catch (e) {
      setMsg({ ok: false, text: String(e) });
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, msg, setMsg, run };
}

// ----- shell -----------------------------------------------------

type Sub = "overview" | "users" | "orders" | "claims" | "emails" | "referrals" | "tools";

export function AdminPanel({ tools }: { tools: ReactNode }) {
  const [sub, setSub] = useState<Sub>("overview");
  const [orderFilter, setOrderFilter] = useState("all");

  return (
    <section className="pn cut" style={{ height: "100%", padding: "20px 24px", display: "flex", flexDirection: "column", gap: "16px", minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: "16px", flexWrap: "wrap" }}>
        <span className="lbl" style={{ flex: 1 }}>Admin</span>
        <div className="seg" role="group" aria-label="Admin section">
          {(["overview", "users", "orders", "claims", "emails", "referrals", "tools"] as Sub[]).map((k) => (
            <button key={k} className={sub === k ? "on" : ""} onClick={() => setSub(k)}>
              {k[0].toUpperCase() + k.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        {sub === "overview" && (
          <Overview
            goClaims={() => setSub("claims")}
            goEmails={() => setSub("emails")}
            goStuck={() => { setOrderFilter("stuck"); setSub("orders"); }}
          />
        )}
        {sub === "users" && <Users />}
        {sub === "orders" && <Orders filter={orderFilter} setFilter={setOrderFilter} />}
        {sub === "claims" && <Claims />}
        {sub === "emails" && <Emails />}
        {sub === "referrals" && <Referrals />}
        {sub === "tools" && tools}
      </div>
    </section>
  );
}

// ----- Overview --------------------------------------------------

type Dash = {
  revenue: { day: number; week: number; month: number; all: number };
  topupsMonthCents: number;
  orders: { total: number; day: number; fulfilled: number; byStatus: Record<string, number> };
  users: { total: number; newWeek: number; creditOutstandingCents: number };
  subs: { total: number; tiers: Record<string, number> };
  stock: { total: number; byRegion: Record<string, number>; lastSyncAt: string | null };
  attention: { openClaims: number; stuckOrders: number; emailsNeeded?: number };
  qvspBalance: { cents: number; currency: string } | null;
  profit?: { day: number; week: number; month: number; all: number };
  giftCostMonthCents?: number;
  refundedLossMonthCents?: number;
  membershipMonthCents?: number;
  margins?: Array<{ name: string; label: string; sold: number; revenue: number; cost: number; profit: number }>;
  ratings?: { count: number; avg: number | null; monthCount: number; monthAvg: number | null };
  salesPause?: { paused: boolean; by?: string; reason?: string; since?: string };
};

function Stat({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card style={{ gap: "4px" }}>
      <span className="lbl">{label}</span>
      <span className="h num" style={{ fontSize: "26px" }}>{value}</span>
      {sub && <span className="mut" style={{ fontSize: "12px" }}>{sub}</span>}
    </Card>
  );
}

function SalesSwitch({ pause, onChanged }: { pause: { paused: boolean; by?: string; reason?: string; since?: string }; onChanged: () => void }) {
  const act = useAction();
  return (
    <Card style={{ flexDirection: "row", alignItems: "center", gap: "12px", flexWrap: "wrap", background: pause.paused ? "#ffe4e6" : undefined }}>
      <span className={`pill ${pause.paused ? "r" : "g"}`}>{pause.paused ? "Sales paused" : "Sales open"}</span>
      <span className="mut" style={{ flex: 1, fontSize: "13px" }}>
        {pause.paused
          ? `${pause.by === "auto" ? "Paused automatically" : "Paused by staff"}${pause.reason ? ` — ${pause.reason}` : ""}${pause.since ? ` · ${ago(pause.since)}` : ""}`
          : "Buyers can purchase. Sales pause automatically if the qvsp balance can't cover an account."}
      </span>
      <button
        className={`btn ${pause.paused ? "btn-dark" : "btn-red"} cs btn-sm`}
        disabled={act.busy}
        onClick={() => act.run("/api/admin/flags", { paused: !pause.paused }, onChanged)}
      >
        {pause.paused ? "Resume sales" : "Pause sales"}
      </button>
      <Note msg={act.msg} />
    </Card>
  );
}

function Overview({ goClaims, goStuck, goEmails }: { goClaims: () => void; goStuck: () => void; goEmails: () => void }) {
  const [d, setD] = useState<Dash | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => {
    api<Dash>("/api/admin/dashboard").then((r) => (r.error ? setErr(r.error) : setD(r))).catch((e) => setErr(String(e)));
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  if (err) return <span style={{ color: "var(--accent-rose)" }}>{err}</span>;
  if (!d) return <span className="mut">Loading…</span>;

  const syncAge = d.stock.lastSyncAt ? (Date.now() - new Date(d.stock.lastSyncAt).getTime()) / 1000 : Infinity;
  const watcherOk = syncAge < 180;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      {(d.attention.openClaims > 0 || d.attention.stuckOrders > 0 || (d.attention.emailsNeeded ?? 0) > 0 || !watcherOk) && (
        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {d.attention.openClaims > 0 && (
            <button className="btn btn-red cs btn-sm" onClick={goClaims}>{d.attention.openClaims} open claim{d.attention.openClaims === 1 ? "" : "s"} →</button>
          )}
          {d.attention.stuckOrders > 0 && (
            <button className="btn btn-gold cs btn-sm" onClick={goStuck}>{d.attention.stuckOrders} stuck deliver{d.attention.stuckOrders === 1 ? "y" : "ies"} →</button>
          )}
          {(d.attention.emailsNeeded ?? 0) > 0 && (
            <button className="btn btn-gold cs btn-sm" onClick={goEmails}>
              {d.attention.emailsNeeded} email{d.attention.emailsNeeded === 1 ? "" : "s"} to add →
            </button>
          )}
          {!watcherOk && <span className="pill r">Stock watcher looks down — last sync {ago(d.stock.lastSyncAt)}</span>}
        </div>
      )}

      <SalesSwitch pause={d.salesPause ?? { paused: false }} onChanged={load} />

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "10px" }}>
        <Stat label="Revenue 24h" value={eur(d.revenue.day)} sub={`7d ${eur(d.revenue.week)}`} />
        {d.profit && (
          <Stat
            label="Profit 24h"
            value={<span style={{ color: d.profit.day < 0 ? "var(--accent-rose)" : undefined }}>{eur(d.profit.day)}</span>}
            sub={`7d ${eur(d.profit.week)} · 30d ${eur(d.profit.month)}`}
          />
        )}
        {d.profit && <Stat label="Profit all time" value={eur(d.profit.all)} sub="Paid by buyers − qvsp cost" />}
        {d.membershipMonthCents !== undefined && <Stat label="Memberships 30d" value={eur(d.membershipMonthCents)} sub="Plan payments (pure profit)" />}
        <Stat label="Revenue 30d" value={eur(d.revenue.month)} sub={`All time ${eur(d.revenue.all)}`} />
        <Stat label="Top-ups 30d" value={eur(d.topupsMonthCents)} sub="Credit bought with crypto" />
        <Stat label="Orders 24h" value={d.orders.day} sub={`${d.orders.fulfilled} delivered · ${d.orders.total} total`} />
        <Stat label="Members" value={d.subs.total} sub={`Std ${d.subs.tiers.standard ?? 0} · Prem ${d.subs.tiers.premium ?? 0} · Ultra ${d.subs.tiers.ultra ?? 0}`} />
        <Stat label="Users" value={d.users.total} sub={`+${d.users.newWeek} this week`} />
        <Stat label="Credit owed" value={eur(d.users.creditOutstandingCents)} sub="Sum of all balances" />
        {d.ratings && (
          <Stat
            label="Rating"
            value={d.ratings.avg != null ? `${d.ratings.avg.toFixed(1)} ⭐` : "—"}
            sub={`${d.ratings.count} vouch${d.ratings.count === 1 ? "" : "es"}${d.ratings.monthAvg != null ? ` · 30d ${d.ratings.monthAvg.toFixed(1)}` : ""}`}
          />
        )}
        <Stat
          label="qvsp balance"
          value={d.qvspBalance ? `${(d.qvspBalance.cents / 100).toFixed(2)} ${d.qvspBalance.currency.toUpperCase()}` : "—"}
          sub={d.qvspBalance && d.qvspBalance.cents < 2000 ? <span style={{ color: "var(--accent-rose)" }}>Low — top up qvsp</span> : "Pays for deliveries"}
        />
      </div>

      <Card>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span className="h" style={{ fontSize: "20px", flex: 1 }}>Live stock · {d.stock.total}</span>
          <span className={`pill ${watcherOk ? "g" : "r"}`}>Watcher {watcherOk ? "live" : "down"} · {ago(d.stock.lastSyncAt)}</span>
        </div>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {["EU", "NA", "AP", "KR", "LATAM", "BR"].map((r) => (
            <span key={r} className="pill x" style={{ fontSize: "13px" }}>{r} <b className="num">{d.stock.byRegion[r] ?? 0}</b></span>
          ))}
        </div>
      </Card>

      {d.margins && (
        <Card>
          <span className="h" style={{ fontSize: "20px" }}>Margins by skin range · last 30 days</span>
          {d.margins.length === 0 ? (
            <span className="mut">No sales in the last 30 days.</span>
          ) : (
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ paddingLeft: "16px" }}>Range</th>
                  <th style={{ textAlign: "right" }}>Sold</th>
                  <th style={{ textAlign: "right" }}>Revenue</th>
                  <th style={{ textAlign: "right" }}>qvsp cost</th>
                  <th style={{ textAlign: "right" }}>Profit</th>
                  <th style={{ textAlign: "right", paddingRight: "16px" }}>Margin</th>
                </tr>
              </thead>
              <tbody>
                {d.margins.map((m) => {
                  const margin = m.revenue ? Math.round((m.profit / m.revenue) * 100) : null;
                  const bad = m.profit < 0;
                  return (
                    <tr key={m.name}>
                      <td style={{ paddingLeft: "16px", fontWeight: 600 }}>{m.label}</td>
                      <td className="num" style={{ textAlign: "right" }}>{m.sold}</td>
                      <td className="num" style={{ textAlign: "right" }}>{eur(m.revenue)}</td>
                      <td className="num mut" style={{ textAlign: "right" }}>{eur(m.cost)}</td>
                      <td className="num" style={{ textAlign: "right", fontWeight: 600, color: bad ? "var(--accent-rose)" : "var(--accent-success)" }}>{eur(m.profit)}</td>
                      <td style={{ textAlign: "right", paddingRight: "16px" }}>
                        {margin == null ? "—" : <span className={`pill ${margin < 0 ? "r" : margin < 20 ? "a" : "g"}`}>{margin}%</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <span className="mut" style={{ fontSize: "12px" }}>
            Refunded orders count as revenue €0 (the account was still paid for)
            {d.refundedLossMonthCents ? ` — ${eur(d.refundedLossMonthCents)} lost to refunds this month` : ""}.
            {d.giftCostMonthCents ? ` Free gift accounts cost ${eur(d.giftCostMonthCents)} this month (not in the table).` : ""}
          </span>
        </Card>
      )}

      <Card>
        <span className="h" style={{ fontSize: "20px" }}>Orders by status</span>
        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
          {Object.entries(d.orders.byStatus).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
            <span key={s} style={{ display: "inline-flex", gap: "4px", alignItems: "center" }}><Pill s={s} /><span className="num">{n}</span></span>
          ))}
        </div>
      </Card>
    </div>
  );
}

// ----- Users -----------------------------------------------------

type UserRow = { id: string; discord_id: string; discord_username: string | null; credit_cents: number; created_at: string; tier?: string | null };
type OrderRow = {
  id: string; status: string; price_cents: number; credit_used_cents: number | null; charge_cents: number | null;
  created_at: string; fulfilled_at?: string | null; inventory_id?: string | null; pay_currency?: string | null;
  products: { name: string } | null; users?: { discord_id: string; discord_username: string | null } | null;
};
type UserDetail = {
  user: UserRow;
  sub: { tier: string; status: string; period_end: string } | null;
  orders: OrderRow[];
  spentCents: number;
  ledger: Array<{ id: number; delta_cents: number; reason: string; order_id: string | null; created_at: string }>;
  claims: Array<{ id: string; order_id: string; reason: string; status: string; forward_error: string | null; created_at: string }>;
  referral?: { code: string | null; invited: number; referredBy: { id: string; name: string } | null; rewarded: boolean };
  claimRate?: { claims: number; orders: number; flagged: boolean } | null;
};

function Users() {
  const [q, setQ] = useState("");
  const [list, setList] = useState<UserRow[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const search = useCallback((term: string) => {
    api<{ users: UserRow[] }>(`/api/admin/users?q=${encodeURIComponent(term)}`).then((r) => setList(r.users ?? []));
  }, []);
  useEffect(() => {
    const t = setTimeout(() => search(q), 250);
    return () => clearTimeout(t);
  }, [q, search]);

  if (selected) return <UserProfile id={selected} back={() => { setSelected(null); search(q); }} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <input className="inp" type="search" placeholder="Search by Discord username or ID…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: "420px" }} />
      {list === null ? (
        <span className="mut">Loading…</span>
      ) : list.length === 0 ? (
        <span className="mut">No users found.</span>
      ) : (
        <table className="tbl click">
          <thead>
            <tr>
              <th style={{ paddingLeft: "16px" }}>User</th>
              <th>Discord ID</th>
              <th>Plan</th>
              <th style={{ textAlign: "right" }}>Credit</th>
              <th style={{ paddingRight: "16px" }}>Joined</th>
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id} onClick={() => setSelected(u.id)} style={{ cursor: "pointer" }}>
                <td style={{ paddingLeft: "16px", fontWeight: 600 }}>{u.discord_username ?? "—"}</td>
                <td className="mono" style={{ fontSize: "12px" }}>{u.discord_id}</td>
                <td>{u.tier ? <Pill s={u.tier} /> : <span className="mut">—</span>}</td>
                <td className="num" style={{ textAlign: "right" }}>{eur(u.credit_cents)}</td>
                <td className="mut" style={{ paddingRight: "16px" }}>{when(u.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function UserProfile({ id, back }: { id: string; back: () => void }) {
  const [d, setD] = useState<UserDetail | null>(null);
  const load = useCallback(() => {
    api<UserDetail>(`/api/admin/users?id=${id}`).then((r) => setD(r.error ? null : r));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const credit = useAction();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [creditDm, setCreditDm] = useState(true);

  const plan = useAction();
  const [tier, setTier] = useState("premium");
  const [days, setDays] = useState("30");
  const [planDm, setPlanDm] = useState(true);

  const dm = useAction();
  const [message, setMessage] = useState("");

  if (!d) return <span className="mut">Loading…</span>;
  const u = d.user;

  const doCredit = (sign: 1 | -1) => {
    const n = Number(amount);
    if (!n || n <= 0) return credit.setMsg({ ok: false, text: "Enter a positive amount in euros." });
    credit.run("/api/admin/users", { action: "credit", userId: u.id, amount_eur: sign * n, reason, dm: creditDm }, () => {
      setAmount("");
      setReason("");
      load();
    });
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <button className="btn btn-soft cs btn-sm" onClick={back}>← Users</button>
        <span className="h" style={{ fontSize: "24px" }}>{u.discord_username ?? u.discord_id}</span>
        <span className="mono mut" style={{ fontSize: "12px" }}>{u.discord_id}</span>
        {d.sub && ["active", "grace"].includes(d.sub.status) ? (
          <span className="pill g">{d.sub.tier} until {new Date(d.sub.period_end).toLocaleDateString("en-GB")}</span>
        ) : (
          <span className="pill x">No plan</span>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(170px, 1fr))", gap: "10px" }}>
        <Stat label="Credit" value={eur(u.credit_cents)} />
        <Stat label="Spent" value={eur(d.spentCents)} sub="Delivered orders" />
        <Stat label="Orders" value={d.orders.length} sub={`${d.orders.filter((o) => o.status === "fulfilled").length} delivered`} />
        <Stat label="Joined" value={new Date(u.created_at).toLocaleDateString("en-GB")} />
        {d.claimRate && (
          <Stat
            label="Claims"
            value={<span style={{ color: d.claimRate.flagged ? "var(--accent-rose)" : undefined }}>{d.claimRate.claims}</span>}
            sub={
              d.claimRate.flagged
                ? <span style={{ color: "var(--accent-rose)" }}>⚠️ High claim rate — {d.claimRate.claims} on {d.claimRate.orders} orders</span>
                : `on ${d.claimRate.orders} delivered order${d.claimRate.orders === 1 ? "" : "s"}`
            }
          />
        )}
        <Stat
          label="Referrals"
          value={d.referral?.invited ?? 0}
          sub={
            d.referral?.referredBy
              ? <>Invited by {d.referral.referredBy.name}{d.referral.rewarded ? " · reward paid" : ""}</>
              : d.referral?.code ? <>Code {d.referral.code}</> : "Friends they invited"
          }
        />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "10px" }}>
        <Card>
          <span className="h" style={{ fontSize: "20px" }}>Store credit</span>
          <input className="inp num" type="number" min="0" step="0.01" placeholder="Amount in €" value={amount} onChange={(e) => setAmount(e.target.value)} />
          <input className="inp" type="text" placeholder="Reason (saved in their history)" maxLength={120} value={reason} onChange={(e) => setReason(e.target.value)} />
          <label style={{ fontSize: "13px", display: "flex", gap: "6px", alignItems: "center" }}>
            <input type="checkbox" checked={creditDm} onChange={(e) => setCreditDm(e.target.checked)} /> DM them about it
          </label>
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="btn btn-dark cs btn-sm" disabled={credit.busy} onClick={() => doCredit(1)}>+ Add</button>
            <button className="btn btn-red cs btn-sm" disabled={credit.busy} onClick={() => doCredit(-1)}>− Remove</button>
          </div>
          <span className="mut" style={{ fontSize: "12px" }}>Removing never takes them below €0.</span>
          <Note msg={credit.msg} />
        </Card>

        <Card>
          <span className="h" style={{ fontSize: "20px" }}>Membership</span>
          <select className="inp" value={tier} onChange={(e) => setTier(e.target.value)}>
            <option value="standard">Standard</option>
            <option value="premium">Premium</option>
            <option value="ultra">Ultra</option>
          </select>
          <input className="inp num" type="number" min="1" max="365" value={days} onChange={(e) => setDays(e.target.value)} placeholder="Days" />
          <label style={{ fontSize: "13px", display: "flex", gap: "6px", alignItems: "center" }}>
            <input type="checkbox" checked={planDm} onChange={(e) => setPlanDm(e.target.checked)} /> DM them about it
          </label>
          <div style={{ display: "flex", gap: "8px" }}>
            <button className="btn btn-dark cs btn-sm" disabled={plan.busy} onClick={() => plan.run("/api/admin/users", { action: "plan", userId: u.id, tier, days, dm: planDm }, load)}>
              Give plan
            </button>
            <button
              className="btn btn-red cs btn-sm"
              disabled={plan.busy || !d.sub || !["active", "grace"].includes(d.sub.status)}
              onClick={() => plan.run("/api/admin/users", { action: "plan", userId: u.id, tier: "remove" }, load)}
            >
              Remove plan
            </button>
          </div>
          <span className="mut" style={{ fontSize: "12px" }}>Same plan extends it; a different plan switches. Discord role updates too.</span>
          <Note msg={plan.msg} />
        </Card>

        <Card>
          <span className="h" style={{ fontSize: "20px" }}>Message on Discord</span>
          <textarea className="inp" rows={4} maxLength={1800} placeholder="Sent as a DM from the bot" value={message} onChange={(e) => setMessage(e.target.value)} style={{ height: "auto", paddingTop: "8px", resize: "vertical" }} />
          <button className="btn btn-dark cs btn-sm" style={{ alignSelf: "flex-start" }} disabled={dm.busy || !message.trim()} onClick={() => dm.run("/api/admin/users", { action: "dm", userId: u.id, message }, () => setMessage(""))}>
            Send DM
          </button>
          <Note msg={dm.msg} />
        </Card>
      </div>

      <Card>
        <span className="h" style={{ fontSize: "20px" }}>Orders</span>
        <OrderTable orders={d.orders} onChanged={load} showBuyer={false} />
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "10px" }}>
        <Card>
          <span className="h" style={{ fontSize: "20px" }}>Credit history</span>
          {d.ledger.length === 0 ? <span className="mut">Nothing yet.</span> : d.ledger.map((l) => (
            <div key={l.id} className="kv" style={{ fontSize: "13px", gap: "10px" }}>
              <span className="mut" style={{ whiteSpace: "nowrap" }}>{when(l.created_at)}</span>
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={l.reason}>{l.reason}</span>
              <span className="num" style={{ fontWeight: 600, color: l.delta_cents >= 0 ? "var(--accent-success)" : "var(--accent-rose)" }}>
                {l.delta_cents >= 0 ? "+" : "−"}{eur(Math.abs(l.delta_cents))}
              </span>
            </div>
          ))}
        </Card>
        <Card>
          <span className="h" style={{ fontSize: "20px" }}>Claims</span>
          {d.claims.length === 0 ? <span className="mut">No claims.</span> : d.claims.map((c) => (
            <div key={c.id} className="kv" style={{ fontSize: "13px", gap: "10px" }}>
              <span className="mono">{ref(c.order_id)}</span>
              <span className="mut" style={{ flex: 1 }}>{c.reason}</span>
              <Pill s={c.status} />
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ----- Orders ----------------------------------------------------

const ORDER_FILTERS: Array<[string, string]> = [
  ["all", "All"], ["stuck", "Stuck"], ["paid", "Paid"], ["fulfilled", "Delivered"],
  ["pending", "Unpaid"], ["partially_paid", "Part-paid"], ["refunded_credit", "Refunded"], ["failed", "Failed"],
];

function Orders({ filter, setFilter }: { filter: string; setFilter: (f: string) => void }) {
  const [q, setQ] = useState("");
  const [orders, setOrders] = useState<OrderRow[] | null>(null);
  const load = useCallback(() => {
    setOrders(null);
    api<{ orders: OrderRow[] }>(`/api/admin/orders?status=${filter}&q=${encodeURIComponent(q)}`).then((r) => setOrders(r.orders ?? []));
  }, [filter, q]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div style={{ display: "flex", gap: "10px", flexWrap: "wrap", alignItems: "center" }}>
        <div className="seg" role="group" aria-label="Order status" style={{ flexWrap: "wrap" }}>
          {ORDER_FILTERS.map(([k, label]) => (
            <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        <input className="inp" type="search" placeholder="VU-XXXXXXXX or username" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: "260px" }} />
      </div>
      {orders === null ? <span className="mut">Loading…</span> : <OrderTable orders={orders} onChanged={load} showBuyer />}
    </div>
  );
}

function OrderTable({ orders, onChanged, showBuyer }: { orders: OrderRow[]; onChanged: () => void; showBuyer: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!orders.length) return <span className="mut">No orders.</span>;
  return (
    <table className="tbl">
      <thead>
        <tr>
          <th style={{ paddingLeft: "16px" }}>Order</th>
          {showBuyer && <th>Buyer</th>}
          <th>Product</th>
          <th style={{ textAlign: "right" }}>Paid</th>
          <th>Status</th>
          <th>Date</th>
          <th style={{ paddingRight: "16px" }} />
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <OrderLine key={o.id} o={o} showBuyer={showBuyer} open={open === o.id} toggle={() => setOpen(open === o.id ? null : o.id)} onChanged={onChanged} />
        ))}
      </tbody>
    </table>
  );
}

function OrderLine({ o, showBuyer, open, toggle, onChanged }: { o: OrderRow; showBuyer: boolean; open: boolean; toggle: () => void; onChanged: () => void }) {
  const act = useAction();
  const [amount, setAmount] = useState((paid(o) / 100).toFixed(2));
  const [reason, setReason] = useState("");
  const stuck = o.status === "paid" && !o.inventory_id;
  const refundable = ["fulfilled", "paid", "partially_paid", "failed"].includes(o.status);
  const cancellable = ["pending", "waiting"].includes(o.status);
  const cols = showBuyer ? 7 : 6;

  return (
    <>
      <tr>
        <td className="mono" style={{ paddingLeft: "16px" }}><a href={`/orders/${o.id}`} style={{ color: "inherit" }}>{ref(o.id)}</a></td>
        {showBuyer && <td>{o.users?.discord_username ?? o.users?.discord_id ?? "—"}</td>}
        <td style={{ maxWidth: "220px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{o.products?.name ?? "—"}</td>
        <td className="num" style={{ textAlign: "right" }} title={`credit ${eur(o.credit_used_cents)} + crypto ${eur(o.charge_cents)}`}>{eur(paid(o))}</td>
        <td>{stuck ? <span className="pill r">stuck</span> : <Pill s={o.status} />}</td>
        <td className="mut" style={{ whiteSpace: "nowrap" }}>{when(o.created_at)}</td>
        <td style={{ paddingRight: "16px", textAlign: "right", whiteSpace: "nowrap" }}>
          {stuck && (
            <button className="btn btn-gold cs btn-sm" disabled={act.busy} onClick={() => act.run("/api/admin/orders", { action: "retry", orderId: o.id }, onChanged)}>
              {act.busy ? "…" : "Retry"}
            </button>
          )}{" "}
          {cancellable && (
            <button className="btn btn-soft cs btn-sm" disabled={act.busy} onClick={() => act.run("/api/admin/orders", { action: "cancel", orderId: o.id }, onChanged)}>
              Cancel
            </button>
          )}{" "}
          {refundable && <button className="btn btn-soft cs btn-sm" onClick={toggle}>{open ? "Close" : "Refund"}</button>}
        </td>
      </tr>
      {(open || act.msg) && (
        <tr>
          <td colSpan={cols} style={{ padding: "8px 16px 12px", background: "var(--vu-surface-alt)" }}>
            {open && refundable && (
              <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                <span className="mut" style={{ fontSize: "13px" }}>Refund to credit €</span>
                <input className="inp num" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: "100px" }} />
                <input className="inp" type="text" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: "220px" }} />
                <button
                  className="btn btn-red cs btn-sm"
                  disabled={act.busy}
                  onClick={() => act.run("/api/admin/orders", { action: "refund", orderId: o.id, amount_eur: amount, reason }, () => { toggle(); onChanged(); })}
                >
                  {act.busy ? "Refunding…" : "Confirm refund"}
                </button>
              </div>
            )}
            <Note msg={act.msg} />
          </td>
        </tr>
      )}
    </>
  );
}

// ----- Claims ----------------------------------------------------

type ClaimRow = {
  id: string; order_id: string; reason_label: string; status: string; qvsp_ticket_id: string | null; qvsp_status: string | null;
  forward_error: string | null; outcome_note: string | null; refund_cents: number; bonus_cents: number;
  video_url: string | null; created_at: string; users: { discord_id: string; discord_username: string | null } | null;
  buyer_stats?: { claims: number; orders: number; flagged: boolean } | null;
};

function Claims() {
  const [view, setView] = useState<"open" | "all">("open");
  const [claims, setClaims] = useState<ClaimRow[] | null>(null);
  const load = useCallback(() => {
    api<{ claims: ClaimRow[] }>(`/api/admin/claims?view=${view}`).then((r) => setClaims(r.claims ?? []));
  }, [view]);
  useEffect(() => { setClaims(null); load(); }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <div className="seg" role="group" aria-label="Claims view" style={{ alignSelf: "flex-start" }}>
        <button className={view === "open" ? "on" : ""} onClick={() => setView("open")}>Open</button>
        <button className={view === "all" ? "on" : ""} onClick={() => setView("all")}>All</button>
      </div>
      {claims === null ? (
        <span className="mut">Loading…</span>
      ) : claims.length === 0 ? (
        <span className="mut">{view === "open" ? "No open claims. 🎉" : "No claims yet."}</span>
      ) : (
        claims.map((c) => <ClaimCard key={c.id} c={c} onChanged={load} />)
      )}
    </div>
  );
}

function ClaimCard({ c, onChanged }: { c: ClaimRow; onChanged: () => void }) {
  const act = useAction();
  const [note, setNote] = useState("");
  const isOpen = ["submitted", "under_review"].includes(c.status);
  const notEligible = /not_eligible/.test(c.forward_error ?? "");

  return (
    <Card style={{ maxWidth: "820px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <a className="mono" href={`/orders/${c.order_id}`} style={{ color: "inherit", fontWeight: 600 }}>{ref(c.order_id)}</a>
        <span>{c.users?.discord_username ?? c.users?.discord_id ?? "—"}</span>
        <Pill s={c.status} />
        {c.buyer_stats && (
          <span
            className={`pill ${c.buyer_stats.flagged ? "r" : "x"}`}
            title="Claims this buyer has filed vs. their delivered orders"
          >
            {c.buyer_stats.flagged ? "⚠️ " : ""}{c.buyer_stats.claims} claim{c.buyer_stats.claims === 1 ? "" : "s"} / {c.buyer_stats.orders} order{c.buyer_stats.orders === 1 ? "" : "s"}
          </span>
        )}
        {c.qvsp_ticket_id && <span className="pill b">qvsp #{c.qvsp_ticket_id}{c.qvsp_status ? ` · ${c.qvsp_status}` : ""}</span>}
        <span className="mut" style={{ marginLeft: "auto", fontSize: "12px" }}>{when(c.created_at)}</span>
      </div>
      <span style={{ fontSize: "14px" }}>{c.reason_label}</span>
      <span className="mut" style={{ fontSize: "13px" }}>
        Refund if approved: {eur(c.refund_cents)} + {eur(c.bonus_cents)} bonus
        {c.video_url && <> · <a href={c.video_url} target="_blank" rel="noreferrer">Watch video</a></>}
      </span>
      {c.forward_error && (
        <span style={{ fontSize: "13px", color: "var(--accent-rose)" }}>
          {notEligible ? "qvsp won't replace this account — it was already replaced once. Decide here: refund or deny." : `Couldn't reach qvsp: ${c.forward_error}`}
        </span>
      )}
      {c.outcome_note && !isOpen && <span className="mut" style={{ fontSize: "13px" }}>Outcome: {c.outcome_note}</span>}
      {isOpen && (
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <input className="inp" type="text" placeholder="Note to buyer (optional)" maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} style={{ flex: 1, minWidth: "200px" }} />
          <button className="btn btn-dark cs btn-sm" disabled={act.busy} onClick={() => act.run("/api/admin/claims", { action: "refund", claimId: c.id, note }, onChanged)}>Refund</button>
          <button className="btn btn-red cs btn-sm" disabled={act.busy} onClick={() => act.run("/api/admin/claims", { action: "deny", claimId: c.id, note }, onChanged)}>Deny</button>
          {!c.qvsp_ticket_id && !notEligible && (
            <button className="btn btn-soft cs btn-sm" disabled={act.busy} onClick={() => act.run("/api/admin/claims", { action: "retry", claimId: c.id }, onChanged)}>Retry qvsp</button>
          )}
          {c.qvsp_ticket_id && (
            <button className="btn btn-soft cs btn-sm" disabled={act.busy} onClick={() => act.run("/api/admin/claims", { action: "sync", claimId: c.id }, onChanged)}>Check ticket</button>
          )}
        </div>
      )}
      <Note msg={act.msg} />
    </Card>
  );
}

// ----- Referrals -------------------------------------------------

type RefData = {
  settings: { rewardCents: number; friendCents: number; minOrderCents: number };
  totals: { invited: number; bought: number; inviters: number; creditPaidCents: number };
  top: Array<{ id: string; name: string; invited: number; bought: number }>;
  recent: Array<{ id: string; name: string | null; invitedBy: string; joinedAt: string | null; boughtAt: string | null }>;
};

function Referrals() {
  const [d, setD] = useState<RefData | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    api<RefData>("/api/admin/referrals").then((r) => (r.error ? setErr(r.error) : setD(r))).catch((e) => setErr(String(e)));
  }, []);
  if (err) return <span style={{ color: "var(--accent-rose)" }}>{err}</span>;
  if (!d) return <span className="mut">Loading…</span>;
  const conv = d.totals.invited ? Math.round((d.totals.bought / d.totals.invited) * 100) : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: "10px" }}>
        <Stat label="Friends invited" value={d.totals.invited} sub={`by ${d.totals.inviters} inviter${d.totals.inviters === 1 ? "" : "s"}`} />
        <Stat label="Became buyers" value={d.totals.bought} sub={`${conv}% of invites`} />
        <Stat label="Credit paid out" value={eur(d.totals.creditPaidCents)} sub="Both sides combined" />
        <Stat
          label="Current reward"
          value={`${eur(d.settings.rewardCents)} + ${eur(d.settings.friendCents)}`}
          sub={`Inviter + friend · first order ≥ ${eur(d.settings.minOrderCents)}`}
        />
      </div>
      <span className="mut" style={{ fontSize: "12px" }}>
        Change the amounts with the REFERRAL_REWARD_CENTS, REFERRAL_FRIEND_CENTS and REFERRAL_MIN_ORDER_CENTS env vars on Vercel.
      </span>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: "10px" }}>
        <Card>
          <span className="h" style={{ fontSize: "20px" }}>Top inviters</span>
          {d.top.length === 0 ? <span className="mut">Nobody yet.</span> : d.top.map((t, i) => (
            <div key={t.id} className="kv" style={{ fontSize: "14px", gap: "10px" }}>
              <span className="num mut" style={{ width: "20px" }}>{i + 1}</span>
              <span style={{ flex: 1 }}>{t.name}</span>
              <span className="mut" style={{ fontSize: "12px" }}>{t.invited} joined</span>
              <span className="pill g">{t.bought} bought</span>
            </div>
          ))}
        </Card>
        <Card>
          <span className="h" style={{ fontSize: "20px" }}>Recent sign-ups</span>
          {d.recent.length === 0 ? <span className="mut">Nobody yet.</span> : d.recent.map((r) => (
            <div key={r.id} className="kv" style={{ fontSize: "13px", gap: "10px" }}>
              <span style={{ flex: 1 }}>{r.name ?? "—"} <span className="mut">via {r.invitedBy}</span></span>
              <span className="mut" style={{ fontSize: "12px" }}>{when(r.joinedAt)}</span>
              <span className={`pill ${r.boughtAt ? "g" : "x"}`}>{r.boughtAt ? "bought" : "no order"}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ----- Emails ----------------------------------------------------
// Recovery emails the worker couldn't fetch (Riot showed a captcha).
// Staff log in to the account themselves, read the email, paste it here.

type MissingEmail = {
  orderId: string; fulfilledAt: string; buyer: string; discordId: string | null;
  login: string; password: string; emailPassword: string;
};

function CopyField({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false);
  if (!value) return null;
  return (
    <button
      className="cs"
      onClick={() => {
        try { navigator.clipboard?.writeText(value); } catch { /* blocked */ }
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
      title={`Copy ${label}`}
      style={{ border: 0, cursor: "pointer", background: "#fff", padding: "6px 10px", display: "flex", flexDirection: "column", alignItems: "flex-start", minWidth: 0, flex: "1 1 160px" }}
    >
      <span className="lbl" style={{ fontSize: "10px" }}>{label} {done ? "· copied ✓" : "· click to copy"}</span>
      <span className="mono" style={{ fontSize: "14px", fontWeight: 600, maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</span>
    </button>
  );
}

function Emails() {
  const [rows, setRows] = useState<MissingEmail[] | null>(null);
  const load = useCallback(() => {
    api<{ orders: MissingEmail[] }>("/api/admin/emails").then((r) => setRows(r.orders ?? []));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (rows === null) return <span className="mut">Loading…</span>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px", maxWidth: "820px" }}>
      <span className="mut" style={{ fontSize: "13px" }}>
        Accounts delivered in the last 14 days with no recovery email yet — usually because Riot showed a captcha to the worker.
        Log in at Riot with the details below, copy the email shown on the account, paste it here. The buyer gets it in a DM straight away.
      </span>
      {rows.length === 0 ? (
        <span className="mut">All caught up — every recent order has its email. 🎉</span>
      ) : (
        rows.map((r) => <EmailRow key={r.orderId} r={r} onSaved={load} />)
      )}
    </div>
  );
}

function EmailRow({ r, onSaved }: { r: MissingEmail; onSaved: () => void }) {
  const act = useAction();
  const [email, setEmail] = useState("");
  return (
    <Card>
      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <a className="mono" href={`/orders/${r.orderId}`} style={{ color: "inherit", fontWeight: 600 }}>{ref(r.orderId)}</a>
        <span>{r.buyer}</span>
        <span className="mut" style={{ marginLeft: "auto", fontSize: "12px" }}>delivered {ago(r.fulfilledAt)}</span>
      </div>
      <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
        <CopyField label="Login" value={r.login} />
        <CopyField label="Password" value={r.password} />
        <CopyField label="Email password" value={r.emailPassword} />
      </div>
      <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
        <a href="https://account.riotgames.com/" target="_blank" rel="noreferrer" className="btn btn-soft cs btn-sm">Open Riot login ↗</a>
        <input
          className="inp"
          type="email"
          placeholder="Paste the account's email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && email.trim()) act.run("/api/admin/emails", { orderId: r.orderId, email }, onSaved); }}
          style={{ flex: "1 1 240px" }}
        />
        <button className="btn btn-dark cs btn-sm" disabled={act.busy || !email.trim()} onClick={() => act.run("/api/admin/emails", { orderId: r.orderId, email }, onSaved)}>
          {act.busy ? "Saving…" : "Save & DM buyer"}
        </button>
      </div>
      <Note msg={act.msg} />
    </Card>
  );
}
