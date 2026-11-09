// Extractor + verifier worker — headless browser that logs into
// merch.riotgames.com as a given Riot account, verifies the credentials
// work, scrapes the account email from the Apollo cache, and POSTs the
// result back to the main app's /api/worker/callback.
//
// Two endpoints:
//   POST /verify  — SYNCHRONOUS. Called BEFORE fulfilment. Attempts login
//     while recording a video. Returns the verdict (+ video URL on
//     failure) inline so the main app can swap the account if it's
//     broken. Replies within ~60s typical, 90s max.
//   POST /extract — ASYNC. Legacy path. Called AFTER fulfilment for
//     orders that /verify couldn't decide (captcha, timeout). Calls back
//     to /api/worker/callback when done.
//
// hCaptcha policy: we DO NOT defeat them. If one appears, we bail out
// with `captcha_present` and the main app falls back to the 10-min
// test-window flow.
//
// Env:
//   WORKER_SECRET          shared with main app; required on inbound POST
//   CALLBACK_SECRET        shared with main app; sent back on /extract callback
//   MAIN_APP_URL           e.g. https://valunlock.online
//   SUPABASE_URL           for uploading failure-proof videos
//   SUPABASE_SERVICE_ROLE_KEY   service role key with write access to qvsp-proofs
//   QVSP_PROOFS_BUCKET     default "qvsp-proofs"
//   PORT                   default 8080

import Fastify from "fastify";
import { chromium, type BrowserContext, type Page } from "playwright";
import { readFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const WORKER_SECRET = process.env.WORKER_SECRET;
const CALLBACK_SECRET = process.env.CALLBACK_SECRET;
const MAIN_APP_URL = process.env.MAIN_APP_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const QVSP_PROOFS_BUCKET = process.env.QVSP_PROOFS_BUCKET ?? "qvsp-proofs";

// Playwright caps outcome-wait races at 25s each, plus up to 25s for
// nav + a few seconds of overhead. 80s keeps us comfortably under the
// main app's 90s wait budget.
const EXTRACTION_TIMEOUT_MS = 80_000;

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

app.get("/health", async () => ({ ok: true, version: "2.0.0" }));

// ─── /verify: synchronous — returns the verdict inline. ──────────────
app.post<{ Body: ExtractBody }>("/verify", async (req, reply) => {
  if (req.headers.authorization !== `Bearer ${WORKER_SECRET}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const { order_id, login, password } = req.body ?? ({} as ExtractBody);
  if (!order_id || !login || !password) {
    return reply.code(400).send({ error: "order_id, login, password required" });
  }

  const result = await runVerify(order_id, login, password);
  return reply.send(result);
});

// ─── /extract: async — kept for the post-verify fallback path. ───────
app.post<{ Body: ExtractBody }>("/extract", async (req, reply) => {
  if (req.headers.authorization !== `Bearer ${WORKER_SECRET}`) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const { order_id, login, password } = req.body ?? ({} as ExtractBody);
  if (!order_id || !login || !password) {
    return reply.code(400).send({ error: "order_id, login, password required" });
  }

  reply.code(202).send({ ok: true, order_id, queued: true });

  void (async () => {
    const result = await runVerify(order_id, login, password);
    // Callback only sends the email (and reason on failure). The video
    // URL is already logged by runVerify if needed.
    await sendCallback(order_id, result.ok
      ? { ok: true, email: result.email }
      : { ok: false, reason: result.reason, detail: result.detail });
  })().catch((e) => {
    console.error(`[worker] fatal error for ${order_id}:`, e);
    void sendCallback(order_id, { ok: false, reason: "worker_error", detail: String(e) });
  });
});

interface VerifyOk {
  ok: true;
  email: string;
}
interface VerifyFail {
  ok: false;
  reason: "login_invalid" | "captcha_present" | "login_timeout" | "email_not_found" | "worker_error" | "extraction_timeout";
  detail?: string;
  video_url?: string;  // only on login_invalid, when we have real proof
}
type VerifyResult = VerifyOk | VerifyFail;

async function runVerify(order_id: string, login: string, password: string): Promise<VerifyResult> {
  const started = Date.now();
  const result = await Promise.race([
    verify(order_id, login, password),
    sleepReject(EXTRACTION_TIMEOUT_MS),
  ]).catch((e): VerifyFail => ({ ok: false, reason: "worker_error", detail: String(e?.message ?? e) }));
  const elapsed = Date.now() - started;
  console.log(`[worker] order ${order_id} finished in ${elapsed}ms: ${JSON.stringify(result)}`);
  return result;
}

async function verify(order_id: string, login: string, password: string): Promise<VerifyResult> {
  // Each order's video goes in its own folder so Playwright's "one video
  // per page" model gives us a predictable path to find.
  const videoDir = join(tmpdir(), `riot-verify-${order_id}-${Date.now()}`);
  await mkdir(videoDir, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  let ctx: BrowserContext | null = null;
  let page: Page | null = null;
  try {
    ctx = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      viewport: { width: 1366, height: 768 },
      locale: "en-US",
      // Record the whole session. Playwright writes it on page.close(),
      // and we read it right after.
      recordVideo: { dir: videoDir, size: { width: 1366, height: 768 } },
    });
    page = await ctx.newPage();

    await page.goto("https://merch.riotgames.com/en-us/", { waitUntil: "domcontentloaded" });

    await page
      .getByRole("link", { name: /sign in/i })
      .first()
      .click({ timeout: 10_000 })
      .catch(() => {});

    await page.waitForURL(/auth\.riotgames\.com/, { timeout: 20_000 });

    if (await page.$('iframe[src*="hcaptcha.com"]')) {
      // No login attempt happened — we don't ship a "proof" video of a
      // captcha challenge because nothing meaningful was tried.
      return { ok: false, reason: "captcha_present" };
    }

    await page.fill('input[name="username"]', login);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

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

    if (outcome === "login_error" || outcome === "timeout") {
      // The account's creds are bad (or at least don't work from this
      // IP). Record + upload the video so qvsp can see the attempt.
      const videoPath = await closeAndGetVideo(page, ctx);
      page = null; ctx = null;
      const url = videoPath ? await uploadProofVideo(order_id, videoPath).catch((e) => {
        console.error("[worker] proof upload failed:", e);
        return undefined;
      }) : undefined;
      if (videoPath) { await unlink(videoPath).catch(() => {}); }
      return {
        ok: false,
        reason: outcome === "timeout" ? "login_timeout" : "login_invalid",
        video_url: url,
      };
    }

    // Login succeeded — scrape the email, then throw the video away.
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
    // Clean up — throw away the video for successful/captcha sessions.
    if (page) {
      const videoPath = await closeAndGetVideo(page, ctx);
      if (videoPath) await unlink(videoPath).catch(() => {});
    } else if (ctx) {
      await ctx.close().catch(() => {});
    }
    await browser.close().catch(() => {});
  }
}

/** Close the page + context and return the finalized video path (or null). */
async function closeAndGetVideo(page: Page, ctx: BrowserContext | null): Promise<string | null> {
  const video = page.video();
  await page.close().catch(() => {});
  if (ctx) await ctx.close().catch(() => {});
  if (!video) return null;
  // Playwright finalizes the file on context close; path() is safe now.
  try { return await video.path(); } catch { return null; }
}

/** Upload a .webm to Supabase Storage and return a 30-day signed URL. */
async function uploadProofVideo(order_id: string, localPath: string): Promise<string | undefined> {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) return undefined;
  const bytes = await readFile(localPath);
  const objectPath = `${new Date().toISOString().slice(0, 10)}/${order_id}.webm`;
  const uploadUrl = `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/${QVSP_PROOFS_BUCKET}/${encodeURIComponent(objectPath)}`;

  const putRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "video/webm",
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!putRes.ok) {
    console.error(`[worker] supabase upload ${putRes.status}:`, await putRes.text().catch(() => ""));
    return undefined;
  }

  // 30-day signed download URL.
  const signRes = await fetch(
    `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1/object/sign/${QVSP_PROOFS_BUCKET}/${encodeURIComponent(objectPath)}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ expiresIn: 60 * 60 * 24 * 30 }),
    }
  );
  if (!signRes.ok) {
    console.error(`[worker] supabase sign ${signRes.status}:`, await signRes.text().catch(() => ""));
    return undefined;
  }
  const signed = (await signRes.json()) as { signedURL?: string; signedUrl?: string };
  const token = signed.signedURL ?? signed.signedUrl ?? "";
  if (!token) return undefined;
  // Supabase returns "/object/sign/..." path; prefix with the base URL.
  return `${SUPABASE_URL.replace(/\/$/, "")}/storage/v1${token.startsWith("/") ? token : `/${token}`}`;
}

async function sendCallback(order_id: string, payload: Record<string, unknown>): Promise<void> {
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

function sleepReject(ms: number): Promise<VerifyFail> {
  return new Promise((resolve) =>
    setTimeout(() => resolve({ ok: false, reason: "extraction_timeout" }), ms)
  );
}

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`[worker] listening on :${PORT}`);
});
