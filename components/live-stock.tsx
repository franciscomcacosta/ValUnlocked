"use client";

// Live stock updates.
//
// The stock watcher (watcher/ on Fly.io) broadcasts one compact message on
// Supabase Realtime channel "stock" whenever qvsp stock changes:
//   { at, added, removed, changed, byRegion, drops: [{ region, skin, tier, skins }] }
//
// One subscription for the whole page (useStockFeed, in the root) re-emits
// each message as a window event; screens call useStockVersion() and refetch
// quietly when it ticks. Only the public publishable key is used here — every
// table has RLS on with no public policies, so it can't read data; it can
// only listen to this broadcast channel.

import { useEffect, useRef, useState } from "react";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://ryxtatkwzykgtddrxywe.supabase.co";
const PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_7KCj617YxQkma0Znepyfpg_Rbaxbyuu";
const EVENT = "vu:stock";

export type StockDrop = { region: string; skin: string; tier: string; skins: number; at?: string };
export type StockChange = {
  at: string;
  added: number;
  removed: number;
  changed: number;
  byRegion: Record<string, { added: number; removed: number }>;
  drops: StockDrop[];
};

let client: SupabaseClient | null = null;
function realtime(): SupabaseClient {
  if (!client) client = createClient(SUPABASE_URL, PUBLISHABLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

/** Root-level: subscribe once, re-emit changes, and keep a short list of
 *  recent drops for the LIVE ticker (seeded from /api/stock/drops). */
export function useStockFeed(): { drops: StockDrop[]; connected: boolean } {
  const [drops, setDrops] = useState<StockDrop[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    fetch("/api/stock/drops")
      .then((r) => r.json())
      .then((d) => { if (d.ok) setDrops(d.drops); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const channel = realtime()
      .channel("stock")
      .on("broadcast", { event: "changes" }, ({ payload }) => {
        const change = payload as StockChange;
        window.dispatchEvent(new CustomEvent<StockChange>(EVENT, { detail: change }));
        if (change.drops?.length) {
          setDrops((cur) => change.drops.map((d): StockDrop => ({ ...d, at: change.at })).concat(cur).slice(0, 16));
        }
      })
      .subscribe((status) => setConnected(status === "SUBSCRIBED"));
    return () => { realtime().removeChannel(channel); };
  }, []);

  return { drops, connected };
}

/** Ticks when stock changes (debounced), plus every 2 min so listings that
 *  come out of the 2-hour early-access window also show up. */
export function useStockVersion(debounceMs = 1500): number {
  const [v, setV] = useState(0);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const bump = () => {
      if (t.current) clearTimeout(t.current);
      t.current = setTimeout(() => setV((x) => x + 1), debounceMs);
    };
    window.addEventListener(EVENT, bump);
    const poll = setInterval(() => setV((x) => x + 1), 120_000);
    return () => {
      window.removeEventListener(EVENT, bump);
      clearInterval(poll);
      if (t.current) clearTimeout(t.current);
    };
  }, [debounceMs]);
  return v;
}

const TIER_COLOR: Record<string, string> = { Ultra: "#fad663", Exclusive: "#f5955b", Premium: "#d1548d" };

/** "New drop" toasts. New listings sit in Premium early access for 2 hours,
 *  so only Premium / Ultra members get toasts (they can buy right away). */
export function DropToasts({ earlyAccess }: { earlyAccess: boolean }) {
  const [toasts, setToasts] = useState<Array<StockDrop & { id: number }>>([]);
  const seq = useRef(0);

  useEffect(() => {
    if (!earlyAccess) return;
    const onChange = (e: Event) => {
      const change = (e as CustomEvent<StockChange>).detail;
      const fresh = (change.drops ?? []).slice(0, 3).map((d) => ({ ...d, id: ++seq.current }));
      if (!fresh.length) return;
      setToasts((cur) => fresh.concat(cur).slice(0, 4));
      for (const f of fresh) setTimeout(() => setToasts((cur) => cur.filter((x) => x.id !== f.id)), 7000);
    };
    window.addEventListener(EVENT, onChange);
    return () => window.removeEventListener(EVENT, onChange);
  }, [earlyAccess]);

  if (!toasts.length) return null;
  return (
    <div aria-live="polite" style={{ position: "fixed", right: "20px", bottom: "20px", zIndex: 80, display: "flex", flexDirection: "column", gap: "8px", pointerEvents: "none" }}>
      {toasts.map((t) => (
        <div
          key={t.id}
          className="cs rise"
          style={{ pointerEvents: "auto", minWidth: "260px", maxWidth: "340px", background: "#0f1923", color: "#fff", padding: "10px 14px", borderLeft: `3px solid ${TIER_COLOR[t.tier] ?? "#ff4655"}`, boxShadow: "0 8px 24px rgba(0,0,0,0.25)" }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span className="bc" style={{ fontSize: "12px", fontWeight: 700, color: "#4ade80", letterSpacing: "0.08em" }}>New drop</span>
            <span className="rg">{t.region}</span>
            <span className="bc" style={{ marginLeft: "auto", fontSize: "11px", fontWeight: 700, color: "#0f1923", background: "#ffd400", padding: "1px 5px" }}>Early access</span>
          </div>
          <div className="bc" style={{ fontSize: "17px", fontWeight: 700, color: TIER_COLOR[t.tier] ?? "#fff" }}>{t.skin}</div>
          <div style={{ fontSize: "12px", color: "#9aa5b1" }}>{t.skins} skins on the account</div>
        </div>
      ))}
    </div>
  );
}
