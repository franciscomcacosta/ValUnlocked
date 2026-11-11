// Scheduled jobs. The bot runs 24/7 on Fly, so it's the shop's clock:
// it calls the site's cron endpoints on a timer (Vercel's free plan only
// allows daily crons). Every endpoint is safe to run repeatedly.
//
// Needs CRON_SECRET (same value as on Vercel) in the bot's Fly secrets.
import { BASE_URL } from "./base-url";
import { logToStaff } from "../lib/discord";

type Job = { path: string; everyMin: number; offsetSec: number };

const JOBS: Job[] = [
  { path: "/api/cron/ops", everyMin: 1, offsetSec: 5 },      // balance, watcher health, reminders, vouches
  { path: "/api/cron/claims", everyMin: 5, offsetSec: 20 },  // qvsp ticket sync + stuck-order retries
  { path: "/api/cron/expire", everyMin: 10, offsetSec: 35 }, // release unpaid orders after 3 h
  { path: "/api/cron/subs", everyMin: 30, offsetSec: 50 },   // renewal reminders, grace, expiry
];

const failures = new Map<string, number>();
const ALERT_AFTER = 3;

async function run(job: Job) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return;
  let problem: string | null = null;
  try {
    const res = await fetch(`${BASE_URL}${job.path}`, {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(90_000),
    });
    if (!res.ok) problem = `HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 120)}`;
  } catch (e) {
    problem = String(e).slice(0, 120);
  }

  const n = failures.get(job.path) ?? 0;
  if (problem) {
    failures.set(job.path, n + 1);
    console.warn(`[scheduler] ${job.path} failed (${n + 1}x): ${problem}`);
    if (n + 1 === ALERT_AFTER) {
      await logToStaff(`⚠️ Scheduled job \`${job.path}\` has failed ${ALERT_AFTER} times in a row: ${problem}`).catch(() => {});
    }
  } else {
    if (n >= ALERT_AFTER) await logToStaff(`✅ Scheduled job \`${job.path}\` is working again.`).catch(() => {});
    failures.set(job.path, 0);
  }
}

export function startScheduler() {
  if (!process.env.CRON_SECRET) {
    console.warn("[scheduler] CRON_SECRET not set — scheduled jobs are OFF. Set it with: fly secrets set CRON_SECRET=… -a valo-shop-bot");
    return;
  }
  for (const job of JOBS) {
    const running = { busy: false };
    const tick = async () => {
      if (running.busy) return; // previous run still going — skip, don't stack
      running.busy = true;
      try { await run(job); } finally { running.busy = false; }
    };
    setTimeout(() => {
      void tick();
      setInterval(() => void tick(), job.everyMin * 60_000);
    }, job.offsetSec * 1000);
  }
  console.log(`[scheduler] ${JOBS.length} jobs scheduled against ${BASE_URL}`);
}
