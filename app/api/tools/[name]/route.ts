// GET /api/tools/:name
// Returns the tool payload if the signed-in user's subscription tier meets
// the tool's minimum. Returns 403 otherwise (don't 404 to non-subs; 404
// would leak that the name doesn't exist either way).
import { getTool, tierMeets } from "@/lib/tools";
import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import type { SubTier } from "@/lib/pricing";

export const runtime = "nodejs";

export async function GET(req: Request, { params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  // Look up the user's active (or grace) sub tier.
  const { data: sub } = await db
    .from("subscriptions")
    .select("tier")
    .eq("user_id", session.uid)
    .in("status", ["active", "grace"])
    .maybeSingle();
  const tier = (sub?.tier ?? null) as SubTier | null;

  const tool = await getTool(name);
  if (!tool) return Response.json({ error: "not_found" }, { status: 404 });
  if (!tierMeets(tier, tool.min_tier)) {
    return Response.json(
      { error: "tier_required", required: tool.min_tier, current: tier },
      { status: 403 }
    );
  }
  return Response.json({ ok: true, tool });
}
