"use client";

// "Alerts" tab — get a Discord DM when a matching account drops.

import { useCallback, useEffect, useState } from "react";

type Alert = { id: string; region: string; bracket: string; created_at: string; last_notified_at: string | null };
type Data = { alerts: Alert[]; brackets: Array<{ name: string; label: string }>; regions: string[]; max: number };

const REGION_NAME: Record<string, string> = {
  EU: "Europe", NA: "North America", AP: "Asia Pacific", KR: "Korea", LATAM: "Latin America", BR: "Brazil",
};

export function AlertsTab({ earlyAccess, onSubscribe }: { earlyAccess: boolean; onSubscribe: () => void }) {
  const [d, setD] = useState<Data | null>(null);
  const [region, setRegion] = useState("EU");
  const [bracket, setBracket] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    fetch("/api/alerts")
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) {
          setD(j);
          setBracket((b) => b || j.brackets[0]?.name || "");
        } else setMsg({ ok: false, text: "Alerts aren't available right now." });
      })
      .catch(() => setMsg({ ok: false, text: "Alerts aren't available right now." }));
  }, []);
  useEffect(() => { load(); }, [load]);

  async function add() {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/alerts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ region, bracket }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Couldn't save the alert.");
      setMsg({ ok: true, text: "Alert on — we'll DM you on Discord when one drops." });
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

  const label = (name: string) => d?.brackets.find((b) => b.name === name)?.label ?? name;
  const full = !!d && d.alerts.length >= d.max;

  return (
    <section className="pn cut" style={{ height: "100%", padding: "20px 24px", display: "flex", flexDirection: "column", gap: "18px" }}>
      <div>
        <span className="lbl">Restock alerts</span>
        <h2 className="h" style={{ fontSize: "34px", margin: "6px 0 0" }}>🔔 Get a DM when it drops</h2>
        <p className="mut" style={{ marginTop: "8px", maxWidth: "620px" }}>
          Pick a region and skin range. When a matching account lands in stock, the bot DMs you on Discord.
          {earlyAccess ? (
            <> As a Premium/Ultra member you can buy new drops <b>straight away</b>.</>
          ) : (
            <>
              {" "}New drops are Premium/Ultra-only for the first 2 hours — the DM tells you when it opens up for you.{" "}
              <button className="btn btn-gold cs btn-sm" onClick={onSubscribe} style={{ marginLeft: "4px" }}>Get early access</button>
            </>
          )}
        </p>
      </div>

      {d && (
        <div className="cs" style={{ maxWidth: "620px", padding: "14px 16px", background: "var(--vu-surface-alt)", display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
          <select className="inp" value={region} onChange={(e) => setRegion(e.target.value)} aria-label="Region" style={{ flex: "1 1 160px" }}>
            {d.regions.map((r) => <option key={r} value={r}>{REGION_NAME[r] ?? r}</option>)}
          </select>
          <select className="inp" value={bracket} onChange={(e) => setBracket(e.target.value)} aria-label="Skin range" style={{ flex: "1 1 160px" }}>
            {d.brackets.map((b) => <option key={b.name} value={b.name}>{b.label}</option>)}
          </select>
          <button className="btn btn-red cs" disabled={busy || full} onClick={add} style={{ flex: "none" }}>
            {busy ? "Saving…" : full ? `Max ${d.max} alerts` : "Add alert"}
          </button>
        </div>
      )}
      {msg && <span style={{ fontSize: "13px", color: msg.ok ? "var(--accent-success)" : "var(--accent-rose)" }}>{msg.text}</span>}

      {d && (
        <div className="cs" style={{ maxWidth: "620px", padding: "10px 16px", background: "var(--vu-surface-alt)" }}>
          {d.alerts.length === 0 ? (
            <span className="mut" style={{ fontSize: "14px" }}>No alerts yet.</span>
          ) : (
            d.alerts.map((a) => (
              <div key={a.id} className="kv" style={{ fontSize: "14px", gap: "10px" }}>
                <span style={{ flex: 1 }}>
                  <b>{label(a.bracket)}</b> · {REGION_NAME[a.region] ?? a.region}
                </span>
                <span className="mut" style={{ fontSize: "12px" }}>
                  {a.last_notified_at ? `last DM ${new Date(a.last_notified_at).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" })}` : "waiting for a drop"}
                </span>
                <button className="btn btn-soft cs btn-sm" onClick={() => remove(a.id)}>Remove</button>
              </div>
            ))
          )}
        </div>
      )}
      <p className="mut" style={{ fontSize: "12px", maxWidth: "620px" }}>
        You'll get at most one DM per alert every 30 minutes. Make sure your Discord DMs from server members are on.
      </p>
    </section>
  );
}
