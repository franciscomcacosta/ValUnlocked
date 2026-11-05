// POST /api/sub/create { tier: "standard" | "premium" | "ultra" }
// Starts a new subscription for the signed-in user. Returns the NOWPayments
// invoice URL to redirect them to. The subscription only activates when the
// payment IPN comes back as finished.
import { sessionFromRequest } from "@/lib/session";
import { createSubscription } from "@/lib/subs";
import { db } from "@/lib/supabase";
import type { SubTier } from "@/lib/pricing";

export const runtime = "nodejs";

const VALID_TIERS: SubTier[] = ["standard", "premium", "ultra"];

export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { tier?: string } | null;
  const tier = body?.tier as SubTier | undefined;
  if (!tier || !VALID_TIERS.includes(tier)) {
    return Response.json({ error: "invalid_tier" }, { status: 400 });
  }

  // Confirm the user row exists (should — login creates it).
  const { data: user } = await db.from("users").select("id").eq("id", session.uid).maybeSingle();
  if (!user) return Response.json({ error: "user_not_found" }, { status: 404 });

  const res = await createSubscription({
    userId: session.uid,
    discordId: session.did,
    tier,
  });

  if (!res.ok) {
    const status = res.error === "already subscribed" ? 409 : 500;
    return Response.json({ error: res.error }, { status });
  }

  return Response.json({ ok: true, subscriptionId: res.subscriptionId, invoiceUrl: res.invoiceUrl });
}
