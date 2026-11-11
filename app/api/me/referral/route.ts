// GET /api/me/referral → the signed-in user's invite link + stats.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import {
  ensureReferralCode,
  referralLink,
  referralStats,
  REFERRAL_FRIEND_CENTS,
  REFERRAL_MIN_ORDER_CENTS,
  REFERRAL_REWARD_CENTS,
} from "@/lib/referrals";

export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "login_required" }, { status: 401 });
  try {
    const code = await ensureReferralCode(s.uid);
    const stats = await referralStats(s.uid);
    return Response.json(
      {
        ok: true,
        code,
        link: referralLink(code),
        rewardCents: REFERRAL_REWARD_CENTS,
        friendCents: REFERRAL_FRIEND_CENTS,
        minOrderCents: REFERRAL_MIN_ORDER_CENTS,
        ...stats,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    // Most likely: migration 008 hasn't been run yet.
    return Response.json({ error: "referrals_unavailable", detail: String(e) }, { status: 503 });
  }
}
