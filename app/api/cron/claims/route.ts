// GET /api/cron/claims  (Bearer CRON_SECRET) — every ~5 min from cron-job.org.
// Fallback for missed qvsp webhooks: re-syncs every open claim.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { syncOpenClaims } from "@/lib/claims";

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  try {
    const tally = await syncOpenClaims();
    return Response.json({ ok: true, tally });
  } catch (e) {
    return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
  }
}
