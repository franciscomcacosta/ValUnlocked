// GET /api/admin/referrals → referral totals, top inviters, recent sign-ups.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";
import { pageAll } from "@/lib/admin";
import { REFERRAL_FRIEND_CENTS, REFERRAL_MIN_ORDER_CENTS, REFERRAL_REWARD_CENTS } from "@/lib/referrals";

type Row = { id: string; discord_username: string | null; referred_by: string; referred_at: string | null; referral_rewarded_at: string | null };

export async function GET(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;

  try {
    const [referred, ledger] = await Promise.all([
      pageAll<Row>((a, b) =>
        db
          .from("users")
          .select("id, discord_username, referred_by, referred_at, referral_rewarded_at")
          .not("referred_by", "is", null)
          .order("referred_at", { ascending: false })
          .range(a, b)
      ),
      pageAll<{ delta_cents: number; reason: string }>((a, b) =>
        db.from("credit_ledger").select("delta_cents, reason").in("reason", ["referral", "referral_welcome"]).range(a, b)
      ),
    ]);

    // Per-inviter tallies.
    const by = new Map<string, { invited: number; bought: number }>();
    for (const r of referred) {
      const t = by.get(r.referred_by) ?? { invited: 0, bought: 0 };
      t.invited++;
      if (r.referral_rewarded_at) t.bought++;
      by.set(r.referred_by, t);
    }
    const topIds = [...by.entries()].sort((a, b) => b[1].bought - a[1].bought || b[1].invited - a[1].invited).slice(0, 25).map(([id]) => id);
    const nameIds = [...new Set([...topIds, ...referred.slice(0, 40).map((r) => r.referred_by)])];
    const { data: names } = nameIds.length
      ? await db.from("users").select("id, discord_username, discord_id").in("id", nameIds)
      : { data: [] };
    const nameOf = new Map((names ?? []).map((n) => [n.id as string, (n.discord_username as string | null) ?? (n.discord_id as string)]));

    return Response.json(
      {
        ok: true,
        settings: { rewardCents: REFERRAL_REWARD_CENTS, friendCents: REFERRAL_FRIEND_CENTS, minOrderCents: REFERRAL_MIN_ORDER_CENTS },
        totals: {
          invited: referred.length,
          bought: referred.filter((r) => r.referral_rewarded_at).length,
          inviters: by.size,
          creditPaidCents: ledger.reduce((s, l) => s + (l.delta_cents ?? 0), 0),
        },
        top: topIds.map((id) => ({ id, name: nameOf.get(id) ?? id, ...by.get(id)! })),
        recent: referred.slice(0, 40).map((r) => ({
          id: r.id,
          name: r.discord_username,
          invitedBy: nameOf.get(r.referred_by) ?? r.referred_by,
          invitedById: r.referred_by,
          joinedAt: r.referred_at,
          boughtAt: r.referral_rewarded_at,
        })),
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return Response.json({ error: `Referrals aren't set up yet — run migration 008. (${String(e).slice(0, 120)})` }, { status: 503 });
  }
}
