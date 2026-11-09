"use client";

// Standard welcome gift — a banner + claim pop-up for the free 26–50 skins
// account. Only renders when /api/welcome-account says it's claimable.
// Opens automatically from the DM link (/?claim=welcome).

import { useCallback, useEffect, useState } from "react";

type Status = { state: "none" | "available" | "claimed"; orderId?: string; stock?: Record<string, number> };
const REGIONS: Array<[string, string]> = [["EU", "Europe"], ["NA", "North America"], ["AP", "Asia Pacific"], ["KR", "Korea"], ["LATAM", "Latin America"], ["BR", "Brazil"]];
const GOLD = "#ffd400";

export function WelcomeGift({ active }: { active: boolean }) {
  const [st, setSt] = useState<Status | null>(null);
  const [open, setOpen] = useState(false);
  const [region, setRegion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<{ orderId: string; delivered: boolean } | null>(null);

  const load = useCallback(() => {
    fetch("/api/welcome-account")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Status | null) => {
        if (!d) return;
        setSt(d);
        if (d.state === "available" && typeof window !== "undefined" && new URLSearchParams(window.location.search).get("claim") === "welcome") setOpen(true);
      })
      .catch(() => {});
  }, []);
  useEffect(() => { if (active) load(); }, [active, load]);

  async function claim() {
    if (!region) return;
    setBusy(true); setErr("");
    try {
      const r = await fetch("/api/welcome-account", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ region }) });
      const d = await r.json();
      if (!r.ok || !d.ok) {
        throw new Error(
          d.error === "out_of_stock" ? "That region just ran out of 26–50 accounts. Pick another one."
          : d.error === "already_claimed" ? "You've already claimed your free account."
          : d.error === "not_eligible" ? "The free account comes with your first paid Standard month."
          : "Something went wrong. Try again in a minute."
        );
      }
      setDone({ orderId: d.orderId, delivered: d.delivered });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      load();
    } finally {
      setBusy(false);
    }
  }

  if (!st || st.state !== "available") return null;
  const stock = st.stock ?? {};

  return (
    <>
      <button
        className="cs rise"
        onClick={() => setOpen(true)}
        style={{ position: "fixed", left: "20px", bottom: "20px", zIndex: 70, width: "min(440px, calc(100vw - 40px))", boxShadow: "0 10px 30px rgba(0,0,0,0.3)", display: "flex", alignItems: "center", gap: "14px", padding: "10px 16px", background: "var(--vu-navy)", color: "#fff", border: 0, borderLeft: `4px solid ${GOLD}`, cursor: "pointer", textAlign: "left" }}
      >
        <span style={{ fontSize: "26px" }} aria-hidden="true">🎁</span>
        <span style={{ flex: 1, display: "flex", flexDirection: "column" }}>
          <span className="bc" style={{ fontSize: "18px", fontWeight: 700 }}>
            Your <span style={{ color: GOLD }}>free 26–50 skins account</span> is waiting
          </span>
          <span style={{ fontSize: "12px", color: "var(--vu-ivory-dim)" }}>Included with your first Standard month · pick a region and it's delivered instantly</span>
        </span>
        <span className="btn btn-gold cs btn-sm">Claim it</span>
      </button>

      {open && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(15,25,35,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
          onClick={(e) => { if (e.target === e.currentTarget && !busy) setOpen(false); }}
        >
          <div role="dialog" aria-modal="true" aria-label="Claim your free account" className="cut rise" style={{ width: "100%", maxWidth: "560px", maxHeight: "100%", overflow: "auto", background: "#fff", display: "flex", flexDirection: "column" }}>
            <div style={{ background: "var(--vu-navy)", color: "#fff", padding: "14px 18px", display: "flex", alignItems: "center", gap: "12px", borderBottom: `3px solid ${GOLD}` }}>
              <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                <span className="h" style={{ fontSize: "26px" }}>Free <span style={{ color: GOLD }}>account</span></span>
                <span style={{ fontSize: "12px", color: "var(--vu-ivory-dim)" }}>Random 26–50 skins account · worth €6.99 · yours free with Standard</span>
              </div>
              <button className="ico" style={{ color: "var(--vu-ivory-dim)" }} aria-label="Close" onClick={() => !busy && setOpen(false)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
              </button>
            </div>

            <div style={{ padding: "16px 18px", display: "flex", flexDirection: "column", gap: "14px" }}>
              {done ? (
                <div className="rise" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "10px", padding: "18px 0", textAlign: "center" }}>
                  <span style={{ fontSize: "44px" }} aria-hidden="true">🎉</span>
                  <span className="h" style={{ fontSize: "28px" }}>{done.delivered ? "It's yours!" : "Claimed!"}</span>
                  <span style={{ fontSize: "14px", color: "#5b6773" }}>
                    {done.delivered ? "Your account is ready — the login is on the order page." : "We're delivering it now. You'll get a DM the moment it's ready."}
                  </span>
                  <a className="btn btn-gold cs" href={`/orders/${done.orderId}`}>View my account</a>
                </div>
              ) : (
                <>
                  <span className="lbl">Pick a region</span>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: "8px" }}>
                    {REGIONS.map(([code, name]) => {
                      const n = stock[code] ?? 0;
                      const on = region === code;
                      return (
                        <button
                          key={code}
                          className={`tile cs ${on ? "on" : ""}`}
                          disabled={n === 0}
                          aria-pressed={on}
                          onClick={() => setRegion(code)}
                          style={{ ["--tc" as string]: GOLD, height: "84px", opacity: n === 0 ? 0.45 : 1, cursor: n === 0 ? "not-allowed" : "pointer" }}
                        >
                          <span className="glow" style={{ opacity: on ? 0.75 : 0.3 }} />
                          <span style={{ position: "relative", flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                            <span className="h" style={{ fontSize: "24px", color: "#fff" }}>{code}</span>
                            <span style={{ fontSize: "11px", color: "#9aa5b1" }}>{name}</span>
                          </span>
                          <span className="strip" style={{ justifyContent: "center" }}>
                            <span className="bc num" style={{ fontSize: "12px", fontWeight: 700, color: n ? GOLD : "#9aa5b1" }}>{n ? `${n} available` : "No stock"}</span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  {err && <div style={{ fontSize: "13px", color: "#d1293a" }}>{err}</div>}
                  <button className="btn btn-gold cs" disabled={!region || busy} onClick={claim}>
                    {busy ? "Delivering…" : region ? `Claim my free ${region} account` : "Pick a region"}
                  </button>
                  <span style={{ fontSize: "11px", color: "#5b6773", textAlign: "center" }}>One free account per member · the region can't be changed after claiming</span>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
