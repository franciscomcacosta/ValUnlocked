"use client";
// Email Grabber — polished 3-step walkthrough backed by the bookmarklet.
// No server-side auto-login: no credentials collected, no captcha hell,
// no risk. The bookmarklet runs entirely in the user's own browser.
import { useEffect, useState } from "react";

interface Tool {
  name: string;
  display_name: string;
  description: string | null;
  min_tier: "standard" | "premium" | "ultra";
  script: string;
  bookmarklet: string | null;
  instructions: string | null;
  target_site: string | null;
  version: number;
}

type ApiResponse =
  | { ok: true; tool: Tool }
  | { ok?: false; error: "auth_required" | "tier_required" | "not_found"; required?: string; current?: string | null };

export default function EmailGrabberPage() {
  const [state, setState] = useState<ApiResponse | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/tools/email_grabber")
      .then((r) => r.json().then((d) => ({ status: r.status, data: d })))
      .then(({ data }) => setState(data))
      .catch(() => setState({ error: "not_found" }));
  }, []);

  const copy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
  };

  if (!state) return <div className="center muted">Loading…</div>;

  if ("error" in state && state.error === "auth_required") {
    return (
      <div className="wrap" style={{ maxWidth: 520, textAlign: "center" }}>
        <h2>🔒 Sign in required</h2>
        <p className="muted">Log in with Discord to access the Email Grabber.</p>
        <a className="btn" href="/api/auth/login">Sign in with Discord</a>
      </div>
    );
  }

  if ("error" in state && state.error === "tier_required") {
    const needed = state.required ? state.required[0].toUpperCase() + state.required.slice(1) : "Standard";
    return (
      <div className="wrap" style={{ maxWidth: 520, textAlign: "center" }}>
        <h2>🔒 Subscription required</h2>
        <p className="muted">The Email Grabber is a <strong>{needed}</strong>-tier perk.</p>
        <a className="btn" href="/pricing">See plans</a>
      </div>
    );
  }

  if (!("ok" in state) || !state.ok) {
    return <div className="center muted">Something went wrong. Try again in a moment.</div>;
  }

  const { tool } = state;

  return (
    <div className="wrap" style={{ maxWidth: 720 }}>
      <a href="/" className="muted">← Back</a>
      <h1 style={{ marginTop: 12 }}>🔑 {tool.display_name}</h1>
      <p className="muted">{tool.description}</p>

      {/* STEP 1 — the bookmarklet */}
      <div className="card" style={{ marginTop: 24 }}>
        <div className="step-number">1</div>
        <h3>Save the bookmarklet</h3>
        <p className="muted">
          Drag the button below to your <strong>bookmarks bar</strong>. If you don&apos;t see your bookmarks bar, press{" "}
          <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> (or <kbd>⌘</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd> on Mac) to show it.
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 12, flexWrap: "wrap" }}>
          {tool.bookmarklet && (
            <a
              href={tool.bookmarklet}
              className="btn bookmarklet"
              onClick={(e) => {
                // Don't execute in this tab — it does nothing here anyway,
                // but prevents a confusing "Apollo not found" alert if the
                // user clicks instead of drags.
                e.preventDefault();
                alert("Drag this button to your bookmarks bar — don't click it here. Then click it from your bookmarks while logged in on merch.riotgames.com.");
              }}
              draggable
              title="Drag me to your bookmarks bar"
            >
              📌 Email Grabber
            </a>
          )}
          {tool.bookmarklet && (
            <button className="btn-ghost" onClick={() => copy(tool.bookmarklet!, "bm")}>
              {copied === "bm" ? "Copied ✓" : "Copy as text"}
            </button>
          )}
        </div>
        <details style={{ marginTop: 12 }}>
          <summary className="muted" style={{ cursor: "pointer" }}>
            Can&apos;t drag? Add manually
          </summary>
          <ol style={{ marginTop: 8 }}>
            <li>Right-click your bookmarks bar → <strong>Add bookmark</strong></li>
            <li>Name: <code>Email Grabber</code></li>
            <li>URL: <em>paste the text from &ldquo;Copy as text&rdquo; above</em></li>
            <li>Save.</li>
          </ol>
        </details>
      </div>

      {/* STEP 2 — open target site */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="step-number">2</div>
        <h3>Log in to Riot&apos;s merch store</h3>
        <p className="muted">
          Open the store in a new tab and sign in with the <strong>account whose email you want</strong>. Any page on the
          site works — the home page is fine.
        </p>
        <a
          className="btn"
          href={tool.target_site ?? "https://merch.riotgames.com"}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open merch.riotgames.com ↗
        </a>
      </div>

      {/* STEP 3 — click the bookmarklet */}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="step-number">3</div>
        <h3>Click the bookmarklet</h3>
        <p className="muted">
          While on the merch site logged in, click the <strong>Email Grabber</strong> button in your bookmarks bar. A
          popup shows the account&apos;s email — press <kbd>Ctrl</kbd>+<kbd>C</kbd> to copy it, then close the popup.
        </p>
        <div className="notice" style={{ marginTop: 12 }}>
          💡 Now go to <a href="https://account.riotgames.com/" target="_blank" rel="noopener noreferrer">account.riotgames.com</a>{" "}
          and change the recovery email to one you control. The account is yours.
        </div>
      </div>

      {/* Fallback — console snippet for power users */}
      <details className="card" style={{ marginTop: 16, opacity: 0.85 }}>
        <summary style={{ cursor: "pointer" }}>
          <strong>Alternative: console snippet</strong> — paste into DevTools (F12 → Console)
        </summary>
        <pre style={{ marginTop: 12, overflow: "auto", background: "#0d0f14", padding: 12, borderRadius: 6 }}>
          <code>{tool.script}</code>
        </pre>
        <button className="btn-ghost" onClick={() => copy(tool.script, "script")}>
          {copied === "script" ? "Copied ✓" : "Copy script"}
        </button>
      </details>

      <p className="muted" style={{ marginTop: 24, textAlign: "center", fontSize: 12 }}>
        Tool v{tool.version} · Breaks when Riot updates their site? Open a ticket in Discord — we push updates centrally,
        no re-download needed.
      </p>

      <style jsx>{`
        .step-number {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: #ff4655;
          color: white;
          font-weight: 700;
          font-size: 14px;
          margin-right: 8px;
          vertical-align: middle;
        }
        h3 {
          display: inline;
          vertical-align: middle;
        }
        kbd {
          background: #1a1d24;
          border: 1px solid #2a2f3a;
          border-radius: 3px;
          padding: 1px 6px;
          font-family: inherit;
          font-size: 0.85em;
        }
        .bookmarklet {
          background: linear-gradient(135deg, #ff4655, #ff6b7a);
          cursor: grab;
          user-select: none;
        }
        .bookmarklet:active {
          cursor: grabbing;
        }
        .btn-ghost {
          background: transparent;
          border: 1px solid #2a2f3a;
          color: inherit;
          padding: 8px 14px;
          border-radius: 6px;
          cursor: pointer;
          font-size: 14px;
        }
        .btn-ghost:hover {
          background: #1a1d24;
        }
      `}</style>
    </div>
  );
}
