// Hourly subscription lifecycle cron.
// - Sends T-7 / T-3 / T-1 day renewal reminders (idempotent via flags).
// - Flips 'active' → 'grace' when period_end passes.
// - Flips 'grace' → 'expired' when grace_until passes (role revoked).
//
// Vercel cron entry: { "path": "/api/cron/subs", "schedule": "17 * * * *" }
// Protected by CRON_SECRET.
import { db } from "@/lib/supabase";
import { enterGrace, expireSubscription, sendRenewalReminder } from "@/lib/subs";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return runSubsCron();
}

export async function POST(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return runSubsCron();
}

async function runSubsCron() {
  const start = Date.now();
  const now = Date.now();
  const stats = { reminders_7d: 0, reminders_3d: 0, reminders_1d: 0, entered_grace: 0, expired: 0 };

  // Pull every active-or-grace sub. Cheap enough to scan — subs are low-volume
  // compared to orders, and we need to evaluate reminder windows on each.
  const { data: subs, error } = await db
    .from("subscriptions")
    .select("id, user_id, status, period_end, grace_until, reminded_7d, reminded_3d, reminded_1d")
    .in("status", ["active", "grace"]);
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  for (const s of subs ?? []) {
    const periodEnd = new Date(s.period_end).getTime();
    const graceUntil = s.grace_until ? new Date(s.grace_until).getTime() : periodEnd;
    const msToEnd = periodEnd - now;
    const DAY = 86400_000;

    // Terminal: past grace → expire.
    if (now >= graceUntil && s.status === "grace") {
      try {
        await expireSubscription(s.id);
        stats.expired++;
      } catch (e) {
        console.error(`[subs-cron] expire ${s.id} failed`, e);
      }
      continue;
    }

    // period_end passed, still active → enter grace.
    if (now >= periodEnd && s.status === "active") {
      try {
        await enterGrace(s.id);
        stats.entered_grace++;
      } catch (e) {
        console.error(`[subs-cron] grace ${s.id} failed`, e);
      }
      continue;
    }

    // Reminders. Fire the LATEST applicable one that hasn't fired yet.
    // (If cron missed days for some reason, we still only send the most
    // urgent — no bursts of 3 reminders at once.)
    if (s.status === "active" && msToEnd > 0) {
      if (msToEnd <= 1 * DAY && !s.reminded_1d) {
        try { await sendRenewalReminder(s.id, "1d"); stats.reminders_1d++; } catch (e) { console.error(e); }
      } else if (msToEnd <= 3 * DAY && !s.reminded_3d) {
        try { await sendRenewalReminder(s.id, "3d"); stats.reminders_3d++; } catch (e) { console.error(e); }
      } else if (msToEnd <= 7 * DAY && !s.reminded_7d) {
        try { await sendRenewalReminder(s.id, "7d"); stats.reminders_7d++; } catch (e) { console.error(e); }
      }
    }
  }

  const elapsed = Date.now() - start;
  console.log(`[subs-cron] ${JSON.stringify(stats)} in ${elapsed}ms`);
  return Response.json({ ok: true, ...stats, scanned: subs?.length ?? 0, elapsed_ms: elapsed });
}
