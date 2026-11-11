// GET /api/cron/ops  (Bearer CRON_SECRET) — every minute, called by the
// Discord bot's scheduler (bot/scheduler.ts). See lib/ops.ts.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { runOps } from "@/lib/ops";

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const result = await runOps();
  return Response.json({ ok: true, ...result });
}
