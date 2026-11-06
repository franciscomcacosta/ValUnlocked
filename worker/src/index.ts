// Extractor worker — headless browser that logs into merch.riotgames.com
// as a given Riot account, scrapes the account email from the Apollo cache,
// and POSTs it back to the main app's /api/worker/callback.
//
// IMPORTANT: this worker DOES NOT defeat captchas. If the Riot login page
// shows hCaptcha, the worker fails fast with `captcha_present` and the
// extraction is handed off to a human (staff log in Discord → bookmarklet).
// Normal account-sharing-tool automation only; no bot-check bypass.
//
// Env:
//   WORKER_SECRET        shared with main app; required on inbound POST /extract
//   CALLBACK_SECRET      shared with main app; sent back on callback POST
//   MAIN_APP_URL         e.g. https://val-unlocked-fmcac-8015s-projects.vercel.app
//   PORT                 default 8080

import Fastify from "fastify";
import { chromium } from "playwright";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const WORKER_SECRET = process.env.WORKER_SECRET;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET;
const MAIN_APP_URL = process.env.MAIN_APP_URL;
const EXTRACTION_TIMEOUT_MS = 90_000;

if (!WORKER_SECRET || !CALLBACK_SECRET || !MAIN_APP_URL) {
  console.error("[worker] missing required env vars WORKER_SECRET, CALLBACK_SECRET, MAIN_APP_URL");
  process.exit(1);
}

const app = Fastify({ logger: { level: "info" } });

interface ExtractBody {
  order_id: string;
  login: string;
  password: string;
}

app.get("/health", async () => ({ ok: true, version: "1.0.0" }));

app.post<{ Body: ExtractBody }>("/extract", async (req, reply) => {
  if (req.headers.authorization !== `Bearer ${WORKER_SECRET}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const { order_id, login, password } = req.body ?? ({} as ExtractBody);
  if (!order_id || !login || !password) {
    return reply.code(400).send({ error: "order_id, login, password required" });
  }

  reply.code(202).send({ ok: true, order_id, queued: true });

  void extractAndCallback(order_id, login, password).catch((e) => {
    console.error(`[worker] fatal error for ${order_id}:`, e);
    sendCallback(order_id, { ok: false, reason: "worker_error", detail: String(e) });
  });
});

async function extractAndCallback(order_id: string, login: string, password: string) {
  const started = Date.now();
  const result = await Promise.race([
    extract(login, password),
    sleepReject(EXTRACTION_TIMEOUT_MS, "extraction_timeout"),
  ]).catch((e) => ({ ok: false as const, reason: String(e?.message ?? e) }));
  const elapsed = Date.now() - started;
  console.log(`[worker] order ${order_id} finished in ${elapsed}ms: ${JSON.stringify(result)}`);
  await sendCallback(order_id, result);
}

interface ExtractOk { ok: true; email: string }
interface ExtractFail { ok: false; reason: string; detail?: string }
type ExtractResult = ExtractOk | ExtractFail;

async function extract(login: string, password: string): Promise<ExtractResult> {
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
    });
    const page = await ctx.newPage();

    await page.goto("https://merch.riotgames.com/en-us/", { waitUntil: "domcontentloaded" });

    await page
      .getByRole("link", { name: /sign in/i })
      .first()
      .click({ timeout: 10_000 })
      .catch(() => {});

    await page.waitForURL(/auth\.riotgames\.com/, { timeout: 20_000 });

    // If Riot shows a captcha on first load, bail out — we don't bypass them.
    if (await page.$('iframe[src*="hcaptcha.com"]')) {
      return { ok: false, reason: "captcha_present" };
    }

    await page.fill('input[name="username"]', login);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    // After submit, outcomes we check for:
    //   - redirect to merch (login ok)
    //   - error message on form
    //   - hCaptcha appearing in response to the submit
    //   - timeout
    const outcome = await Promise.race([
      page.waitForURL(/merch\.riotgames\.com/, { timeout: 25_000 }).then(() => "ok" as const),
      page
        .waitForSelector('iframe[src*="hcaptcha.com"]', { timeout: 25_000 })
        .then(() => "captcha_present" as const),
      page
        .waitForSelector('[data-qa="form-error"], .error, [role="alert"]', { timeout: 25_000 })
        .then(() => "login_error" as const),
    ]).catch(() => "timeout" as const);

    if (outcome === "captcha_present") return { ok: false, reason: "captcha_present" };
    if (outcome === "login_error") return { ok: false, reason: "login_invalid" };
    if (outcome === "timeout") return { ok: false, reason: "login_timeout" };

    const email = await page.evaluate(() => {
      type ApolloClient = { cache: { extract: () => unknown } };
      const w = window as unknown as { __APOLLO_CLIENT__?: ApolloClient };
      const c = w.__APOLLO_CLIENT__;
      if (!c) return null;
      const dump = JSON.stringify(c.cache.extract());
      const match = dump.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g);
      return match?.[0] ?? null;
    });

    if (!email) return { ok: false, reason: "email_not_found" };
    return { ok: true, email };
  } finally {
    await browser.close().catch(() => {});
  }
}

async function sendCallback(order_id: string, payload: ExtractResult): Promise<void> {
  const url = `${MAIN_APP_URL!.replace(/\/$/, "")}/api/worker/callback`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${CALLBACK_SECRET}`,
      },
      body: JSON.stringify({ order_id, ...payload }),
    });
    if (!res.ok) {
      console.error(`[worker] callback failed ${res.status}:`, await res.text().catch(() => ""));
    }
  } catch (e) {
    console.error("[worker] callback fetch error:", e);
  }
}

function sleepReject(ms: number, reason: string): Promise<ExtractFail> {
  return new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason }), ms));
}

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`[worker] listening on :${PORT}`);
});
