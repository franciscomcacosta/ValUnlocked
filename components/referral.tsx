"use client";

// "Invite" tab — the buyer's referral link and how many friends joined.

import { useEffect, useState } from "react";

type Ref = {
  link: string;
  code: string;
  rewardCents: number;
  friendCents: number;
  minOrderCents: number;
  invited: number;
  rewarded: number;
  earnedCents: number;
  friends: Array<{ name: string; joinedAt: string | null; bought: boolean }>;
};

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

export function InviteTab() {
  const [d, setD] = useState<Ref | null>(null);
  const [err, setErr] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/me/referral")
      .then((r) => r.json())
      .then((j) => (j.ok ? setD(j) : setErr(true)))
      .catch(() => setErr(true));
  }, []);

  async function copy() {
    if (!d) return;
    try {
      await navigator.clipboard.writeText(d.link);
    } catch {
      // Older browsers: select the text field instead.
      (document.getElementById("vu-ref-link") as HTMLInputElement | null)?.select();
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <section className="pn cut" style={{ height: "100%", padding: "20px 24px", display: "flex", flexDirection: "column", gap: "18px" }}>
      <div>
        <span className="lbl">Invite friends</span>
        <h2 className="h" style={{ fontSize: "34px", margin: "6px 0 0" }}>
          {d ? <>Give {eur(d.friendCents)}, get {eur(d.rewardCents)}</> : "Invite friends, earn credit"}
        </h2>
        <p className="mut" style={{ marginTop: "8px", maxWidth: "620px" }}>
          {d ? (
            <>
              Share your link. When a friend signs up through it and makes their first purchase of {eur(d.minOrderCents)} or more,
              you get <b>{eur(d.rewardCents)}</b> store credit and they get <b>{eur(d.friendCents)}</b>. No limit on how many friends you invite.
            </>
          ) : (
            "Share your link — you both get store credit after your friend's first purchase."
          )}
        </p>
      </div>

      {err && <span style={{ color: "var(--accent-rose)" }}>Invites aren't available right now. Try again later.</span>}
      {!d && !err && <span className="mut">Loading your link…</span>}

      {d && (
        <>
          <div className="cs" style={{ maxWidth: "620px", padding: "14px 16px", background: "var(--vu-surface-alt)", display: "flex", gap: "8px", alignItems: "center" }}>
            <input id="vu-ref-link" className="inp mono" readOnly value={d.link} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} />
            <button className="btn btn-red cs" onClick={copy} style={{ flex: "none" }}>{copied ? "Copied ✓" : "Copy link"}</button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 200px))", gap: "10px" }}>
            {[
              ["Friends joined", String(d.invited)],
              ["Friends who bought", String(d.rewarded)],
              ["Credit earned", eur(d.earnedCents)],
            ].map(([label, value]) => (
              <div key={label} className="cs" style={{ padding: "12px 14px", background: "var(--vu-surface-alt)", display: "flex", flexDirection: "column", gap: "4px" }}>
                <span className="lbl">{label}</span>
                <span className="h num" style={{ fontSize: "26px" }}>{value}</span>
              </div>
            ))}
          </div>

          {d.friends.length > 0 && (
            <div className="cs" style={{ maxWidth: "620px", padding: "10px 16px", background: "var(--vu-surface-alt)" }}>
              {d.friends.map((f, i) => (
                <div key={i} className="kv" style={{ fontSize: "14px" }}>
                  <span>{f.name}</span>
                  <span className="mut" style={{ fontSize: "12px" }}>{f.joinedAt ? new Date(f.joinedAt).toLocaleDateString("en-GB") : ""}</span>
                  <span className={`pill ${f.bought ? "g" : "x"}`}>{f.bought ? `+${eur(d.rewardCents)} earned` : "No purchase yet"}</span>
                </div>
              ))}
            </div>
          )}

          <p className="mut" style={{ fontSize: "12px", maxWidth: "620px" }}>
            Only new customers count (people who haven't ordered before). Free gift accounts don't count as a purchase.
            Credit is added automatically and can be spent in the shop.
          </p>
        </>
      )}
    </section>
  );
}
