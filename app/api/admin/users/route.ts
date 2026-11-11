// Admin: find buyers and manage them.
//
// GET  /api/admin/users?q=<name or discord id>   → up to 25 matches (newest first if q is empty)
// GET  /api/admin/users?id=<user uuid>           → full profile: plan, orders, credit history, claims
// POST /api/admin/users  { action, userId, ... }
//   action "credit": { amount_eur (+ adds, − removes), reason?, dm? }
//   action "plan":   { tier: standard|premium|ultra|remove, days?, dm? }
//   action "dm":     { message }
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";
import { notifyDiscordUser, logToStaff, setTierRole, clearTierRoles } from "@/lib/discord";
import { tierLabel, type SubTier } from "@/lib/pricing";
import { ADMIN_TIERS, applyPlan, changeCredit, claimRates, eur, findUser, paidCents, removePlan } from "@/lib/admin";
import { creditChangedMessage, planGrantedMessage, staffMessage } from "@/lib/discord-messages";

const base = () => process.env.PUBLIC_BASE_URL ?? "https://valunlock.online";

export async function GET(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const url = new URL(req.url);
  const id = url.searchParams.get("id");

  if (id) {
    const user = await findUser({ userId: id });
    if (!user) return Response.json({ error: "not_found" }, { status: 404 });
    const [sub, orders, ledger, claims, refRow, invited] = await Promise.all([
      db
        .from("subscriptions")
        .select("tier, status, period_end, grace_until, created_at")
        .eq("user_id", id)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      db
        .from("orders")
        .select("id, status, price_cents, credit_used_cents, charge_cents, created_at, fulfilled_at, products(name)")
        .eq("user_id", id)
        .order("created_at", { ascending: false })
        .limit(30),
      db
        .from("credit_ledger")
        .select("id, delta_cents, reason, order_id, created_at")
        .eq("user_id", id)
        .order("created_at", { ascending: false })
        .limit(30),
      db
        .from("replacement_claims")
        .select("id, order_id, reason, status, forward_error, created_at")
        .eq("user_id", id)
        .order("created_at", { ascending: false })
        .limit(10),
      // Referral columns come from migration 008; errors just mean "not set up yet".
      db.from("users").select("referral_code, referred_by, referral_rewarded_at").eq("id", id).maybeSingle(),
      db.from("users").select("id", { count: "exact", head: true }).eq("referred_by", id),
    ]);
    const list = orders.data ?? [];
    const r = refRow.error ? null : refRow.data;
    const { data: referrer } = r?.referred_by
      ? await db.from("users").select("id, discord_username, discord_id").eq("id", r.referred_by as string).maybeSingle()
      : { data: null };
    return Response.json(
      {
        ok: true,
        user,
        sub: sub.data ?? null,
        orders: list,
        spentCents: list.filter((o) => o.status === "fulfilled").reduce((s, o) => s + paidCents(o), 0),
        ledger: ledger.data ?? [],
        claims: claims.data ?? [],
        claimRate: (await claimRates([id]).catch(() => new Map())).get(id) ?? null,
        referral: {
          code: (r?.referral_code as string | null) ?? null,
          invited: invited.error ? 0 : invited.count ?? 0,
          referredBy: referrer
            ? { id: referrer.id as string, name: (referrer.discord_username as string | null) ?? (referrer.discord_id as string) }
            : null,
          rewarded: !!r?.referral_rewarded_at,
        },
      },
      { headers: { "cache-control": "no-store" } }
    );
  }

  const q = (url.searchParams.get("q") ?? "").trim();
  let query = db
    .from("users")
    .select("id, discord_id, discord_username, credit_cents, created_at")
    .order("created_at", { ascending: false })
    .limit(25);
  if (q) {
    // Discord ids are all digits; anything else is a username search.
    query = /^\d{5,}$/.test(q) ? query.eq("discord_id", q) : query.ilike("discord_username", `%${q.replace(/[%_]/g, "")}%`);
  }
  const { data: users, error } = await query;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const ids = (users ?? []).map((u) => u.id as string);
  const { data: subs } = ids.length
    ? await db.from("subscriptions").select("user_id, tier").in("user_id", ids).in("status", ["active", "grace"])
    : { data: [] };
  const tierOf = new Map((subs ?? []).map((s) => [s.user_id as string, s.tier as string]));

  return Response.json(
    { ok: true, users: (users ?? []).map((u) => ({ ...u, tier: tierOf.get(u.id as string) ?? null })) },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function POST(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const admin = auth.name;

  const b = (await req.json().catch(() => ({}))) as {
    action?: string;
    userId?: string;
    discordId?: string;
    amount_eur?: number | string;
    reason?: string;
    dm?: boolean;
    tier?: string;
    days?: number | string;
    message?: string;
  };
  const user = await findUser({ userId: b.userId, discordId: b.discordId });
  if (!user) return Response.json({ error: "User not found (they need to have logged in to the shop once)." }, { status: 404 });
  const did = user.discord_id as string;
  const who = user.discord_username ? `@${user.discord_username}` : did;

  try {
    // ── Credit: add or remove ───────────────────────────────────────────
    if (b.action === "credit") {
      const cents = Math.round(Number(b.amount_eur) * 100);
      if (!Number.isFinite(cents) || cents === 0 || Math.abs(cents) > 100_000) {
        return Response.json({ error: "Enter an amount between -1000 and 1000 (not 0)." }, { status: 400 });
      }
      const reason = (b.reason ?? "").trim();
      const { delta, balance } = await changeCredit(user.id as string, cents, `admin:${admin}${reason ? `: ${reason}` : ""}`);
      if (delta === 0) return Response.json({ error: `${who} already has €0.00 — nothing to remove.` }, { status: 400 });

      const shouldDm = b.dm ?? delta > 0;
      if (shouldDm) {
        await notifyDiscordUser(did, creditChangedMessage({ deltaCents: delta, balanceCents: balance, reason: reason || null })).catch(() => {});
      }
      await logToStaff(
        `🛠️ ${admin} ${delta > 0 ? "added" : "removed"} ${eur(Math.abs(delta))} credit ${delta > 0 ? "to" : "from"} <@${did}>` +
          `${reason ? ` — ${reason}` : ""} · balance ${eur(balance)}`
      );
      const capped = cents < 0 && -cents > -delta;
      return Response.json({
        ok: true,
        message: `${delta > 0 ? "Added" : "Removed"} ${eur(Math.abs(delta))}${capped ? " (all they had)" : ""}. New balance ${eur(balance)}.`,
        balance,
      });
    }

    // ── Plan: give or remove ────────────────────────────────────────────
    if (b.action === "plan") {
      const shouldDm = b.dm ?? true;
      if (b.tier === "remove") {
        const removed = await removePlan(user.id as string);
        const roleNote = await clearTierRoles(did).then(() => "", (e: Error) => ` (role removal failed: ${e.message})`);
        await logToStaff(`🛠️ ${admin} removed the plan from <@${did}>`);
        return Response.json({
          ok: true,
          message: removed ? `Removed ${tierLabel(removed)} from ${who}.${roleNote}` : `${who} had no active plan.${roleNote}`,
        });
      }
      const tier = b.tier as SubTier;
      if (!ADMIN_TIERS.includes(tier)) return Response.json({ error: "Pick a plan." }, { status: 400 });
      const days = Math.round(Number(b.days ?? 30));
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        return Response.json({ error: "Days must be between 1 and 365." }, { status: 400 });
      }
      const { end, previousTier } = await applyPlan(user.id as string, tier, days);
      const roleNote = await setTierRole(did, tier).then(() => "", (e: Error) => ` Plan saved, but the Discord role failed: ${e.message}`);
      const ts = Math.floor(end.getTime() / 1000);
      if (shouldDm) {
        await notifyDiscordUser(did, planGrantedMessage({ tier, end })).catch(() => {});
      }
      await logToStaff(`🛠️ ${admin} granted **${tierLabel(tier)}** to <@${did}> until <t:${ts}:D>`);
      return Response.json({
        ok: true,
        message:
          `${tierLabel(tier)} active until ${end.toLocaleDateString("en-GB")}` +
          `${previousTier && previousTier !== tier ? ` (switched from ${tierLabel(previousTier)})` : ""}.${roleNote}`,
      });
    }

    // ── Direct message ──────────────────────────────────────────────────
    if (b.action === "dm") {
      const message = (b.message ?? "").trim();
      if (!message) return Response.json({ error: "Write a message first." }, { status: 400 });
      if (message.length > 1800) return Response.json({ error: "Keep it under 1800 characters." }, { status: 400 });
      await notifyDiscordUser(did, staffMessage({ text: message }));
      await logToStaff(`✉️ ${admin} DMed <@${did}>: ${message.slice(0, 300)}`);
      return Response.json({ ok: true, message: `Sent to ${who}.` });
    }

    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
