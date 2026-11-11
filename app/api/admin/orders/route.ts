// Admin: browse and act on orders.
//
// GET  /api/admin/orders?status=<status|stuck|all>&q=<VU-xxxx / order id / username>
// POST /api/admin/orders { action, orderId, ... }
//   action "refund": { amount_eur?, reason?, dm? }  → credit back (default: what they paid), order → refunded_credit
//   action "retry":  {}                             → re-run delivery for a paid order with no account yet
//   action "cancel": {}                             → cancel an unpaid order, return any credit it reserved
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";
import { notifyDiscordUser, logToStaff } from "@/lib/discord";
import { fulfilOrder } from "@/lib/fulfil";
import { changeCredit, eur, paidCents } from "@/lib/admin";

const SELECT =
  "id, status, price_cents, credit_used_cents, charge_cents, pay_currency, created_at, paid_at, fulfilled_at, inventory_id, user_id, users(discord_id, discord_username), products(name)";

export async function GET(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") ?? "all";
  const q = (url.searchParams.get("q") ?? "").trim().toLowerCase().replace(/^vu-/, "");

  let query = db.from("orders").select(SELECT).order("created_at", { ascending: false }).limit(q ? 500 : 80);
  if (status === "stuck") query = query.eq("status", "paid").is("inventory_id", null);
  else if (status !== "all") query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  let rows = data ?? [];
  if (q) {
    rows = rows.filter((o) => {
      const u = o.users as unknown as { discord_username?: string; discord_id?: string } | null;
      return (
        (o.id as string).toLowerCase().startsWith(q) ||
        (u?.discord_username ?? "").toLowerCase().includes(q) ||
        u?.discord_id === q
      );
    });
  }
  return Response.json({ ok: true, orders: rows.slice(0, 80) }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const admin = auth.name;
  const b = (await req.json().catch(() => ({}))) as {
    action?: string;
    orderId?: string;
    amount_eur?: number | string;
    reason?: string;
    dm?: boolean;
  };
  if (!b.orderId) return Response.json({ error: "orderId required" }, { status: 400 });

  const { data: order } = await db
    .from("orders")
    .select("id, status, user_id, inventory_id, credit_used_cents, charge_cents, users(discord_id)")
    .eq("id", b.orderId)
    .maybeSingle();
  if (!order) return Response.json({ error: "Order not found." }, { status: 404 });
  const did = (order.users as unknown as { discord_id?: string } | null)?.discord_id ?? null;
  const ref = `VU-${(order.id as string).slice(0, 8).toUpperCase()}`;

  try {
    // ── Refund to store credit ──────────────────────────────────────────
    if (b.action === "refund") {
      if (order.status === "refunded_credit") return Response.json({ error: `${ref} was already refunded.` }, { status: 409 });
      if (!["fulfilled", "paid", "partially_paid", "failed"].includes(order.status as string)) {
        return Response.json({ error: `${ref} is "${order.status}" — only paid/delivered orders can be refunded.` }, { status: 409 });
      }
      const cents = b.amount_eur !== undefined && b.amount_eur !== "" ? Math.round(Number(b.amount_eur) * 100) : paidCents(order);
      if (!Number.isFinite(cents) || cents <= 0) return Response.json({ error: "Refund amount must be above €0." }, { status: 400 });

      // Flip the status first so two clicks can't refund twice.
      const { data: flipped } = await db
        .from("orders")
        .update({ status: "refunded_credit" })
        .eq("id", order.id)
        .eq("status", order.status)
        .select("id");
      if (!flipped?.length) return Response.json({ error: "Order changed while refunding — reload and try again." }, { status: 409 });

      const reason = (b.reason ?? "").trim();
      const { balance } = await changeCredit(
        order.user_id as string,
        cents,
        `admin_refund:${admin}${reason ? `: ${reason}` : ""}`,
        order.id as string
      );
      if (did && (b.dm ?? true)) {
        await notifyDiscordUser(
          did,
          `💛 Order ${ref} was refunded: **${eur(cents)}** is back in your Val Unlocked credit` +
            `${reason ? ` (${reason})` : ""}. Balance: **${eur(balance)}**.`
        ).catch(() => {});
      }
      await logToStaff(`💸 ${admin} refunded ${ref} — ${eur(cents)} to credit${reason ? ` (${reason})` : ""}.`);
      return Response.json({ ok: true, message: `Refunded ${eur(cents)} to credit. Their balance is now ${eur(balance)}.` });
    }

    // ── Retry delivery ──────────────────────────────────────────────────
    if (b.action === "retry") {
      if (order.status !== "paid" || order.inventory_id) {
        return Response.json({ error: `${ref} isn't waiting for delivery (status "${order.status}").` }, { status: 409 });
      }
      const { data: flipped } = await db
        .from("orders")
        .update({ status: "confirmed" })
        .eq("id", order.id)
        .eq("status", "paid")
        .select("id");
      if (!flipped?.length) return Response.json({ error: "Already being retried." }, { status: 409 });
      const delivered = await fulfilOrder(order.id as string).catch(() => false);
      const { data: now } = await db.from("orders").select("status").eq("id", order.id).single();
      return Response.json({
        ok: delivered,
        message: delivered ? `${ref} delivered.` : `Still not delivered (status "${now?.status}"). Check the staff log for why.`,
      });
    }

    // ── Cancel an unpaid order ──────────────────────────────────────────
    if (b.action === "cancel") {
      if (!["pending", "waiting"].includes(order.status as string)) {
        return Response.json({ error: `Only unpaid orders can be cancelled (${ref} is "${order.status}").` }, { status: 409 });
      }
      const { data: flipped } = await db
        .from("orders")
        .update({ status: "cancelled" })
        .eq("id", order.id)
        .in("status", ["pending", "waiting"])
        .select("id");
      if (!flipped?.length) return Response.json({ error: "Order changed — reload and try again." }, { status: 409 });
      // Give back any credit the order had set aside, and release a held account.
      const used = (order.credit_used_cents as number) ?? 0;
      if (used > 0) await changeCredit(order.user_id as string, used, "order_cancelled", order.id as string);
      await db.rpc("release_qvsp_stock", { p_order_id: order.id }).then(() => {}, () => {});
      await logToStaff(`🛑 ${admin} cancelled unpaid order ${ref}${used ? ` (returned ${eur(used)} credit)` : ""}.`);
      return Response.json({ ok: true, message: `Cancelled ${ref}${used ? ` and returned ${eur(used)} credit` : ""}.` });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
