// GET /api/admin/dashboard → headline numbers for the admin Overview tab:
// revenue, profit (what buyers paid minus what qvsp charged us), margins per
// skin range, members, credit owed, stock, watcher health, ratings, and the
// sales-pause switch.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";
import { getBalance } from "@/lib/qvsp";
import { SKIN_BRACKETS } from "@/lib/pricing";
import { pageAll, paidCents, ordersMissingEmail } from "@/lib/admin";
import { getSalesPause } from "@/lib/shop-flags";

type OrderRow = {
  id: string;
  status: string;
  credit_used_cents: number | null;
  charge_cents: number | null;
  created_at: string;
  fulfilled_at: string | null;
};
type CostRow = { claimed_order_id: string; qvsp_price_cents: number; skin_count: number | null };

const bracketOf = (n: number) => SKIN_BRACKETS.find((b) => n >= b.minSkins && n <= b.maxSkins) ?? SKIN_BRACKETS[0];

export async function GET(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;

  const now = Date.now();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
  const monthAgo = new Date(now - 30 * 86_400_000).toISOString();

  try {
    const [orders, costs, users, subs, stock, lastSync, openClaims, stuck, topups, subPaid, qvsp, watcherBeat, vouches, pause, missingEmails] =
      await Promise.all([
        pageAll<OrderRow>((a, b) =>
          db.from("orders").select("id, status, credit_used_cents, charge_cents, created_at, fulfilled_at").range(a, b)
        ),
        pageAll<CostRow>((a, b) =>
          db
            .from("qvsp_stock")
            .select("claimed_order_id, qvsp_price_cents, skin_count")
            .eq("claimed", true)
            .not("claimed_order_id", "is", null)
            .range(a, b)
        ),
        pageAll<{ credit_cents: number; created_at: string }>((a, b) => db.from("users").select("credit_cents, created_at").range(a, b)),
        db.from("subscriptions").select("tier").in("status", ["active", "grace"]),
        pageAll<{ region: string }>((a, b) =>
          db
            .from("qvsp_stock")
            .select("region")
            .eq("kind", "skinned")
            .is("removed_at", null)
            .eq("claimed", false)
            .is("reserved_order_id", null)
            .range(a, b)
        ),
        db.from("qvsp_stock").select("last_synced_at").order("last_synced_at", { ascending: false }).limit(1).maybeSingle(),
        db.from("replacement_claims").select("id", { count: "exact", head: true }).in("status", ["submitted", "under_review"]),
        db.from("orders").select("id", { count: "exact", head: true }).eq("status", "paid").is("inventory_id", null),
        db.from("topup_invoices").select("pay_cents, credited_at").not("credited_at", "is", null).gte("credited_at", monthAgo),
        db.from("sub_invoices").select("amount_cents").not("paid_at", "is", null).gte("paid_at", monthAgo),
        getBalance().catch(() => null),
        db.from("service_heartbeats").select("beat_at").eq("name", "watcher").maybeSingle(),
        db.from("vouches").select("stars, created_at"),
        getSalesPause(),
        ordersMissingEmail(100).catch(() => []),
      ]);

    // ── revenue ────────────────────────────────────────────────────────
    const fulfilled = orders.filter((o) => o.status === "fulfilled");
    const sumSince = (iso: string) =>
      fulfilled.filter((o) => (o.fulfilled_at ?? o.created_at) >= iso).reduce((s, o) => s + paidCents(o), 0);

    // ── profit: per order that we actually bought from qvsp ───────────
    // Delivered orders earn what the buyer paid; orders later refunded to
    // credit earn nothing but still cost us the account. Free gifts are
    // tracked separately as giveaway cost.
    const costOf = new Map(costs.map((c) => [c.claimed_order_id, c]));
    const profit = { day: 0, week: 0, month: 0, all: 0 };
    let giftCostMonth = 0;
    let refundedLossMonth = 0;
    const byBracket = new Map<string, { label: string; sold: number; revenue: number; cost: number }>();
    for (const o of orders) {
      const c = costOf.get(o.id);
      if (!c) continue;
      const when = o.fulfilled_at ?? o.created_at;
      const paid = paidCents(o);
      if (paid === 0) {
        if (when >= monthAgo) giftCostMonth += c.qvsp_price_cents;
        continue;
      }
      const revenue = o.status === "fulfilled" ? paid : 0;
      const p = revenue - c.qvsp_price_cents;
      profit.all += p;
      if (when >= monthAgo) {
        profit.month += p;
        if (o.status === "refunded_credit") refundedLossMonth += c.qvsp_price_cents;
        const b = bracketOf(c.skin_count ?? 0);
        const t = byBracket.get(b.name) ?? { label: b.label, sold: 0, revenue: 0, cost: 0 };
        t.sold++;
        t.revenue += revenue;
        t.cost += c.qvsp_price_cents;
        byBracket.set(b.name, t);
      }
      if (when >= weekAgo) profit.week += p;
      if (when >= dayAgo) profit.day += p;
    }

    const byStatus: Record<string, number> = {};
    for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

    const tiers: Record<string, number> = { standard: 0, premium: 0, ultra: 0 };
    for (const s of subs.data ?? []) tiers[s.tier as string] = (tiers[s.tier as string] ?? 0) + 1;

    const stockByRegion: Record<string, number> = {};
    for (const r of stock) stockByRegion[r.region] = (stockByRegion[r.region] ?? 0) + 1;

    const watcherSeenAt =
      (watcherBeat.error ? null : (watcherBeat.data?.beat_at as string | undefined)) ??
      (lastSync.data?.last_synced_at as string | undefined) ??
      null;

    const ratings = vouches.error ? [] : vouches.data ?? [];
    const recentRatings = ratings.filter((v) => (v.created_at as string) >= monthAgo);
    const avg = (list: typeof ratings) => (list.length ? list.reduce((s, v) => s + (v.stars as number), 0) / list.length : null);

    return Response.json(
      {
        ok: true,
        revenue: { day: sumSince(dayAgo), week: sumSince(weekAgo), month: sumSince(monthAgo), all: fulfilled.reduce((s, o) => s + paidCents(o), 0) },
        profit,
        giftCostMonthCents: giftCostMonth,
        refundedLossMonthCents: refundedLossMonth,
        membershipMonthCents: (subPaid.data ?? []).reduce((s, r) => s + ((r.amount_cents as number) ?? 0), 0),
        margins: [...byBracket.entries()]
          .sort((a, b) => SKIN_BRACKETS.findIndex((x) => x.name === a[0]) - SKIN_BRACKETS.findIndex((x) => x.name === b[0]))
          .map(([name, t]) => ({ name, ...t, profit: t.revenue - t.cost })),
        topupsMonthCents: (topups.data ?? []).reduce((s, t) => s + ((t.pay_cents as number) ?? 0), 0),
        orders: { total: orders.length, day: orders.filter((o) => o.created_at >= dayAgo).length, fulfilled: fulfilled.length, byStatus },
        users: {
          total: users.length,
          newWeek: users.filter((u) => u.created_at >= weekAgo).length,
          creditOutstandingCents: users.reduce((s, u) => s + (u.credit_cents ?? 0), 0),
        },
        subs: { total: (subs.data ?? []).length, tiers },
        stock: { total: stock.length, byRegion: stockByRegion, lastSyncAt: watcherSeenAt },
        attention: { openClaims: openClaims.count ?? 0, stuckOrders: stuck.count ?? 0, emailsNeeded: missingEmails.length },
        qvspBalance: qvsp ? { cents: qvsp.cents, currency: qvsp.currency } : null,
        ratings: { count: ratings.length, avg: avg(ratings), monthCount: recentRatings.length, monthAvg: avg(recentRatings) },
        salesPause: pause,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
