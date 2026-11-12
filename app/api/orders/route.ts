export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { db } from "@/lib/supabase";
import { getSessionUserId } from "@/lib/session";

// The signed-in buyer's orders for "My Purchases" (no credentials – those
// come from /api/orders/[id]). Each row carries a short account summary
// (region, skins, peak) and, for unpaid orders, the payment link.
export async function GET(req: Request) {
  const userId = await getSessionUserId(req);
  if (!userId) return Response.json({ error: "login_required" }, { status: 401 });
  const { data } = await db
    .from("orders")
    .select("id, status, price_cents, credit_used_cents, charge_cents, currency, created_at, fulfilled_at, np_invoice_id, products(name, region, rank)")
    .eq("user_id", userId)
    .not("status", "eq", "cancelled")
    .order("created_at", { ascending: false })
    .limit(50);
  const orders = data ?? [];

  const ids = orders.map((o) => o.id as string);
  const { data: accounts } = ids.length
    ? await db
        .from("qvsp_stock")
        .select("claimed_order_id, reserved_order_id, region, skin_count, peak, level")
        .or(`claimed_order_id.in.(${ids.join(",")}),reserved_order_id.in.(${ids.join(",")})`)
    : { data: [] };
  const acct = new Map<string, { region: string | null; skin_count: number | null; peak: string | null; level: number | null }>();
  for (const a of accounts ?? []) {
    const key = (a.claimed_order_id ?? a.reserved_order_id) as string;
    acct.set(key, { region: a.region as string | null, skin_count: a.skin_count as number | null, peak: a.peak as string | null, level: a.level as number | null });
  }

  const unpaid = new Set(["pending", "waiting"]);
  return Response.json(
    orders.map((o) => {
      const { np_invoice_id, ...rest } = o;
      return {
        ...rest,
        paid_cents: ((o.credit_used_cents as number) ?? 0) + ((o.charge_cents as number) ?? 0),
        account: acct.get(o.id as string) ?? null,
        pay_url: unpaid.has(o.status as string) && np_invoice_id ? `https://nowpayments.io/payment/?iid=${np_invoice_id}` : null,
      };
    }),
    { headers: { "cache-control": "no-store" } }
  );
}
