"use client";

// Report-a-problem pop-up (designer's "rf" modal) and the claim-outcome
// notices. Used by the order page and the dashboard.

import { useEffect, useRef, useState } from "react";

const eur = (c: number) => (c / 100).toFixed(2);

// Same six problem types the supplier (qvsp) accepts — keys are their
// category values, so the report reaches them already sorted.
export const CLAIM_REASON_OPTIONS: Array<[string, string, string]> = [
  ["login", "🔑", "Login / password doesn't work"],
  ["login_mfa", "🔒", "Can't log in: it wants an email / MFA code I can't get"],
  ["banned", "🚫", "Account is banned / suspended"],
  ["ingame_ban", "⛔", "In-game ban / restriction (logs in, but can't play Comp)"],
  ["mfa", "📱", "Logs in fine: Ranked/Comp needs verification (phone / MFA)"],
  ["other", "✍️", "Other (type your issue)"],
];
const LEGACY_LABELS: Record<string, string> = { count: "Wrong skin count", locked: "Locked or banned" };
export const claimReasonLabel = (k: string) => CLAIM_REASON_OPTIONS.find((r) => r[0] === k)?.[2] ?? LEGACY_LABELS[k] ?? k;

export type ClaimSummary = {
  id: string;
  order_id?: string;
  reason: string;
  status: string;            // submitted | under_review | replaced | refunded | reissued | denied
  outcome_note: string | null;
  refund_cents: number;
  bonus_cents: number;
  created_at: string;
  resolved_at: string | null;
};

const MAX_BYTES = 200 * 1024 * 1024;

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function putWithProgress(url: string, file: File, onProgress: (p: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("content-type", file.type || "video/mp4");
    xhr.setRequestHeader("x-upsert", "false");
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`upload ${xhr.status}`)));
    xhr.onerror = () => reject(new Error("upload failed"));
    xhr.send(file);
  });
}

export function ReportProblemModal({
  orderId, displayId, itemLabel, paidCents, windowEndsAt, onClose, onSubmitted,
}: {
  orderId: string;
  displayId: string;
  itemLabel: string;
  paidCents: number;
  windowEndsAt: string | null;
  onClose: () => void;
  onSubmitted?: () => void;
}) {
  const [reason, setReason] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [details, setDetails] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [err, setErr] = useState("");
  const [ticket, setTicket] = useState<string | null>(null);
  const now = useNow(!ticket);

  const remaining = windowEndsAt ? new Date(windowEndsAt).getTime() - now : -1;
  // Once the upload has started the claim can still finish after zero.
  const open = remaining > 0 || busy;
  const clock = remaining > 0
    ? `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}`
    : "0:00";

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [busy, onClose]);

  function pickFile(f: File | undefined) {
    setErr("");
    if (!f) return;
    if (!f.type.startsWith("video/")) { setErr("That isn't a video file. Use MP4 or MOV."); return; }
    if (f.size > MAX_BYTES) { setErr("That video is over 200 MB. Trim it to under 60 seconds."); return; }
    setFile(f);
  }

  async function submit() {
    if (!reason || !file) return;
    if (reason === "other" && details.trim().length < 4) { setErr("Tell us what's wrong in the box below."); return; }
    setBusy(true); setErr(""); setProgress(0);
    try {
      const u = await fetch("/api/claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "upload-url", orderId, filename: file.name, size: file.size, type: file.type }),
      }).then((r) => r.json());
      if (!u.ok) throw new Error(
        u.error === "window_closed" ? "The 10-minute window has closed."
        : u.error === "video_too_large" ? "That video is too large."
        : "Couldn't start the upload. Try again."
      );
      await putWithProgress(u.uploadUrl, file, setProgress);
      const s = await fetch("/api/claims", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "submit", orderId, reason, details, videoPath: u.path }),
      }).then((r) => r.json());
      if (!s.ok) throw new Error(
        s.error === "already_reported" ? "You've already reported this order — it's under review."
        : s.error === "window_closed" ? "The 10-minute window has closed."
        : s.error === "claims_unavailable" ? "Reporting isn't switched on yet. Open a ticket in our Discord."
        : s.error === "details_required" ? "Tell us what's wrong in the box below."
        : "Couldn't send the report. Try again."
      );
      setTicket(s.ticket);
      onSubmitted?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const reasonLabel = reason ? claimReasonLabel(reason) : "";

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(15,25,35,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}
      onClick={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}
    >
      <div role="dialog" aria-modal="true" aria-label="Report a problem" className="cut rise" style={{ width: "100%", maxWidth: "520px", maxHeight: "100%", overflow: "auto", background: "#fff", display: "flex", flexDirection: "column", color: "#0f1923" }}>
        <div style={{ background: "#0f1923", color: "#fff", padding: "14px 18px", display: "flex", alignItems: "center", gap: "12px", borderBottom: "3px solid #ff4655" }}>
          <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
            <span className="h" style={{ fontSize: "24px" }}>Report a problem</span>
            <span className="num" style={{ fontSize: "12px", color: "#9aa5b1" }}>
              {itemLabel} · <span className="mono">{displayId}</span> · €{eur(paidCents)}
            </span>
          </div>
          <button className="ico" style={{ color: "#9aa5b1" }} aria-label="Close" onClick={onClose} disabled={busy}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </button>
        </div>

        {ticket ? (
          <div style={{ padding: "24px 18px", display: "flex", flexDirection: "column", gap: "12px", alignItems: "center", textAlign: "center" }}>
            <span className="pill a" style={{ height: "26px", fontSize: "13px" }}>Under review</span>
            <span className="h" style={{ fontSize: "28px" }}>Request sent</span>
            <span className="mut">Ticket <b className="mono" style={{ color: "#0f1923" }}>{ticket}</b> · {reasonLabel} · video attached</span>
            <span className="mut" style={{ fontSize: "12px" }}>
              If the supplier sends a replacement, it's swapped into this order. Otherwise you get back everything you paid
              plus a 5% apology bonus as credit. We&apos;ll DM you on Discord when it&apos;s decided.
            </span>
            <button className="btn btn-dark cs" style={{ width: "100%", marginTop: "6px" }} onClick={onClose}>Done</button>
          </div>
        ) : !open ? (
          <div style={{ padding: "24px 18px", display: "flex", flexDirection: "column", gap: "10px", alignItems: "center", textAlign: "center" }}>
            <span className="cs" style={{ width: "44px", height: "44px", background: "#eef1f5", color: "#5b6474", display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5" /><path d="M9 15h6" /></svg>
            </span>
            <span className="h" style={{ fontSize: "26px" }}>Refund window closed</span>
            <span className="mut">Accounts can be refunded only within 10 minutes of delivery, with a video showing the problem. This order is past that window, so it can&apos;t be refunded here.</span>
            <span className="mut" style={{ fontSize: "12px" }}>Think something&apos;s wrong anyway? Open a ticket in the Discord.</span>
            <button className="btn btn-dark cs" style={{ width: "100%", marginTop: "6px" }} onClick={onClose}>Close</button>
          </div>
        ) : (
          <div style={{ padding: "18px", display: "flex", flexDirection: "column", gap: "12px" }}>
            <div className="cs" style={{ display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: "#fef3c7", color: "#713f12" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>
              <span style={{ flex: 1, fontSize: "13px" }}>Verification window — test the account now. Once this hits zero the account is yours and can&apos;t be refunded.</span>
              <span className="bc num" style={{ fontWeight: 700, fontSize: "24px", color: remaining <= 120000 ? "#be123c" : "#a16207" }}>{clock}</span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span className="lbl" style={{ color: "#0f1923" }}>What&apos;s wrong?</span>
              <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                {CLAIM_REASON_OPTIONS.map(([k, icon, label]) => (
                  <button
                    key={k}
                    className="cs"
                    aria-pressed={reason === k}
                    onClick={() => setReason(k)}
                    style={{ minHeight: "40px", border: 0, cursor: "pointer", textAlign: "left", padding: "8px 12px", display: "flex", alignItems: "center", gap: "10px", fontWeight: 600, fontSize: "14px", background: reason === k ? "#0f1923" : "#eef1f5", color: reason === k ? "#fff" : "#0f1923", transition: "background-color 140ms, color 140ms" }}
                  >
                    <span aria-hidden="true" style={{ width: "20px", textAlign: "center" }}>{icon}</span>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span className="lbl" style={{ color: "#0f1923" }}>Video evidence · required</span>
              {file ? (
                <div className="cs" style={{ position: "relative", overflow: "hidden", display: "flex", alignItems: "center", gap: "10px", padding: "10px 12px", background: "#0f1923", color: "#fff" }}>
                  {busy && <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.round(progress * 100)}%`, background: "rgba(74,222,128,0.18)", transition: "width 200ms" }} />}
                  <svg style={{ position: "relative" }} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m22 8-6 4 6 4V8Z" /><rect x="2" y="6" width="14" height="12" rx="2" /></svg>
                  <span className="mono" style={{ position: "relative", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{file.name}</span>
                  <span className="num" style={{ position: "relative", fontSize: "12px", color: "#9aa5b1" }}>
                    {busy ? `${Math.round(progress * 100)}%` : `${(file.size / 1048576).toFixed(1)} MB`}
                  </span>
                  {!busy && (
                    <button className="ico" style={{ position: "relative", color: "#9aa5b1" }} aria-label="Remove video" onClick={() => setFile(null)}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
                    </button>
                  )}
                </div>
              ) : (
                <label className="cs" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "4px", padding: "16px", background: "#f4f6f8", border: "2px dashed #cbd2db", cursor: "pointer", textAlign: "center" }}>
                  <input type="file" accept="video/*" onChange={(e) => pickFile(e.target.files?.[0])} style={{ display: "none" }} />
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#5b6474" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" /></svg>
                  <span style={{ fontWeight: 600 }}>Add a screen recording</span>
                  <span className="mut" style={{ fontSize: "12px" }}>Show the account not working or the wrong skins. MP4 or MOV, under 60s.</span>
                </label>
              )}
            </div>

            <label style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
              <span className="lbl" style={{ color: "#0f1923" }}>Details <span className="mut" style={{ textTransform: "none", letterSpacing: 0, fontWeight: 400, fontSize: "12px" }}>{reason === "other" ? "(required — what's wrong?)" : "(optional)"}</span></span>
              <textarea className="inp" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={1000} style={{ height: "52px", padding: "10px 12px", resize: "none" }} placeholder="Error message, time, what you tried…" />
            </label>

            <span className="mut" style={{ fontSize: "12px" }}>
              We review your video with the supplier. If they send a replacement, you get that account.{" "}
              {paidCents > 0 ? (
                <>If not, you get back the full <b style={{ color: "#0f1923" }}>€{eur(paidCents)}</b> you paid plus a <b style={{ color: "#15803d" }}>5% apology bonus</b> as credit.</>
              ) : (
                <>If not, you get a <b style={{ color: "#15803d" }}>brand-new free account</b> to claim.</>
              )}{" "}
              The outcome arrives as a Discord DM.
            </span>

            {err && <div className="rise" style={{ background: "#ffe4e6", color: "#be123c", fontSize: "13px", padding: "8px 10px" }}>{err}</div>}

            <div style={{ display: "flex", gap: "8px" }}>
              <button className="btn btn-soft cs" style={{ flex: 1 }} onClick={onClose} disabled={busy}>Cancel</button>
              <button className="btn btn-red cs" style={{ flex: 2 }} disabled={!reason || !file || busy} onClick={submit}>
                {busy ? (progress < 1 ? `Uploading ${Math.round(progress * 100)}%…` : "Sending…") : "Submit with video"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Status card for an order's latest claim (order page). */
export function ClaimStatusCard({ claim, onOpenOrder }: { claim: ClaimSummary; onOpenOrder?: () => void }) {
  const total = claim.refund_cents + claim.bonus_cents;
  if (claim.status === "refunded") {
    return (
      <div className="cut reveal" style={{ position: "relative", overflow: "hidden", background: "#0f1923", color: "#fff", padding: "16px 16px 14px", ["--tc" as string]: "#4ade80" }}>
        <span className="burst" />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: "6px" }}>
          <span className="bc" style={{ color: "#4ade80", fontWeight: 700, fontSize: "14px", letterSpacing: "0.1em" }}>Refunded to your credit</span>
          <span className="h num" style={{ fontSize: "40px" }}>+€{eur(total)}</span>
          <div style={{ display: "flex", flexDirection: "column", gap: "2px", fontSize: "13px" }}>
            <span style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#9aa5b1" }}>What you paid</span><span className="num">€{eur(claim.refund_cents)}</span></span>
            <span style={{ display: "flex", justifyContent: "space-between", color: "#ffd400", fontWeight: 600 }}><span>+5% apology bonus</span><span className="num">€{eur(claim.bonus_cents)}</span></span>
          </div>
          <span style={{ fontSize: "12px", color: "#9aa5b1" }}>Sorry about that one. It&apos;s in your wallet, ready to spend.</span>
        </div>
      </div>
    );
  }
  if (claim.status === "reissued") {
    return (
      <div className="cut reveal" style={{ position: "relative", overflow: "hidden", background: "#0f1923", color: "#fff", padding: "16px", ["--tc" as string]: "#ffd400" }}>
        <span className="burst" />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: "6px" }}>
          <span className="bc" style={{ color: "#ffd400", fontWeight: 700, fontSize: "14px", letterSpacing: "0.1em" }}>New free account</span>
          <span className="h" style={{ fontSize: "28px" }}>Claim a fresh one</span>
          <span style={{ fontSize: "13px", color: "#9aa5b1" }}>Sorry that one didn&apos;t work. Your free account is back — pick a region and it&apos;s delivered instantly.</span>
          <a className="btn btn-gold cs btn-sm" style={{ textDecoration: "none" }} href="/?claim=gift">Claim my new account</a>
        </div>
      </div>
    );
  }
  if (claim.status === "replaced") {
    return (
      <div className="cut reveal" style={{ position: "relative", overflow: "hidden", background: "#0f1923", color: "#fff", padding: "16px", ["--tc" as string]: "#22d3ee" }}>
        <span className="burst" />
        <div style={{ position: "relative", display: "flex", flexDirection: "column", gap: "6px" }}>
          <span className="bc" style={{ color: "#67e8f9", fontWeight: 700, fontSize: "14px", letterSpacing: "0.1em" }}>Replacement delivered</span>
          <span className="h" style={{ fontSize: "28px" }}>New account ready</span>
          <span style={{ fontSize: "13px", color: "#9aa5b1" }}>The supplier sent a replacement. Its login is now in this order&apos;s credentials.</span>
          {onOpenOrder && <button className="btn btn-soft cs btn-sm" onClick={onOpenOrder}>View credentials</button>}
        </div>
      </div>
    );
  }
  if (claim.status === "denied") {
    return (
      <div className="cs" style={{ padding: "12px 14px", background: "#f4f6f8", display: "flex", flexDirection: "column", gap: "4px" }}>
        <span className="pill x" style={{ alignSelf: "flex-start" }}>Report not approved</span>
        <span className="mut" style={{ fontSize: "13px" }}>{claim.outcome_note ?? "The supplier reviewed the video and didn't approve it."} If you think that&apos;s wrong, open a ticket in our Discord.</span>
      </div>
    );
  }
  return (
    <div className="cs" style={{ padding: "12px 14px", background: "#fef3c7", color: "#713f12", display: "flex", flexDirection: "column", gap: "4px" }}>
      <span className="pill a" style={{ alignSelf: "flex-start", background: "#fff7d6" }}>Under review</span>
      <span style={{ fontSize: "13px" }}>
        Ticket <b className="mono">RF-{claim.id.slice(0, 8).toUpperCase()}</b>. A replacement if the supplier sends one,
        otherwise {claim.refund_cents > 0
          ? <>€{eur(claim.refund_cents)} back + €{eur(claim.bonus_cents)} apology bonus as credit.</>
          : <>a brand-new free account to claim.</>}
      </span>
    </div>
  );
}

/** Dashboard pop-up for refunds / replacements the buyer hasn't seen yet. */
export function ClaimOutcomeModal({ onCredited }: { onCredited?: () => void }) {
  const [claims, setClaims] = useState<ClaimSummary[]>([]);
  const notified = useRef(false);

  useEffect(() => {
    fetch("/api/claims?unseen=1")
      .then((r) => r.json())
      .then((d) => {
        if (d.ok && d.claims?.length) {
          setClaims(d.claims);
          if (!notified.current && d.claims.some((c: ClaimSummary) => c.status === "refunded")) {
            notified.current = true;
            onCredited?.();
          }
        }
      })
      .catch(() => {});
  }, [onCredited]);

  if (!claims.length) return null;
  const refunds = claims.filter((c) => c.status === "refunded");
  const replaced = claims.filter((c) => c.status === "replaced");
  const reissued = claims.filter((c) => c.status === "reissued");
  const paid = refunds.reduce((a, c) => a + c.refund_cents, 0);
  const bonus = refunds.reduce((a, c) => a + c.bonus_cents, 0);

  function close() {
    const ids = claims.map((c) => c.id);
    setClaims([]);
    fetch("/api/claims", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "seen", ids }) }).catch(() => {});
  }

  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 70, background: "rgba(15,25,35,0.7)", display: "flex", alignItems: "center", justifyContent: "center", padding: "16px" }}>
      <div role="dialog" aria-modal="true" aria-label="Your report was resolved" className="cut reveal" style={{ position: "relative", overflow: "hidden", width: "100%", maxWidth: "460px", background: "#0f1923", color: "#fff", ["--tc" as string]: refunds.length ? "#4ade80" : reissued.length ? "#ffd400" : "#22d3ee" }}>
        <span className="burst" />
        <div style={{ position: "relative", padding: "26px 24px 22px", display: "flex", flexDirection: "column", gap: "12px", alignItems: "center", textAlign: "center" }}>
          {refunds.length > 0 ? (
            <>
              <span className="bc" style={{ color: "#4ade80", fontWeight: 700, fontSize: "15px", letterSpacing: "0.12em" }}>Refund issued</span>
              <span className="h num" style={{ fontSize: "64px", lineHeight: 0.95 }}>+€{eur(paid + bonus)}</span>
              <span style={{ color: "#cbd5e1" }}>added to your credit</span>
              <div className="cs" style={{ width: "100%", background: "rgba(255,255,255,0.06)", padding: "10px 14px", display: "flex", flexDirection: "column", gap: "4px" }}>
                <span style={{ display: "flex", justifyContent: "space-between" }}><span style={{ color: "#9aa5b1" }}>What you paid</span><span className="num">€{eur(paid)}</span></span>
                <span className="rise" style={{ display: "flex", justifyContent: "space-between", color: "#ffd400", fontWeight: 700, animationDelay: "500ms" }}>
                  <span>+5% apology bonus</span><span className="num">€{eur(bonus)}</span>
                </span>
              </div>
              <span style={{ fontSize: "13px", color: "#9aa5b1" }}>Sorry that account didn&apos;t work out. The credit is ready to spend right now.</span>
            </>
          ) : null}
          {reissued.length > 0 && (
            <>
              <span className="bc" style={{ color: "#ffd400", fontWeight: 700, fontSize: "15px", letterSpacing: "0.12em" }}>New free account</span>
              <span className="h" style={{ fontSize: refunds.length ? "26px" : "40px" }}>Your free account is back</span>
              <span style={{ fontSize: "13px", color: "#9aa5b1" }}>Sorry that one didn&apos;t work. Pick a region and claim a brand-new one — it&apos;s delivered instantly.</span>
              <a className="btn btn-gold cs" style={{ width: "100%", textDecoration: "none" }} href="/?claim=gift" onClick={close}>Claim my new account</a>
            </>
          )}
          {replaced.length > 0 && (
            <>
              <span className="bc" style={{ color: "#67e8f9", fontWeight: 700, fontSize: "15px", letterSpacing: "0.12em" }}>Replacement delivered</span>
              <span className="h" style={{ fontSize: refunds.length ? "26px" : "40px" }}>Your new account is ready</span>
              <span style={{ fontSize: "13px", color: "#9aa5b1" }}>The supplier sent a replacement. Its login is in your order now.</span>
              {replaced[0].order_id && (
                <a className="btn btn-soft cs" style={{ width: "100%", textDecoration: "none" }} href={`/orders/${replaced[0].order_id}`} onClick={close}>
                  View credentials
                </a>
              )}
            </>
          )}
          <button className="btn btn-gold cut btn-lg" onClick={close}>{refunds.length ? "Nice — back to the store" : "Got it"}</button>
        </div>
      </div>
    </div>
  );
}

/** Big "Is everything OK with the account?" prompt shown right after
 *  delivery. Yes → a slim reminder that they can still report until the
 *  10-minute window ends. No → opens the report form. */
export function AccountCheckPrompt({
  orderId, windowEndsAt, onReport,
}: {
  orderId: string;
  windowEndsAt: string | null;
  onReport: () => void;
}) {
  const key = `vu_ok_${orderId}`;
  const [answer, setAnswer] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    try { setAnswer(localStorage.getItem(key)); } catch { /* private mode */ }
  }, [key]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const end = windowEndsAt ? new Date(windowEndsAt).getTime() : 0;
  const left = end - now;
  if (!windowEndsAt || left <= 0) return null;
  const clock = `${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")}`;
  const urgent = left <= 120_000;

  const sayYes = () => {
    setAnswer("yes");
    try { localStorage.setItem(key, "yes"); } catch { /* ignore */ }
  };

  if (answer === "yes") {
    return (
      <div className="cs rise" role="status" style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: "12px", padding: "10px 16px", background: "#dcfce7", color: "#14532d" }}>
        <span aria-hidden="true" style={{ fontSize: "18px" }}>✅</span>
        <span style={{ flex: 1, fontSize: "14px" }}>
          Glad it works — enjoy! Something wrong after all? You can still report it for <b className="num">{clock}</b>.
        </span>
        <button className="btn btn-soft cs btn-sm" style={{ color: "#be123c" }} onClick={onReport}>Report a problem</button>
      </div>
    );
  }

  return (
    <div
      className="cs rise"
      role="region"
      aria-label="Check your account"
      style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", gap: "18px", flexWrap: "wrap", padding: "16px 20px", background: "#0f1923", color: "#fff", borderLeft: "5px solid #ffd400", boxShadow: "0 0 0 2px rgba(255,212,0,0.25)" }}
    >
      <div style={{ flex: "1 1 320px", display: "flex", flexDirection: "column", gap: "4px" }}>
        <span className="h" style={{ fontSize: "28px", lineHeight: 1 }}>Is everything OK with the account?</span>
        <span style={{ fontSize: "14px", color: "#c9d1d9" }}>
          Log in now and check. If something&apos;s wrong you get a <b style={{ color: "#fff" }}>replacement or your money back</b> — just tell us within{" "}
          <b className="num" style={{ color: urgent ? "#ff4655" : "#ffd400", fontSize: "16px" }}>{clock}</b>.
        </span>
      </div>
      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
        <button className="btn cs" onClick={sayYes} style={{ height: "48px", padding: "0 20px", background: "#16a34a", color: "#fff", fontSize: "17px" }}>
          ✅ Yes, it works
        </button>
        <button className="btn cs" onClick={onReport} style={{ height: "48px", padding: "0 20px", background: "#ff4655", color: "#fff", fontSize: "17px" }}>
          ❌ No, there&apos;s a problem
        </button>
      </div>
    </div>
  );
}
