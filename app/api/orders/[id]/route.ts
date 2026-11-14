export const dynamic = "force-dynamic";
import { db } from "@/lib/supabase";
import { decrypt } from "@/lib/crypto";
import { getSessionUserId } from "@/lib/session";
import { lookupRank, lookupSkinArt } from "@/lib/valorant-assets";
import { CLAIM_WINDOW_MS, claimWindowStart } from "@/lib/claims";

export const runtime = "nodejs";

// Order detail for /orders/[id] — the shape that page renders (status,
// credentials list, account facts, timeline), plus report/claim state.
// Only the buyer who placed the order can see it.

const STATUS_MAP: Record<string, string> = {
  fulfilled: "delivered",
  failed: "failed",
  cancelled: "failed",
  expired: "failed",
  refunded_credit: "refunded",
  paid: "reserved",
  reserved: "reserved",
};

const TIER_NAME: Record<string, string> = { standard: "Standard", premium: "Premium", ultra: "Ultra" };
const titleCase = (s: string) => s.replace(/\b\w/g, (c) => c.toUpperCase());

function relative(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const d = Math.floor((Date.now() - t) / 86_400_000);
  if (d < 1) return "today";
  return d === 1 ? "1 day ago" : `${d} days ago`;
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const userId = await getSessionUserId(req);
  if (!userId) return Response.json({ error: "login_required" }, { status: 401 });

  const { id } = await ctx.params;
  const { data: order } = await db
    .from("orders")
    .select("id, user_id, status, price_cents, credit_used_cents, charge_cents, currency, created_at, paid_at, fulfilled_at, inventory_id, np_invoice_id, products(name, region, rank)")
    .eq("id", id)
    .single();
  if (!order || order.user_id !== userId) return Response.json({ error: "not_found" }, { status: 404 });

  const product = order.products as unknown as { name: string; region: string | null; rank: string | null } | null;

  const [{ data: stock }, { data: sub }, claimsRes] = await Promise.all([
    db
      .from("qvsp_stock")
      .select("region, level, peak, rank_normalized, skin_count, skins, vp, last_played")
      .or(`claimed_order_id.eq.${order.id},reserved_order_id.eq.${order.id}`)
      .maybeSingle(),
    db.from("subscriptions").select("tier").eq("user_id", userId).in("status", ["active", "grace"]).maybeSingle(),
    db
      .from("replacement_claims")
      .select("id, reason, status, outcome_note, refund_cents, bonus_cents, created_at, resolved_at")
      .eq("order_id", order.id)
      .order("created_at", { ascending: false }),
  ]);

  const status = STATUS_MAP[order.status as string] ?? "pending";
  const delivered = status === "delivered";

  let credentials: Array<{ key: string; value: string }> | null = null;
  if (delivered && order.inventory_id) {
    const { data: inv } = await db
      .from("inventory")
      .select("login_enc, password_enc, email_enc, email_password_enc")
      .eq("id", order.inventory_id)
      .single();
    if (inv) {
      credentials = [
        { key: "Username", value: decrypt(inv.login_enc) },
        { key: "Password", value: decrypt(inv.password_enc) },
        // Empty until the email has been fetched — the page shows
        // "Getting email…" for these and fills them in when they arrive.
        { key: "Email", value: decrypt(inv.email_enc) || "" },
        { key: "Email password", value: decrypt(inv.email_password_enc) || "" },
      ];
    }
  }

  const rankRaw = (stock?.rank_normalized as string | null) ?? product?.rank ?? null;
  const rankArt = rankRaw ? await lookupRank(rankRaw).then((r) => (r.icon ? r : lookupRank(`${rankRaw} 1`))) : null;
  const rankName = rankArt?.canonicalName ?? (rankRaw ? titleCase(rankRaw) : null);
  const skins = ((stock?.skins as string[] | null) ?? []).filter(Boolean);
  // Every skin (capped) with its art, best tier first, for the inventory grid.
  const preview = await Promise.all(
    skins.slice(0, 60).map(async (n) => {
      const a = await lookupSkinArt(n.replace(/\s*\(.*\)\s*$/, ""));
      const parts = n.split(" ");
      return {
        name: parts.slice(0, -1).join(" ") || n,
        weapon: parts[parts.length - 1] ?? "",
        tier: (a.tierName === "Select" || a.tierName === "Deluxe" ? "Standard" : a.tierName ?? "Standard") as string,
        img: a.icon,
      };
    })
  );

  const fulfilledAt = order.fulfilled_at as string | null;
  const windowEndsAt = fulfilledAt
    ? new Date((await claimWindowStart(order.id as string, fulfilledAt)) + CLAIM_WINDOW_MS).toISOString()
    : null;

  return Response.json(
    {
      id: order.id,
      display_id: `VU-${String(order.id).slice(0, 8).toUpperCase()}`,
      status,
      bracket_label: product?.name ?? null,
      region: (stock?.region as string | null) ?? product?.region ?? null,
      rank: rankName,
      rank_tier: rankName ? rankName.split(" ")[0] : null,
      rank_icon: rankArt?.icon ?? null,
      peak_rank: stock?.peak ? titleCase(stock.peak as string) : null,
      last_played_relative: /^\d{4}-/.test(String(stock?.last_played ?? "")) ? relative(stock?.last_played as string) : (stock?.last_played as string | null) ?? null,
      delivered_at: fulfilledAt,
      // Paid = credit + crypto (after sub discount); original = list price.
      price_paid_cents: ((order.credit_used_cents as number) ?? 0) + ((order.charge_cents as number) ?? 0),
      price_original_cents:
        (order.price_cents as number) > ((order.credit_used_cents as number) ?? 0) + ((order.charge_cents as number) ?? 0)
          ? order.price_cents
          : null,
      sub_tier: sub?.tier ? TIER_NAME[sub.tier as string] ?? null : null,
      payment_method: (order.charge_cents as number) === 0 ? "credit" : "crypto",
      level: (stock?.level as number | null) ?? null,
      skin_count: (stock?.skin_count as number | null) ?? (skins.length || null),
      agent_count: null,
      agents_total: null,
      vp: (stock?.vp as number | null) ?? null,
      email_verified: false,
      credentials,
      skins_preview: preview,
      skins_total: skins.length,
      agents: [],
      timeline: [
        { label: "Order placed", at: order.created_at, done: true },
        { label: "Payment confirmed", at: order.paid_at ?? null, done: !!order.paid_at },
        { label: "Account delivered", at: fulfilledAt, done: delivered },
      ],
      // Report-a-problem state
      claim_window_ends_at: windowEndsAt,
      claims: claimsRes.error ? [] : claimsRes.data ?? [],
      created_at: order.created_at,
      // Unpaid orders: where to finish paying, and when the hold runs out.
      pay_url:
        ["pending", "waiting"].includes(order.status as string) && order.np_invoice_id
          ? `https://nowpayments.io/payment/?iid=${order.np_invoice_id}`
          : null,
      hold_ends_at: ["pending", "waiting"].includes(order.status as string)
        ? new Date(new Date(order.created_at as string).getTime() + 3 * 3_600_000).toISOString()
        : null,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
