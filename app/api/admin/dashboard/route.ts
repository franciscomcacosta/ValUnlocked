// GET /api/admin/dashboard → headline numbers for the admin Overview tab.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";
import { getBalance } from "@/lib/qvsp";
import { pageAll, paidCents } from "@/lib/admin";

type OrderRow = { status: string; credit_used_cents: number | null; charge_cents: number | null; created_at: string; fulfilled_at: string | null };

export async function GET(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;

  const now = Date.now();
  const dayAgo = new Date(now - 86_400_000).toISOString();
  const weekAgo = new Date(now - 7 * 86_400_000).toISOString();
  const monthAgo = new Date(now - 30 * 86_400_000).toISOString();

  try {
    const [orders, users, subs, stock, lastSync, openClaims, stuck, topups, qvsp] = await Promise.all([
      pageAll<OrderRow>((a, b) =>
        db.from("orders").select("status, credit_used_cents, charge_cents, created_at, fulfilled_at").range(a, b)
      ),
      pageAll<{ credit_cents: number; created_at: string }>((a, b) =>
        db.from("users").select("credit_cents, created_at").range(a, b)
      ),
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
      getBalance().catch(() => null),
    ]);

    const fulfilled = orders.filter((o) => o.status === "fulfilled");
    const sumSince = (iso: string) =>
      fulfilled.filter((o) => (o.fulfilled_at ?? o.created_at) >= iso).reduce((s, o) => s + paidCents(o), 0);

    const byStatus: Record<string, number> = {};
    for (const o of orders) byStatus[o.status] = (byStatus[o.status] ?? 0) + 1;

    const tiers: Record<string, number> = { standard: 0, premium: 0, ultra: 0 };
    for (const s of subs.data ?? []) tiers[s.tier as string] = (tiers[s.tier as string] ?? 0) + 1;

    const stockByRegion: Record<string, number> = {};
    for (const r of stock) stockByRegion[r.region] = (stockByRegion[r.region] ?? 0) + 1;

    return Response.json(
      {
        ok: true,
        revenue: {
          day: sumSince(dayAgo),
          week: sumSince(weekAgo),
          month: sumSince(monthAgo),
          all: fulfilled.reduce((s, o) => s + paidCents(o), 0),
        },
        topupsMonthCents: (topups.data ?? []).reduce((s, t) => s + ((t.pay_cents as number) ?? 0), 0),
        orders: {
          total: orders.length,
          day: orders.filter((o) => o.created_at >= dayAgo).length,
          fulfilled: fulfilled.length,
          byStatus,
        },
        users: {
          total: users.length,
          newWeek: users.filter((u) => u.created_at >= weekAgo).length,
          creditOutstandingCents: users.reduce((s, u) => s + (u.credit_cents ?? 0), 0),
        },
        subs: { total: (subs.data ?? []).length, tiers },
        stock: { total: stock.length, byRegion: stockByRegion, lastSyncAt: (lastSync.data?.last_synced_at as string | undefined) ?? null },
        attention: { openClaims: openClaims.count ?? 0, stuckOrders: stuck.count ?? 0 },
        qvspBalance: qvsp ? { cents: qvsp.cents, currency: qvsp.currency } : null,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (e) {
    return Response.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
