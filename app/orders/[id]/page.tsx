// Order detail — what the buyer sees after their purchase lands.
// Pulls real order + inventory data from GET /api/orders/[id] (already exists,
// returns decrypted credentials once fulfilled). Everything on this page is a
// window onto that one response. If the order is still extracting, we show a
// "waiting for email" state; once the worker callback fires, credentials
// appear here.

"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { LockLogo } from "@/components/lock-logo";
import { ReportProblemModal, ClaimStatusCard, type ClaimSummary } from "@/components/claims";

// ----- Types the /api/orders/[id] route is expected to return -----
type Credential = { key: string; value: string; copyAs?: string };
type Skin = {
  name: string;
  weapon: string;
  tier: "Standard" | "Premium" | "Exclusive" | "Ultra";
  img?: string | null;
};
type Agent = { name: string; owned: boolean; img?: string | null };
type TimelineStep = { label: string; at: string | null; done: boolean };

type OrderPayload = {
  id: string;
  display_id: string;             // e.g. "VU-10482"
  status: "pending" | "reserved" | "delivered" | "failed" | "refunded";
  bracket_label: string | null;   // e.g. "25–49 skins"
  region: string | null;          // "EU", "NA", ...
  rank: string | null;            // "Gold 3"
  rank_tier: string | null;       // "Gold"
  peak_rank: string | null;
  last_played_relative: string | null;
  delivered_at: string | null;
  price_paid_cents: number;
  price_original_cents: number | null;
  sub_tier: "Standard" | "Premium" | "Ultra" | null;
  payment_method: "credit" | "crypto" | "card" | null;
  level: number | null;
  skin_count: number | null;
  agent_count: number | null;
  agents_total: number | null;
  vp: number | null;
  email_verified: boolean;
  credentials: Credential[] | null;  // null until delivered
  skins_preview: Skin[];             // up to 8
  skins_total: number;
  agents: Agent[];
  timeline: TimelineStep[];
  claim_window_ends_at: string | null;
  claims: ClaimSummary[];
};

const TIER_COLOR: Record<string, string> = {
  Standard:  "var(--tier-standard)",
  Premium:   "var(--tier-premium)",
  Exclusive: "var(--tier-exclusive)",
  Ultra:     "var(--tier-ultra)",
};

const RANK_COLOR: Record<string, string> = {
  Iron:       "var(--rank-iron)",
  Bronze:     "var(--rank-bronze)",
  Silver:     "var(--rank-silver)",
  Gold:       "var(--rank-gold)",
  Platinum:   "var(--rank-platinum)",
  Diamond:    "var(--rank-diamond)",
  Ascendant:  "var(--rank-ascendant)",
  Immortal:   "var(--rank-immortal)",
  Radiant:    "var(--rank-radiant)",
};

function centsToEuro(cents: number): string {
  return (cents / 100).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

// Placeholder gray square — real skin/agent art lands in phase 3.
function Placeholder({ label }: { label?: string }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(255,255,255,0.04)",
        color: "rgba(255,255,255,0.3)",
        fontSize: "9px",
        fontFamily: "var(--font-head)",
        letterSpacing: "0.1em",
        textTransform: "uppercase",
      }}
    >
      {label ?? ""}
    </div>
  );
}

export default function OrderDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;

  const [data, setData] = useState<OrderPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState<string>("");
  const [reportOpen, setReportOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`/api/orders/${id}`, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as OrderPayload;
        if (!cancelled) setData(json);
      } catch (e) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    }
    load();
    // Poll every 6s while not delivered — worker callback may fire any time.
    const tick = setInterval(() => {
      if (data && data.status === "delivered") return;
      load();
    }, 6000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [id, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  function copy(key: string, value: string) {
    try {
      navigator.clipboard?.writeText(value);
    } catch {}
    setCopied(key);
    if (copyTimer.current) clearTimeout(copyTimer.current);
    copyTimer.current = setTimeout(() => setCopied(""), 1200);
  }

  if (err) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--vu-bg-light)",
          color: "var(--vu-navy)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: "40px",
          fontFamily: "var(--font-body)",
        }}
      >
        <div style={{ textAlign: "center" }}>
          <div className="h" style={{ fontSize: "40px", marginBottom: "8px" }}>
            Order not found
          </div>
          <p className="mut">{err}</p>
          <Link href="/" className="btn btn-dark cut-16" style={{ marginTop: "16px" }}>
            Back to store
          </Link>
        </div>
      </div>
    );
  }

  if (!data) {
    return (
      <div
        style={{
          minHeight: "100vh",
          background: "var(--vu-bg-light)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div className="bc" style={{ color: "var(--vu-mute)" }}>
          Loading order…
        </div>
      </div>
    );
  }

  const rankTierColor = data.rank_tier
    ? RANK_COLOR[data.rank_tier] ?? "var(--vu-ivory)"
    : "var(--vu-ivory)";

  const delivered = data.status === "delivered";
  const waiting = !delivered;

  // Fallback masked credentials while waiting for worker.
  const creds: Credential[] =
    data.credentials && delivered
      ? data.credentials
      : [
          { key: "Username", value: "—" },
          { key: "Password", value: "—" },
          { key: "Email",    value: waiting ? "Extracting…" : "—" },
          { key: "Riot ID",  value: "—" },
        ];

  const pw = creds.find((c) => c.key === "Password")?.value ?? "";

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--vu-bg-light)",
        color: "var(--vu-navy)",
        display: "flex",
        flexDirection: "column",
        fontFamily: "var(--font-body)",
        fontSize: "14px",
        lineHeight: 1.4,
      }}
    >
      {/* Header */}
      <header
        style={{
          flex: "none",
          background: "var(--vu-navy)",
          color: "var(--vu-ivory)",
        }}
      >
        <div
          style={{
            padding: "0 24px",
            height: "58px",
            display: "flex",
            alignItems: "center",
            gap: "16px",
          }}
        >
          <Link
            href="/"
            className="bc"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              color: "var(--vu-ivory-dim)",
              fontWeight: 600,
              fontSize: "16px",
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="m15 18-6-6 6-6" />
            </svg>
            Orders
          </Link>
          <div
            style={{
              flex: 1,
              display: "flex",
              justifyContent: "center",
              alignItems: "center",
              gap: "10px",
            }}
          >
            <LockLogo size={26} />
            <span className="h" style={{ fontSize: "20px", color: "#fff" }}>
              Val Unlocked
            </span>
          </div>
          <span className="mono" style={{ color: "var(--vu-ivory-dim)" }}>
            {data.display_id}
          </span>
        </div>
      </header>

      {/* Body */}
      <main
        style={{
          flex: 1,
          padding: "18px 24px",
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 340px",
          gap: "16px",
        }}
      >
        {/* Left column */}
        <section
          className="pn cut"
          style={{
            padding: "0 0 18px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            minHeight: 0,
          }}
        >
          {/* Hero: bracket + region + rank */}
          <div
            className="rise"
            style={{
              position: "relative",
              overflow: "hidden",
              background: "var(--vu-navy)",
              color: "#fff",
              padding: "14px 20px",
              display: "flex",
              alignItems: "center",
              gap: "16px",
              borderBottom: `3px solid ${rankTierColor}`,
            }}
          >
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                right: "-40px",
                top: "-60px",
                width: "200px",
                height: "200px",
                background: rankTierColor,
                opacity: 0.08,
                transform: "rotate(45deg)",
                pointerEvents: "none",
              }}
            />
            <div
              style={{
                position: "relative",
                width: 52,
                height: 52,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "rgba(255,255,255,0.04)",
                borderRadius: 2,
              }}
            >
              <span
                className="bc"
                style={{
                  color: rankTierColor,
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {data.rank_tier ?? "?"}
              </span>
            </div>
            <div
              style={{
                position: "relative",
                flex: 1,
                display: "flex",
                flexDirection: "column",
                gap: "4px",
              }}
            >
              <span className="h" style={{ fontSize: "30px" }}>
                {data.bracket_label ?? "Account"}
                {data.region ? ` · ${data.region}` : ""}
              </span>
              <span
                className="num"
                style={{ fontSize: "12px", color: "var(--vu-ivory-dim)" }}
              >
                {data.rank && (
                  <>
                    <b
                      className="bc"
                      style={{ color: rankTierColor, fontSize: "14px" }}
                    >
                      {data.rank}
                    </b>
                    {" · "}
                  </>
                )}
                {data.peak_rank && <>peak {data.peak_rank} · </>}
                {data.last_played_relative && (
                  <>last played {data.last_played_relative} · </>
                )}
                {data.delivered_at
                  ? `delivered ${new Date(
                      data.delivered_at
                    ).toLocaleString("en-GB", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`
                  : "awaiting delivery"}
              </span>
            </div>
            <span
              className="bc"
              style={{
                position: "relative",
                background: delivered
                  ? "var(--accent-green)"
                  : "var(--accent-cyan)",
                color: "var(--vu-navy)",
                fontWeight: 700,
                fontSize: "15px",
                padding: "3px 10px",
              }}
            >
              {delivered ? "Unlocked" : "Preparing"}
            </span>
          </div>

          {/* Stats strip */}
          <div
            className="rise"
            style={{
              padding: "0 20px",
              display: "grid",
              gridTemplateColumns: "repeat(6, minmax(0, 1fr))",
              gap: "4px",
              animationDelay: "80ms",
            }}
          >
            {[
              { k: "Level",   v: data.level?.toString() ?? "—", c: "var(--vu-navy)" },
              { k: "Skins",   v: data.skin_count?.toString() ?? "—", c: "var(--vu-navy)" },
              {
                k: "Agents",
                v:
                  data.agent_count != null && data.agents_total != null
                    ? `${data.agent_count}/${data.agents_total}`
                    : "—",
                c: "var(--vu-navy)",
              },
              { k: "VP",      v: data.vp?.toString() ?? "0", c: "var(--vu-mute-soft)" },
              { k: "Region",  v: data.region ?? "—", c: "var(--vu-navy)" },
              {
                k: "Email",
                v: data.email_verified ? "Verified" : "Unverified",
                c: data.email_verified
                  ? "var(--accent-success)"
                  : "var(--vu-mute-soft)",
              },
            ].map((s) => (
              <div
                key={s.k}
                style={{
                  background: "var(--vu-surface-alt)",
                  padding: "6px 10px",
                  display: "flex",
                  flexDirection: "column",
                }}
              >
                <span className="lbl" style={{ fontSize: "11px" }}>
                  {s.k}
                </span>
                <span
                  className="bc num"
                  style={{
                    fontWeight: 700,
                    fontSize: "20px",
                    color: s.c,
                    lineHeight: 1.15,
                  }}
                >
                  {s.v}
                </span>
              </div>
            ))}
          </div>

          {/* Credentials */}
          <div
            className="rise"
            style={{
              padding: "0 20px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              animationDelay: "160ms",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span className="lbl" style={{ color: "var(--vu-navy)" }}>
                Login details
              </span>
              {delivered && (
                <button
                  className="btn btn-soft cs"
                  style={{
                    height: "28px",
                    fontSize: "13px",
                    padding: "0 10px",
                  }}
                  onClick={() => setReveal((r) => !r)}
                >
                  {reveal ? "Hide" : "Show"} password
                </button>
              )}
            </div>
            {waiting && (
              <div
                style={{
                  background: "#fff8e1",
                  border: "1px solid #f5d87a",
                  padding: "10px 14px",
                  color: "#8a6d1a",
                  fontSize: "13px",
                }}
              >
                We're extracting the account email now. This usually takes under
                a minute. The page will refresh itself when it's ready.
              </div>
            )}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                gap: "6px",
              }}
            >
              {creds.map((c) => {
                const shown =
                  c.key === "Password" && !reveal
                    ? pw && pw !== "—"
                      ? "•".repeat(Math.max(8, Math.min(14, pw.length)))
                      : c.value
                    : c.value;
                return (
                  <div className="cred" key={c.key}>
                    <span
                      className="lbl"
                      style={{ width: 64, flex: "none", fontSize: "12px" }}
                    >
                      {c.key}
                    </span>
                    <span
                      className="mono"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {shown}
                    </span>
                    <button
                      className="ico"
                      aria-label={`Copy ${c.key}`}
                      onClick={() => copy(c.key, c.copyAs ?? c.value)}
                      disabled={!delivered}
                      style={{
                        color:
                          copied === c.key
                            ? "var(--accent-success)"
                            : "var(--vu-mute)",
                        opacity: delivered ? 1 : 0.3,
                        cursor: delivered ? "pointer" : "not-allowed",
                      }}
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
                        <rect x="9" y="9" width="13" height="13" rx="2" />
                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Skin inventory */}
          <div
            className="rise"
            style={{
              flex: 1,
              minHeight: 0,
              padding: "0 20px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              animationDelay: "240ms",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <span className="lbl" style={{ color: "var(--vu-navy)" }}>
                Inventory
              </span>
              <span className="mut num" style={{ fontSize: "12px" }}>
                {data.skins_total} skins · {data.skins_preview.length} previewed
                {data.skins_total > data.skins_preview.length &&
                  ` · +${data.skins_total - data.skins_preview.length} more`}
              </span>
            </div>
            <div
              style={{
                flex: 1,
                minHeight: 120,
                display: "grid",
                gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
                gridTemplateRows: "repeat(2, minmax(0, 1fr))",
                gap: "6px",
              }}
            >
              {data.skins_preview.slice(0, 8).map((k, i) => {
                const tc = TIER_COLOR[k.tier] ?? "var(--tier-standard)";
                return (
                  <div
                    key={i}
                    className="tile cs"
                    style={{ ["--tc" as string]: tc }}
                  >
                    <span className="glow" />
                    <span
                      style={{
                        position: "relative",
                        display: "flex",
                        alignItems: "center",
                        gap: "4px",
                        padding: "6px 8px 0",
                      }}
                    >
                      <span
                        className="bc"
                        style={{
                          fontSize: "11px",
                          fontWeight: 600,
                          color: tc,
                        }}
                      >
                        {k.tier}
                      </span>
                    </span>
                    <span
                      style={{
                        position: "relative",
                        flex: 1,
                        minHeight: "24px",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        padding: "2px 12px",
                      }}
                    >
                      <Placeholder label={k.weapon} />
                    </span>
                    <span className="strip">
                      <span
                        className="bc"
                        style={{
                          fontWeight: 700,
                          fontSize: "14px",
                          color: "#fff",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {k.name}
                      </span>
                      <span
                        className="bc"
                        style={{
                          fontSize: "12px",
                          color: "var(--vu-ivory-dim)",
                        }}
                      >
                        {k.weapon}
                      </span>
                    </span>
                  </div>
                );
              })}
              {/* Fill empty slots so grid stays stable */}
              {Array.from({
                length: Math.max(0, 8 - data.skins_preview.length),
              }).map((_, i) => (
                <div
                  key={`empty-${i}`}
                  className="tile cs"
                  style={{
                    ["--tc" as string]: "var(--vu-mute)",
                    opacity: 0.25,
                  }}
                >
                  <span className="glow" />
                </div>
              ))}
            </div>
          </div>

          {/* Agents */}
          <div
            className="rise"
            style={{
              padding: "0 20px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
              animationDelay: "320ms",
            }}
          >
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "baseline",
              }}
            >
              <span className="lbl" style={{ color: "var(--vu-navy)" }}>
                Agents
              </span>
              {data.agent_count != null && data.agents_total != null && (
                <span className="mut num" style={{ fontSize: "12px" }}>
                  {data.agent_count} of {data.agents_total} unlocked
                </span>
              )}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(15, minmax(0, 1fr))",
                gap: "4px",
              }}
            >
              {data.agents.map((g, i) => (
                <div
                  key={i}
                  className={`ag ${g.owned ? "" : "off"} cs`}
                  style={{
                    background: "var(--vu-navy-tile)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 8,
                    color: "rgba(255,255,255,0.5)",
                    fontFamily: "var(--font-head)",
                    textTransform: "uppercase",
                    textAlign: "center",
                    padding: 2,
                    overflow: "hidden",
                  }}
                  title={g.name + (g.owned ? "" : " (locked)")}
                >
                  {g.name.slice(0, 4)}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Right column: payment + timeline + actions */}
        <aside
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "16px",
            minHeight: 0,
          }}
        >
          <section className="pn cut" style={{ padding: "18px 20px" }}>
            <span className="lbl">You paid</span>
            <div className="h num" style={{ fontSize: "48px" }}>
              €{centsToEuro(data.price_paid_cents)}
            </div>
            {data.price_original_cents &&
              data.price_original_cents > data.price_paid_cents && (
                <div
                  className="num"
                  style={{ fontSize: "13px", marginBottom: "10px" }}
                >
                  <span
                    className="mut"
                    style={{ textDecoration: "line-through" }}
                  >
                    €{centsToEuro(data.price_original_cents)}
                  </span>{" "}
                  <span
                    style={{
                      color: "var(--accent-success)",
                      fontWeight: 600,
                    }}
                  >
                    {`−€${centsToEuro(
                      data.price_original_cents - data.price_paid_cents
                    )}`}{" "}
                    with {data.sub_tier ?? "subscription"}
                  </span>
                </div>
              )}
            <div className="kv">
              <span className="mut">Method</span>
              <span
                className="bc"
                style={{
                  fontWeight: 700,
                  fontSize: "16px",
                  color: "var(--accent-link)",
                }}
              >
                {data.payment_method
                  ? data.payment_method[0].toUpperCase() +
                    data.payment_method.slice(1)
                  : "—"}
              </span>
            </div>
            <div className="kv">
              <span className="mut">Region</span>
              <span>{data.region ?? "—"}</span>
            </div>
            <div className="kv">
              <span className="mut">Order</span>
              <span className="mono">{data.display_id}</span>
            </div>
          </section>

          <section
            className="pn cut"
            style={{
              padding: "18px 20px",
              display: "flex",
              flexDirection: "column",
            }}
          >
            <span className="lbl" style={{ marginBottom: "10px" }}>
              Timeline
            </span>
            {data.timeline.map((t, i) => {
              const last = i === data.timeline.length - 1;
              return (
                <div key={i} style={{ display: "flex", gap: "12px" }}>
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      width: "12px",
                    }}
                  >
                    <span
                      style={{
                        width: "10px",
                        height: "10px",
                        background: t.done
                          ? "var(--accent-green)"
                          : "var(--accent-cyan)",
                        transform: "rotate(45deg)",
                        marginTop: "4px",
                        flex: "none",
                      }}
                    />
                    {!last && (
                      <span
                        style={{
                          flex: 1,
                          width: "2px",
                          background: "var(--vu-divider-strong)",
                          minHeight: "18px",
                        }}
                      />
                    )}
                  </div>
                  <div
                    style={{
                      flex: 1,
                      display: "flex",
                      justifyContent: "space-between",
                      paddingBottom: "10px",
                    }}
                  >
                    <span style={{ fontWeight: 500 }}>{t.label}</span>
                    <span className="num mut mono">
                      {t.at
                        ? new Date(t.at).toLocaleTimeString("en-GB")
                        : "…"}
                    </span>
                  </div>
                </div>
              );
            })}
          </section>

          <div style={{ flex: 1 }} />

          {(data.claims ?? [])[0] && (
            <ClaimStatusCard
              claim={data.claims[0]}
              onOpenOrder={() => window.scrollTo({ top: 0, behavior: "smooth" })}
            />
          )}
          {delivered && !(data.claims ?? []).length && (
            <button
              className="btn btn-soft cs btn-sm"
              style={{ width: "100%", height: "36px", color: "var(--accent-rose)" }}
              onClick={() => setReportOpen(true)}
            >
              {data.claim_window_ends_at && new Date(data.claim_window_ends_at).getTime() > Date.now()
                ? "Report a problem · 10-min window"
                : "Report a problem"}
            </button>
          )}
          {reportOpen && (
            <ReportProblemModal
              orderId={data.id}
              displayId={data.display_id}
              itemLabel={data.bracket_label ?? "Valorant account"}
              paidCents={data.price_paid_cents}
              windowEndsAt={data.claim_window_ends_at}
              onClose={() => setReportOpen(false)}
              onSubmitted={() => setReloadKey((k) => k + 1)}
            />
          )}
          <Link
            href="/"
            className="btn btn-dark cut"
            style={{ height: "52px", fontSize: "20px" }}
          >
            Back to store
          </Link>
        </aside>
      </main>
    </div>
  );
}
