// Order page — what the buyer sees after buying.
// Data: GET /api/orders/[id] (credentials only once delivered). The page
// polls every 6 s until the account is delivered and its email has arrived.
//
// States: waiting for payment → delivering → delivered (+ email arriving)
//         · refunded · failed

"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LockLogo } from "@/components/lock-logo";
import { ReportProblemModal, ClaimStatusCard, AccountCheckPrompt, type ClaimSummary } from "@/components/claims";

type Credential = { key: string; value: string; copyAs?: string };
type Skin = { name: string; weapon: string; tier: string; img?: string | null };
type TimelineStep = { label: string; at: string | null; done: boolean };

type OrderPayload = {
  id: string;
  display_id: string;
  status: "pending" | "reserved" | "delivered" | "failed" | "refunded";
  bracket_label: string | null;
  region: string | null;
  rank: string | null;
  rank_tier: string | null;
  rank_icon?: string | null;
  peak_rank: string | null;
  last_played_relative: string | null;
  delivered_at: string | null;
  created_at?: string;
  price_paid_cents: number;
  price_original_cents: number | null;
  sub_tier: "Standard" | "Premium" | "Ultra" | null;
  payment_method: "credit" | "crypto" | "card" | null;
  level: number | null;
  skin_count: number | null;
  vp: number | null;
  credentials: Credential[] | null;
  skins_preview: Skin[];
  skins_total: number;
  timeline: TimelineStep[];
  claim_window_ends_at: string | null;
  claims: ClaimSummary[];
  pay_url?: string | null;
  hold_ends_at?: string | null;
};

const REGION: Record<string, string> = {
  EU: "Europe", NA: "North America", AP: "Asia Pacific", KR: "Korea", LATAM: "Latin America", BR: "Brazil",
};
const TIER_COLOR: Record<string, string> = {
  Standard: "#9aa5b1", Premium: "#d1548d", Exclusive: "#f5955b", Ultra: "#fad663",
};
const TIER_RANK: Record<string, number> = { Ultra: 4, Exclusive: 3, Premium: 2, Standard: 1 };

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const isEmailKey = (k: string) => k === "Email" || k === "Email password";
const isBlank = (v: string | null | undefined) => !v || v.trim() === "" || v.trim() === "—";
const emailPending = (d: OrderPayload) => isBlank(d.credentials?.find((c) => c.key === "Email")?.value);
const when = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";

// ─── small pieces ───────────────────────────────────────────────────

function CopyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {off && <path d="m3 3 18 18" />}
    </svg>
  );
}

function StatusBadge({ status, emailWaiting }: { status: OrderPayload["status"]; emailWaiting: boolean }) {
  const map: Record<OrderPayload["status"], { text: string; bg: string; fg: string }> = {
    delivered: { text: emailWaiting ? "Delivered · email coming" : "Delivered", bg: "#4ade80", fg: "#0f1923" },
    reserved: { text: "Delivering…", bg: "#22d3ee", fg: "#0f1923" },
    pending: { text: "Waiting for payment", bg: "#ffd400", fg: "#0f1923" },
    refunded: { text: "Refunded", bg: "#a5b4fc", fg: "#0f1923" },
    failed: { text: "Not completed", bg: "#fda4af", fg: "#0f1923" },
  };
  const s = map[status] ?? map.pending;
  return (
    <span className="bc op-badge" style={{ background: s.bg, color: s.fg }}>
      {status === "reserved" && <span className="op-spin" aria-hidden="true" />}
      {s.text}
    </span>
  );
}

function Countdown({ to }: { to: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = Math.max(0, new Date(to).getTime() - now);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return <span className="num">{h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(s).padStart(2, "0")}`}</span>;
}

// ─── page ───────────────────────────────────────────────────────────

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [data, setData] = useState<OrderPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState("");
  const [reportOpen, setReportOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [showAllSkins, setShowAllSkins] = useState(false);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataRef = useRef<OrderPayload | null>(null);
  useEffect(() => { dataRef.current = data; }, [data]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/orders/${id}`, { cache: "no-store" });
        if (!res.ok) throw new Error(res.status === 404 ? "We couldn't find this order on your account." : `HTTP ${res.status}`);
        const json = (await res.json()) as OrderPayload;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    const tick = setInterval(() => {
      const d = dataRef.current;
      if (d && (d.status === "failed" || d.status === "refunded" || (d.status === "delivered" && !emailPending(d)))) return;
      load();
    }, 6000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [id, reloadKey]);

  function copy(key: string, value: string) {
    try { navigator.clipboard?.writeText(value); } catch { /* clipboard blocked */ }
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(""), 1400);
  }

  const skins = useMemo(
    () => [...(data?.skins_preview ?? [])].sort((a, b) => (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0)),
    [data?.skins_preview]
  );

  if (err) {
    return (
      <div className="op-shell" style={{ alignItems: "center", justifyContent: "center", padding: "40px" }}>
        <PageStyles />
        <div style={{ textAlign: "center" }}>
          <div className="h" style={{ fontSize: "40px", marginBottom: "8px" }}>Order not found</div>
          <p className="mut">{err}</p>
          <Link href="/" className="btn btn-dark cut" style={{ marginTop: "16px", height: "44px", padding: "0 24px" }}>Back to store</Link>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div className="op-shell" style={{ alignItems: "center", justifyContent: "center" }}>
        <PageStyles />
        <span className="bc mut" style={{ fontSize: "18px" }}>Loading your order…</span>
      </div>
    );
  }

  const delivered = data.status === "delivered";
  const waitingEmail = delivered && emailPending(data);
  const creds = data.credentials ?? [];
  const credVal = (k: string) => creds.find((c) => c.key === k)?.value ?? "";
  const copyAllText = creds
    .filter((c) => !isBlank(c.value))
    .map((c) => `${c.key}: ${c.copyAs ?? c.value}`)
    .join("\n");
  const regionName = data.region ? REGION[data.region] ?? data.region : null;
  const title = data.bracket_label ?? "Valorant account";
  const windowOpen = !!data.claim_window_ends_at && new Date(data.claim_window_ends_at).getTime() > Date.now();
  const hasClaim = (data.claims ?? []).length > 0;
  const visibleSkins = showAllSkins ? skins : skins.slice(0, 12);

  const facts: Array<[string, string | null]> = [
    ["Region", regionName],
    ["Skins", data.skin_count != null ? String(data.skin_count) : null],
    ["Level", data.level != null ? String(data.level) : null],
    ["Rank", data.rank && data.rank.toLowerCase() !== "unranked" ? data.rank : null],
    ["Peak", data.peak_rank],
    ["VP", data.vp != null ? String(data.vp) : null],
    ["Last played", data.last_played_relative],
  ];

  return (
    <div className="op-shell">
      <PageStyles />

      {/* Top bar */}
      <header className="op-top">
        <Link href="/?tab=purchases" className="bc op-back">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
          My purchases
        </Link>
        <Link href="/" style={{ display: "flex", alignItems: "center", gap: "10px", margin: "0 auto" }}>
          <LockLogo size={26} />
          <span className="h" style={{ fontSize: "20px", color: "#fff" }}>Val <span style={{ color: "var(--vu-red)" }}>Unlocked</span></span>
        </Link>
        <button className="mono op-id" onClick={() => copy("id", data.display_id)} title="Copy order number">
          {copied === "id" ? "Copied ✓" : data.display_id}
        </button>
      </header>

      <main className="op-main">
        {/* ── Left column ─────────────────────────────────────── */}
        <div className="op-col">
          {/* Hero */}
          <section className="op-hero cut rise">
            <span className="op-hero-glow" aria-hidden="true" />
            <div style={{ position: "relative", display: "flex", alignItems: "flex-start", gap: "16px", flexWrap: "wrap" }}>
              {data.rank_icon ? (
                <img src={data.rank_icon} alt="" width={56} height={56} style={{ flex: "none", objectFit: "contain" }} />
              ) : (
                <span className="op-hero-mark" aria-hidden="true"><LockLogo size={30} /></span>
              )}
              <div style={{ flex: 1, minWidth: "220px", display: "flex", flexDirection: "column", gap: "6px" }}>
                <StatusBadge status={data.status} emailWaiting={waitingEmail} />
                <h1 className="h" style={{ fontSize: "38px", lineHeight: 1, margin: 0, color: "#fff" }}>
                  {title}
                  {regionName && <span style={{ color: "var(--vu-ivory-dim)" }}> · {regionName}</span>}
                </h1>
                <span className="mut" style={{ color: "var(--vu-ivory-dim)", fontSize: "13px" }}>
                  {delivered ? `Delivered ${when(data.delivered_at)}` : `Ordered ${when(data.created_at ?? data.timeline[0]?.at)}`}
                </span>
              </div>
            </div>
            <div className="op-facts">
              {facts.filter(([, v]) => v).map(([k, v]) => (
                <div key={k} className="op-fact">
                  <span className="lbl" style={{ color: "var(--vu-ivory-dim)", fontSize: "11px" }}>{k}</span>
                  <span className="bc" style={{ color: "#fff", fontSize: "18px", fontWeight: 700 }}>{v}</span>
                </div>
              ))}
            </div>
          </section>

          {/* State-specific panel */}
          {data.status === "pending" && (
            <section className="pn cut op-card rise" style={{ borderLeft: "4px solid #ffd400" }}>
              <span className="lbl">Waiting for payment</span>
              <h2 className="h" style={{ fontSize: "28px", margin: "2px 0 6px" }}>Your account is reserved</h2>
              <p className="mut" style={{ margin: 0 }}>
                Finish paying and it's delivered instantly — your login appears right here and in your Discord DMs.
                {data.hold_ends_at && <> The hold ends in <b><Countdown to={data.hold_ends_at} /></b>.</>}
              </p>
              <div style={{ display: "flex", gap: "8px", marginTop: "14px", flexWrap: "wrap" }}>
                {data.pay_url && (
                  <a href={data.pay_url} className="btn btn-gold cut" style={{ height: "46px", padding: "0 28px", fontSize: "18px" }}>
                    Pay {eur(data.price_paid_cents)} →
                  </a>
                )}
                <span className="mut" style={{ fontSize: "12px", alignSelf: "center" }}>Already paid? Crypto can take a few minutes to confirm — this page updates by itself.</span>
              </div>
            </section>
          )}

          {data.status === "reserved" && (
            <section className="pn cut op-card rise" style={{ borderLeft: "4px solid #22d3ee" }}>
              <span className="lbl">Payment received</span>
              <h2 className="h" style={{ fontSize: "28px", margin: "2px 0 6px" }}>Delivering your account…</h2>
              <p className="mut" style={{ margin: 0 }}>
                This usually takes under a minute. Keep this page open — your login appears here as soon as it's ready, and we'll DM it to you too.
              </p>
              <div className="op-progress" aria-hidden="true"><span /></div>
            </section>
          )}

          {(data.status === "failed" || data.status === "refunded") && !hasClaim && (
            <section className="pn cut op-card rise" style={{ borderLeft: `4px solid ${data.status === "refunded" ? "#a5b4fc" : "#fda4af"}` }}>
              <h2 className="h" style={{ fontSize: "28px", margin: "0 0 6px" }}>
                {data.status === "refunded" ? "This order was refunded" : "This order wasn't completed"}
              </h2>
              <p className="mut" style={{ margin: 0 }}>
                {data.status === "refunded"
                  ? "The amount you paid is back in your Val Unlocked credit — it's ready to spend on another account."
                  : "No payment was taken for it, or the payment expired. If you paid and think this is wrong, open a ticket in our Discord."}
              </p>
            </section>
          )}

          {delivered && !hasClaim && (
            <AccountCheckPrompt orderId={data.id} windowEndsAt={data.claim_window_ends_at} onReport={() => setReportOpen(true)} />
          )}

          {/* Login details */}
          {delivered && (
            <section className="pn cut op-card rise" style={{ animationDelay: "60ms" }}>
              <div className="op-card-head">
                <div>
                  <span className="lbl">Your login</span>
                  <h2 className="h" style={{ fontSize: "26px", margin: "2px 0 0" }}>Account details</h2>
                </div>
                <div style={{ display: "flex", gap: "6px" }}>
                  <button className="btn btn-soft cs btn-sm" onClick={() => setReveal((r) => !r)}>
                    <EyeIcon off={reveal} /> {reveal ? "Hide" : "Show"} passwords
                  </button>
                  <button className="btn btn-dark cs btn-sm" onClick={() => copy("all", copyAllText)} disabled={!copyAllText}>
                    <CopyIcon /> {copied === "all" ? "Copied ✓" : "Copy all"}
                  </button>
                </div>
              </div>

              <div className="op-creds">
                {(["Username", "Password", "Email", "Email password"] as const).map((key) => {
                  const value = credVal(key);
                  const secret = key.toLowerCase().includes("password");
                  const pending = isEmailKey(key) && isBlank(value);
                  const shown = secret && !reveal && !isBlank(value) ? "•".repeat(Math.max(8, Math.min(14, value.length))) : value;
                  return (
                    <div key={key} className={`op-cred ${pending ? "is-pending" : ""}`}>
                      <span className="lbl" style={{ fontSize: "11px" }}>{key === "Username" ? "Login" : key}</span>
                      {pending ? (
                        <span className="email-getting" aria-live="polite"><span className="email-dot" aria-hidden="true" />Getting email…</span>
                      ) : (
                        <span className="mono op-cred-val" title={secret && !reveal ? undefined : value}>{shown || "—"}</span>
                      )}
                      <button
                        className="op-copy"
                        aria-label={`Copy ${key}`}
                        disabled={pending || isBlank(value)}
                        onClick={() => copy(key, value)}
                        data-done={copied === key || undefined}
                      >
                        {copied === key ? "✓" : <CopyIcon />}
                      </button>
                    </div>
                  );
                })}
              </div>

              <div className="op-steps">
                <span className="lbl" style={{ display: "block", marginBottom: "8px" }}>First login — do these now</span>
                <ol>
                  <li><b>Log in</b> to the Riot client with the login and password above.</li>
                  <li><b>Change the account password</b> at Riot's account page.</li>
                  <li><b>Change the email password</b> too{waitingEmail ? " (once the email arrives)" : ""} — then the account is fully yours.</li>
                </ol>
                <a href="https://account.riotgames.com/" target="_blank" rel="noreferrer" className="btn btn-soft cs btn-sm" style={{ marginTop: "4px" }}>
                  Open Riot account page ↗
                </a>
              </div>
            </section>
          )}

          {/* Inventory */}
          {skins.length > 0 && (
            <section className="pn cut op-card rise" style={{ animationDelay: "120ms" }}>
              <div className="op-card-head">
                <div>
                  <span className="lbl">Inventory</span>
                  <h2 className="h" style={{ fontSize: "26px", margin: "2px 0 0" }}>
                    {data.skins_total} skin{data.skins_total === 1 ? "" : "s"}
                  </h2>
                </div>
                <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
                  {(["Ultra", "Exclusive", "Premium"] as const).map((t) => {
                    const n = skins.filter((s) => s.tier === t).length;
                    return n ? (
                      <span key={t} className="bc" style={{ fontSize: "14px", fontWeight: 700, color: TIER_COLOR[t] === "#fad663" ? "#b59a00" : TIER_COLOR[t] }}>
                        {n} {t}
                      </span>
                    ) : null;
                  })}
                </div>
              </div>
              <div className="op-skins">
                {visibleSkins.map((k, i) => {
                  const tc = TIER_COLOR[k.tier] ?? TIER_COLOR.Standard;
                  return (
                    <div key={i} className="op-skin" style={{ ["--tc" as string]: tc }}>
                      <span className="op-skin-glow" aria-hidden="true" />
                      <span className="bc op-skin-tier">{k.tier}</span>
                      <span className="op-skin-art">
                        {k.img ? <img src={k.img} alt="" loading="lazy" /> : <span className="bc" style={{ color: "rgba(255,255,255,.35)", fontSize: "12px" }}>{k.weapon}</span>}
                      </span>
                      <span className="op-skin-name">
                        <span className="bc" style={{ fontWeight: 700, color: "#fff" }}>{k.name}</span>
                        <span className="bc" style={{ fontSize: "12px", color: "var(--vu-ivory-dim)" }}>{k.weapon}</span>
                      </span>
                    </div>
                  );
                })}
              </div>
              {skins.length > 12 && (
                <button className="btn btn-soft cs btn-sm" style={{ alignSelf: "center", marginTop: "4px" }} onClick={() => setShowAllSkins((s) => !s)}>
                  {showAllSkins ? "Show fewer" : `Show all ${skins.length} skins`}
                </button>
              )}
              {data.skins_total > skins.length && (
                <span className="mut" style={{ fontSize: "12px", textAlign: "center" }}>+{data.skins_total - skins.length} more on the account</span>
              )}
            </section>
          )}
        </div>

        {/* ── Right column ────────────────────────────────────── */}
        <aside className="op-col op-side">
          <section className="pn cut op-card">
            <span className="lbl">{data.status === "pending" ? "To pay" : "You paid"}</span>
            <div className="h num" style={{ fontSize: "46px", lineHeight: 1 }}>{eur(data.price_paid_cents)}</div>
            {data.price_original_cents != null && data.price_original_cents > data.price_paid_cents && (
              <div className="num" style={{ fontSize: "13px" }}>
                <span className="mut" style={{ textDecoration: "line-through" }}>{eur(data.price_original_cents)}</span>{" "}
                <span style={{ color: "var(--accent-success)", fontWeight: 600 }}>
                  saved {eur(data.price_original_cents - data.price_paid_cents)}{data.sub_tier ? ` with ${data.sub_tier}` : ""}
                </span>
              </div>
            )}
            <div style={{ marginTop: "8px" }}>
              <div className="kv"><span className="mut">Paid with</span><span className="bc" style={{ fontWeight: 700 }}>{data.payment_method === "credit" ? "Store credit" : data.payment_method === "crypto" ? "Crypto" : "—"}</span></div>
              <div className="kv"><span className="mut">Region</span><span>{regionName ?? "—"}</span></div>
              <div className="kv"><span className="mut">Order</span><span className="mono">{data.display_id}</span></div>
            </div>
          </section>

          <section className="pn cut op-card">
            <span className="lbl" style={{ marginBottom: "6px" }}>Progress</span>
            {data.timeline.map((t, i) => {
              const last = i === data.timeline.length - 1;
              const active = !t.done && (i === 0 || data.timeline[i - 1].done);
              return (
                <div key={i} className="op-step">
                  <div className="op-step-rail">
                    <span className={`op-step-dot ${t.done ? "done" : active ? "active" : ""}`} />
                    {!last && <span className={`op-step-line ${t.done ? "done" : ""}`} />}
                  </div>
                  <div className="op-step-body">
                    <span style={{ fontWeight: t.done || active ? 600 : 400, color: t.done || active ? "var(--vu-navy)" : "var(--vu-mute-soft)" }}>{t.label}</span>
                    <span className="num mut mono" style={{ fontSize: "12px" }}>{t.at ? new Date(t.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : active ? "…" : ""}</span>
                  </div>
                </div>
              );
            })}
          </section>

          {hasClaim && <ClaimStatusCard claim={data.claims[0]} onOpenOrder={() => window.scrollTo({ top: 0, behavior: "smooth" })} />}

          {delivered && !hasClaim && (
            <button className="btn btn-soft cs" style={{ width: "100%", height: "40px", color: "var(--accent-rose)", fontSize: "16px", whiteSpace: "nowrap" }} onClick={() => setReportOpen(true)}>
              {windowOpen ? <>Report a problem ({<Countdown to={data.claim_window_ends_at!} />})</> : "Report a problem"}
            </button>
          )}

          <Link href="/" className="btn btn-dark cut" style={{ height: "50px", fontSize: "19px" }}>Back to store</Link>
        </aside>
      </main>

      {reportOpen && (
        <ReportProblemModal
          orderId={data.id}
          displayId={data.display_id}
          itemLabel={title}
          paidCents={data.price_paid_cents}
          windowEndsAt={data.claim_window_ends_at}
          onClose={() => setReportOpen(false)}
          onSubmitted={() => setReloadKey((k) => k + 1)}
        />
      )}
    </div>
  );
}

// ─── page styles ────────────────────────────────────────────────────

function PageStyles() {
  return (
    <style>{`
      .op-shell { min-height: 100vh; background: var(--vu-bg-light); color: var(--vu-navy); display: flex; flex-direction: column; font-family: var(--font-body); font-size: 14px; line-height: 1.45; }
      .op-top { flex: none; height: 58px; padding: 0 24px; display: flex; align-items: center; gap: 16px; background: var(--vu-navy); color: var(--vu-ivory); position: sticky; top: 0; z-index: 20; }
      .op-back { display: inline-flex; align-items: center; gap: 6px; color: var(--vu-ivory-dim); font-weight: 600; font-size: 16px; }
      .op-back:hover { color: #fff; }
      .op-id { background: rgba(255,255,255,.06); border: 0; color: var(--vu-ivory-dim); padding: 6px 10px; cursor: pointer; font-size: 13px; }
      .op-id:hover { color: #fff; background: rgba(255,255,255,.12); }
      .op-main { width: 100%; max-width: 1180px; margin: 0 auto; padding: 20px 24px 40px; display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 16px; align-items: start; }
      .op-col { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
      .op-side { position: sticky; top: 74px; }
      @media (max-width: 900px) { .op-main { grid-template-columns: 1fr; padding: 14px; } .op-side { position: static; } }

      .op-hero { position: relative; overflow: hidden; background: var(--vu-navy); color: #fff; padding: 20px 22px 16px; display: flex; flex-direction: column; gap: 16px; border-bottom: 3px solid var(--vu-red); }
      .op-hero-glow { position: absolute; right: -60px; top: -90px; width: 260px; height: 260px; background: var(--vu-red); opacity: .10; transform: rotate(45deg); pointer-events: none; }
      .op-hero-mark { width: 56px; height: 56px; flex: none; display: flex; align-items: center; justify-content: center; background: rgba(255,255,255,.05); }
      .op-badge { align-self: flex-start; display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; font-weight: 700; font-size: 14px; letter-spacing: .04em; }
      .op-spin { width: 10px; height: 10px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: op-spin .8s linear infinite; }
      @keyframes op-spin { to { transform: rotate(360deg); } }
      .op-facts { position: relative; display: grid; grid-template-columns: repeat(auto-fit, minmax(92px, 1fr)); gap: 4px; }
      .op-fact { background: rgba(255,255,255,.05); padding: 7px 10px; display: flex; flex-direction: column; min-width: 0; }
      .op-fact .bc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      .op-card { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; }
      .op-card-head { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .op-card-head .btn { display: inline-flex; align-items: center; gap: 6px; }

      .op-creds { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
      @media (max-width: 620px) { .op-creds { grid-template-columns: 1fr; } }
      .op-cred { position: relative; display: grid; grid-template-columns: minmax(0, 1fr) auto; grid-template-rows: auto auto; column-gap: 8px; align-items: center; padding: 10px 8px 10px 14px; background: var(--vu-surface-alt); border-left: 3px solid var(--vu-navy); }
      .op-cred.is-pending { border-left-color: #f5d87a; }
      .op-cred .lbl { grid-column: 1; }
      .op-cred-val { grid-column: 1; font-size: 17px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; user-select: all; }
      .op-cred .email-getting { grid-column: 1; }
      .op-copy { grid-column: 2; grid-row: 1 / span 2; width: 40px; height: 40px; border: 0; background: #fff; color: var(--vu-navy); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; font-weight: 700; transition: background .12s, color .12s; }
      .op-copy:hover:not(:disabled) { background: var(--vu-navy); color: #fff; }
      .op-copy[data-done] { background: #dcfce7; color: var(--accent-success); }
      .op-copy:disabled { opacity: .35; cursor: not-allowed; }

      .op-steps { background: #fff8e1; border: 1px solid #f5d87a; padding: 12px 14px; }
      .op-steps ol { margin: 0; padding-left: 20px; display: flex; flex-direction: column; gap: 4px; color: #5b4a12; }

      .op-progress { height: 4px; background: var(--vu-divider-strong); overflow: hidden; position: relative; margin-top: 12px; }
      .op-progress span { position: absolute; inset: 0; width: 40%; background: #22d3ee; animation: op-slide 1.4s ease-in-out infinite; }
      @keyframes op-slide { from { transform: translateX(-100%); } to { transform: translateX(260%); } }

      .op-skins { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
      .op-skin { position: relative; overflow: hidden; display: flex; flex-direction: column; height: 128px; background: var(--vu-navy-tile); clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 10px 100%, 0 calc(100% - 10px)); }
      .op-skin-glow { position: absolute; inset: 0; background: linear-gradient(to top, var(--tc) -40%, transparent 65%); opacity: .45; pointer-events: none; }
      .op-skin-tier { position: relative; padding: 6px 8px 0; font-size: 11px; font-weight: 700; color: var(--tc); letter-spacing: .06em; }
      .op-skin-art { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; padding: 2px 10px; }
      .op-skin-art img { max-width: 100%; max-height: 100%; object-fit: contain; filter: drop-shadow(0 4px 6px rgba(0,0,0,.4)); transition: transform .2s; }
      .op-skin:hover .op-skin-art img { transform: translateX(4px) scale(1.04); }
      .op-skin-name { position: relative; display: flex; flex-direction: column; padding: 4px 8px 6px; background: rgba(15,25,35,.75); line-height: 1.15; }
      .op-skin-name .bc { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

      .op-step { display: flex; gap: 12px; }
      .op-step-rail { display: flex; flex-direction: column; align-items: center; width: 12px; }
      .op-step-dot { width: 10px; height: 10px; margin-top: 5px; flex: none; transform: rotate(45deg); background: var(--vu-divider-strong); }
      .op-step-dot.done { background: var(--accent-green); }
      .op-step-dot.active { background: #22d3ee; box-shadow: 0 0 0 4px rgba(34,211,238,.2); animation: op-pulse 1.6s ease-in-out infinite; }
      @keyframes op-pulse { 50% { box-shadow: 0 0 0 7px rgba(34,211,238,.05); } }
      .op-step-line { flex: 1; width: 2px; min-height: 20px; background: var(--vu-divider-strong); }
      .op-step-line.done { background: var(--accent-green); }
      .op-step-body { flex: 1; display: flex; justify-content: space-between; padding-bottom: 12px; }
      @media (prefers-reduced-motion: reduce) { .op-spin, .op-progress span, .op-step-dot.active { animation: none; } }
    `}</style>
  );
}
