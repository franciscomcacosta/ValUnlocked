// GET /api/cron/claims  (Bearer CRON_SECRET) — every ~5 min from cron-job.org.
// Fallback for missed qvsp webhooks: re-syncs every open claim.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { syncOpenClaims } from "@/lib/claims";
import { retryStuckOrders } from "@/lib/retry-stuck";

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    const tally = await syncOpenClaims();
    // Also auto-retry deliveries that failed in the last 30 min (temporary
    // qvsp errors). Older ones wait for the Admin tab "Retry" button so a
    // lasting problem (e.g. low balance) doesn't spam staff-log forever.
    const retried = await retryStuckOrders({ maxAgeMinutes: 30, limit: 10 }).catch(() => []);
    return Response.json({ ok: true, tally, retried });
  } catch (e) {
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
}
