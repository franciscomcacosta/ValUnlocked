"use client";

// 🔔 Restock alerts — a bell in the header that opens a small dropdown.
// Pick region + skin range → the bot DMs you on Discord when one drops.

import { useCallback, useEffect, useRef, useState } from "react";

type Alert = { id: string; region: string; bracket: string; last_notified_at: string | null };
type Data = { alerts: Alert[]; brackets: Array<{ name: string; label: string }>; regions: string[]; max: number };

const REGION_NAME: Record<string, string> = {
  EU: "Europe", NA: "North America", AP: "Asia Pacific", KR: "Korea", LATAM: "Latin America", BR: "Brazil",
};

function Bell({ on }: { on: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

export function AlertsBell({ earlyAccess, onSubscribe }: { earlyAccess: boolean; onSubscribe: () => void }) {
  const [open, setOpen] = useState(false);
  const [d, setD] = useState<Data | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [region, setRegion] = useState("EU");
  const [bracket, setBracket] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    fetch("/api/alerts")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setD(j);
          setUnavailable(false);
          setBracket((b) => b || j.brackets[0]?.name || "");
        } else setUnavailable(true);
      })
      .catch(() => setUnavailable(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ region, bracket }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save the alert.");
      setMsg({ ok: true, text: "Alert on — we'll DM you on Discord." });
      load();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    await fetch(`/api/alerts?id=${id}`, { method: "DELETE" }).catch(() => {});
    load();
  }

  const count = d?.alerts.length ?? 0;
  const label = (name: string) => d?.brackets.find((b) => b.name === name)?.label ?? name;
  const full = !!d && count >= d.max;

  return (
    <div ref={wrap} style={{ position: "relative", flex: "none" }}>
      <button
        className="cs"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Restock alerts${count ? ` (${count} on)` : ""}`}
        aria-expanded={open}
        title="Restock alerts"
        style={{
          position: "relative",
          width: "36px",
          height: "36px",
          border: 0,
          cursor: "pointer",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          background: open ? "#2a3a4b" : "#1f2d3b",
          color: count ? "#ffd400" : "var(--vu-ivory)",
        }}
      >
        <Bell on={count > 0} />
        {count > 0 && (
          <span
            className="num"
            style={{ position: "absolute", top: "3px", right: "3px", minWidth: "14px", height: "14px", padding: "0 3px", background: "var(--vu-red)", color: "#fff", fontSize: "10px", fontWeight: 700, lineHeight: "14px", textAlign: "center" }}
          >
            {count}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Restock alerts"
          className="rise"
          style={{
            position: "absolute",
            right: 0,
            top: "44px",
            width: "340px",
            zIndex: 60,
            background: "#fff",
            color: "var(--vu-navy)",
            boxShadow: "0 18px 40px rgba(15,25,35,.28)",
            borderTop: "3px solid var(--vu-red)",
            padding: "14px 16px",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <div>
            <span className="h" style={{ fontSize: "22px", display: "block", lineHeight: 1 }}>🔔 Restock alerts</span>
            <span className="mut" style={{ fontSize: "12px" }}>
              Get a Discord DM when a matching account drops.
              {!earlyAccess && " Premium & Ultra can buy new drops 2 h before everyone else."}
            </span>
          </div>

          {unavailable ? (
            <span className="mut" style={{ fontSize: "13px" }}>Alerts are being set up — check back in a bit.</span>
          ) : !d ? (
            <span className="mut" style={{ fontSize: "13px" }}>Loading…</span>
          ) : (
            <>
              <div style={{ display: "flex", gap: "6px" }}>
                <select className="inp" value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region" style={{ flex: 1, minWidth: 0, height: "34px" }}>
                  {d.regions.map((r) => <option key={r} value={r}>{REGION_NAME[r] ?? r}</option>)}
                </select>
                <select className="inp" value={bracket} onChange={(e) => setBracket(e.target.value)} aria-label="Skin range" style={{ flex: 1, minWidth: 0, height: "34px" }}>
                  {d.brackets.map((b) => <option key={b.name} value={b.name}>{b.label}</option>)}
                </select>
              </div>
              <button className="btn btn-red cs btn-sm" disabled={busy || full} onClick={add} style={{ width: "100%" }}>
                {busy ? "Saving…" : full ? `Max ${d.max} alerts` : "+ Add alert"}
              </button>
              {msg && <span style={{ fontSize: "12px", color: msg.ok ? "var(--accent-success)" : "var(--accent-rose)" }}>{msg.text}</span>}

              {count > 0 && (
                <div style={{ display: "flex", flexDirection: "column", borderTop: "1px solid var(--vu-divider)", paddingTop: "6px" }}>
                  {d.alerts.map((a) => (
                    <div key={a.id} style={{ display: "flex", alignItems: "center", gap: "8px", padding: "5px 0" }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: "13px" }}>
                        <b>{label(a.bracket)}</b> <span className="mut">· {REGION_NAME[a.region] ?? a.region}</span>
                      </span>
                      <button
                        onClick={() => remove(a.id)}
                        aria-label={`Remove ${label(a.bracket)} ${a.region} alert`}
                        style={{ border: 0, background: "transparent", color: "var(--vu-mute)", cursor: "pointer", fontSize: "16px", lineHeight: 1, padding: "2px 6px" }}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {!earlyAccess && (
                <button
                  className="btn btn-gold cs btn-sm"
                  style={{ width: "100%" }}
                  onClick={() => { setOpen(false); onSubscribe(); }}
                >
                  Get early access
                </button>
              )}
              <span className="mut" style={{ fontSize: "11px" }}>Max one DM per alert every 30 min · keep Discord DMs from server members on.</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
