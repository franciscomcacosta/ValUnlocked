import { db } from "@/lib/supabase";
import { sessionFromRequest, isAdmin, avatarUrl } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "login_required" }, { status: 401 });

  const [{ data: user }, { data: sub }] = await Promise.all([
    db.from("users").select("credit_cents").eq("id", s.uid).single(),
    db
      .from("subscriptions")
      .select("tier, status, period_end, grace_until")
      .eq("user_id", s.uid)
      .in("status", ["active", "grace"])
      .maybeSingle(),
  ]);

  return Response.json(
    {
      name: s.name,
      avatar: avatarUrl(s),
      creditCents: user?.credit_cents ?? 0,
      isAdmin: isAdmin(s),
      sub: sub
        ? {
            tier: sub.tier,
            status: sub.status,
            periodEnd: sub.period_end,
            graceUntil: sub.grace_until,
          }
        : null,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
