// POST /api/sub/cancel
// Marks the user's active sub as cancelled. Role + perks remain until
// period_end (they paid for the month). From period_end onwards the sub
// cron treats a cancelled sub as 'expired' immediately (no grace).
import { sessionFromRequest } from "@/lib/session";
import { getActiveSub, cancelSubscription } from "@/lib/subs";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  const sub = await getActiveSub(session.uid);
  if (!sub) return Response.json({ error: "no_active_subscription" }, { status: 404 });

  await cancelSubscription(sub.id);
  return Response.json({ ok: true, periodEnd: sub.period_end });
}
