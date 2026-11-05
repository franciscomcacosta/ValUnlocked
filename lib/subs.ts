// Subscription lifecycle. NOWPayments doesn't support recurring charges,
// so we do it manually: one invoice per period, cron sends reminders,
// payment extends the period, cutoff + grace revokes the Discord role.
//
// Period math:
//   period_start → +30d period_end → +48h grace_until → role removed
//
// Reminders go out at T-7, T-3, T-1 days, all linking to the same (reusable)
// invoice URL so inboxes don't fill up with new links.
import { db } from "./supabase";
import { createInvoice } from "./nowpayments";
import { notifyDiscordUser, setTierRole, clearTierRoles, logToStaff } from "./discord";
import {
  SUB_PRICE_CENTS,
  SUB_PERIOD_DAYS,
  SUB_GRACE_HOURS,
  SUB_MONTHLY_CREDIT_CENTS,
  formatEur,
  tierLabel,
  type SubTier,
} from "./pricing";

type SubStatus = "active" | "grace" | "expired" | "cancelled";

export interface Subscription {
  id: string;
  user_id: string;
  tier: SubTier;
  status: SubStatus;
  period_start: string;
  period_end: string;
  grace_until: string | null;
  current_invoice_id: string | null;
  reminded_7d: boolean;
  reminded_3d: boolean;
  reminded_1d: boolean;
  cancelled_at: string | null;
}

/**
 * Get the user's current active-or-grace subscription, if any.
 */
export async function getActiveSub(userId: string): Promise<Subscription | null> {
  const { data } = await db
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .in("status", ["active", "grace"])
    .maybeSingle();
  return (data as Subscription) ?? null;
}

/**
 * Current effective tier for a user — null if no active/grace sub.
 */
export async function getUserTier(userId: string): Promise<SubTier | null> {
  const sub = await getActiveSub(userId);
  return sub?.tier ?? null;
}

/**
 * Start a new subscription. Creates a pending row + a NOWPayments invoice.
 * The sub becomes active only when the invoice is paid (IPN handler).
 * If the user already has an active sub for the same tier, refuses.
 * Upgrades/downgrades are handled by a separate flow (future PR).
 */
export async function createSubscription(opts: {
  userId: string;
  discordId: string;
  tier: SubTier;
}): Promise<{ ok: true; subscriptionId: string; invoiceUrl: string } | { ok: false; error: string }> {
  const existing = await getActiveSub(opts.userId);
  if (existing) {
    return { ok: false, error: `already subscribed to ${tierLabel(existing.tier)}` };
  }

  const now = new Date();
  const periodEnd = new Date(now.getTime() + SUB_PERIOD_DAYS * 86400_000);
  const graceUntil = new Date(periodEnd.getTime() + SUB_GRACE_HOURS * 3600_000);

  // Insert the subscription in a PRE-ACTIVE state: period_end set to now+1h
  // so an unpaid sub expires fast and we can clean it up. The IPN handler
  // bumps period_end to the real +30d when payment lands.
  const { data: sub, error: subErr } = await db
    .from("subscriptions")
    .insert({
      user_id: opts.userId,
      tier: opts.tier,
      status: "expired",       // flip to 'active' when paid
      period_start: now.toISOString(),
      period_end: new Date(now.getTime() + 3600_000).toISOString(),
      grace_until: graceUntil.toISOString(),
    })
    .select("id")
    .single();
  if (subErr || !sub) return { ok: false, error: subErr?.message ?? "db_error" };

  const amount = SUB_PRICE_CENTS[opts.tier];

  const { data: subInvoice, error: invErr } = await db
    .from("sub_invoices")
    .insert({
      subscription_id: sub.id,
      user_id: opts.userId,
      tier: opts.tier,
      amount_cents: amount,
      currency: "eur",
      purpose: "initial",
    })
    .select("id")
    .single();
  if (invErr || !subInvoice) return { ok: false, error: invErr?.message ?? "db_error" };

  try {
    // order_id prefix 'sub_' lets the IPN handler route this to sub_invoices
    // instead of looking in the orders table.
    const invoice = await createInvoice({
      orderId: `sub_${subInvoice.id}`,
      priceCents: amount,
      currency: "eur",
      description: `${tierLabel(opts.tier)} subscription — monthly`,
    });
    await db.from("sub_invoices").update({ np_invoice_id: invoice.id }).eq("id", subInvoice.id);
    await db.from("subscriptions").update({ current_invoice_id: invoice.id }).eq("id", sub.id);
    return { ok: true, subscriptionId: sub.id, invoiceUrl: invoice.invoice_url };
  } catch (e) {
    console.error("[subs] initial invoice failed", e);
    return { ok: false, error: "payment_provider_error" };
  }
}

/**
 * Generate a renewal invoice for an existing sub. Reuses the invoice URL
 * if one is already pending for this period so reminder DMs don't pile up
 * fresh links. Returns the invoice URL (new or existing) to DM to the user.
 */
export async function createRenewalInvoice(subscriptionId: string): Promise<{ ok: true; invoiceUrl: string } | { ok: false; error: string }> {
  const { data: sub } = await db
    .from("subscriptions")
    .select("*")
    .eq("id", subscriptionId)
    .single();
  if (!sub) return { ok: false, error: "not_found" };
  const typed = sub as Subscription;

  // If a renewal invoice is already open for this sub's current period and
  // unpaid, reuse its URL (we store the id, not the url — look it up).
  const { data: existing } = await db
    .from("sub_invoices")
    .select("id, np_invoice_id")
    .eq("subscription_id", typed.id)
    .eq("purpose", "renewal")
    .is("paid_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing?.np_invoice_id) {
    return { ok: true, invoiceUrl: `https://nowpayments.io/payment/?iid=${existing.np_invoice_id}` };
  }

  const amount = SUB_PRICE_CENTS[typed.tier];
  const { data: invRow, error } = await db
    .from("sub_invoices")
    .insert({
      subscription_id: typed.id,
      user_id: typed.user_id,
      tier: typed.tier,
      amount_cents: amount,
      currency: "eur",
      purpose: "renewal",
    })
    .select("id")
    .single();
  if (error || !invRow) return { ok: false, error: error?.message ?? "db_error" };

  try {
    const invoice = await createInvoice({
      orderId: `sub_${invRow.id}`,
      priceCents: amount,
      currency: "eur",
      description: `${tierLabel(typed.tier)} renewal — monthly`,
    });
    await db.from("sub_invoices").update({ np_invoice_id: invoice.id }).eq("id", invRow.id);
    await db.from("subscriptions").update({ current_invoice_id: invoice.id }).eq("id", typed.id);
    return { ok: true, invoiceUrl: invoice.invoice_url };
  } catch (e) {
    console.error("[subs] renewal invoice failed", e);
    return { ok: false, error: "payment_provider_error" };
  }
}

/**
 * Called by the IPN handler when a sub_invoice is paid. Activates the sub,
 * extends period_end, assigns the Discord role, DMs the user.
 */
export async function applyPaidSubInvoice(subInvoiceId: string): Promise<boolean> {
  const { data: inv } = await db
    .from("sub_invoices")
    .select("*, subscriptions(*), users(discord_id)")
    .eq("id", subInvoiceId)
    .single();
  if (!inv) return false;

  // Already applied? Idempotency.
  if (inv.paid_at) return false;

  const sub = inv.subscriptions as unknown as Subscription | null;
  const user = inv.users as unknown as { discord_id: string } | null;
  if (!sub) {
    console.error(`[subs] invoice ${subInvoiceId} has no subscription`);
    return false;
  }

  // Compute new period_end: extend from the LATER of (now, current period_end)
  // so paying early doesn't lose time, paying late doesn't retroactively credit.
  const now = Date.now();
  const currentEnd = new Date(sub.period_end).getTime();
  const baseline = Math.max(now, currentEnd);
  const newPeriodEnd = new Date(baseline + SUB_PERIOD_DAYS * 86400_000);
  const newGraceUntil = new Date(newPeriodEnd.getTime() + SUB_GRACE_HOURS * 3600_000);

  // Mark invoice paid.
  await db
    .from("sub_invoices")
    .update({ paid_at: new Date().toISOString(), np_status: "finished" })
    .eq("id", subInvoiceId);

  // Activate / extend the subscription. Reset reminder flags for the new cycle.
  await db
    .from("subscriptions")
    .update({
      status: "active",
      period_end: newPeriodEnd.toISOString(),
      grace_until: newGraceUntil.toISOString(),
      current_invoice_id: null,
      reminded_7d: false,
      reminded_3d: false,
      reminded_1d: false,
    })
    .eq("id", sub.id);

  // Grant monthly store credit for the new period. Zero-margin cost (we
  // already collected the sub fee) but huge perceived value. Granted on
  // every paid invoice — initial AND each renewal.
  const creditCents = SUB_MONTHLY_CREDIT_CENTS[inv.tier as SubTier] ?? 0;
  if (creditCents > 0) {
    await db.rpc("add_credit", {
      p_user_id: sub.user_id,
      p_cents: creditCents,
      p_reason: `sub_monthly_${inv.tier}`,
      p_order_id: null,
    }).catch((e) => console.error("[subs] monthly credit grant failed", e));
  }

  // Grant the tier role.
  if (user?.discord_id) {
    await setTierRole(user.discord_id, inv.tier as SubTier).catch((e) =>
      console.error(`[subs] setTierRole failed for ${user.discord_id}`, e)
    );
    await notifyDiscordUser(
      user.discord_id,
      `✅ Your **${tierLabel(inv.tier as SubTier)}** subscription is active until <t:${Math.floor(newPeriodEnd.getTime() / 1000)}:D>.\n` +
        (creditCents > 0 ? `**${formatEur(creditCents)}** monthly store credit added — applied automatically on your next purchase.\n` : "") +
        `New perks unlocked in the Discord.`
    ).catch((e) => console.error("[subs] DM failed", e));
  }

  await logToStaff(
    `💎 ${inv.purpose === "initial" ? "NEW" : "RENEWED"} **${tierLabel(inv.tier as SubTier)}** · ${formatEur(inv.amount_cents)}` +
      (creditCents > 0 ? ` (+${formatEur(creditCents)} credit)` : "") +
      ` · user ${sub.user_id}`
  );

  return true;
}

/**
 * Cancel a subscription (user-initiated). Keeps the role until period_end
 * — they paid for the month, let them use it.
 */
export async function cancelSubscription(subscriptionId: string): Promise<void> {
  await db
    .from("subscriptions")
    .update({ status: "cancelled", cancelled_at: new Date().toISOString() })
    .eq("id", subscriptionId);
}

/**
 * Enter grace period: status 'grace', role stays, DM warning.
 * Called by cron when period_end passes without payment.
 */
export async function enterGrace(subscriptionId: string): Promise<void> {
  const { data: sub } = await db
    .from("subscriptions")
    .select("*, users(discord_id)")
    .eq("id", subscriptionId)
    .single();
  if (!sub) return;
  const user = sub.users as unknown as { discord_id: string } | null;

  await db
    .from("subscriptions")
    .update({ status: "grace" })
    .eq("id", subscriptionId);

  if (user?.discord_id) {
    const graceEnd = new Date(sub.grace_until).getTime();
    await notifyDiscordUser(
      user.discord_id,
      `⚠️ Your **${tierLabel(sub.tier)}** subscription expired but you're in a **48-hour grace period** (until <t:${Math.floor(graceEnd / 1000)}:R>).\n` +
        `Renew now to keep your role: ${process.env.PUBLIC_BASE_URL}/account`
    ).catch((e) => console.error("[subs] grace DM failed", e));
  }
}

/**
 * Terminal expire: revoke role, mark expired.
 * Called by cron when grace_until passes.
 */
export async function expireSubscription(subscriptionId: string): Promise<void> {
  const { data: sub } = await db
    .from("subscriptions")
    .select("*, users(discord_id)")
    .eq("id", subscriptionId)
    .single();
  if (!sub) return;
  const user = sub.users as unknown as { discord_id: string } | null;

  await db
    .from("subscriptions")
    .update({ status: "expired" })
    .eq("id", subscriptionId);

  if (user?.discord_id) {
    await clearTierRoles(user.discord_id).catch((e) => console.error("[subs] clear roles failed", e));
    await notifyDiscordUser(
      user.discord_id,
      `❌ Your **${tierLabel(sub.tier)}** subscription has ended. Resubscribe any time: ${process.env.PUBLIC_BASE_URL}/account`
    ).catch((e) => console.error("[subs] expire DM failed", e));
  }

  await logToStaff(`📤 Sub expired: ${tierLabel(sub.tier)} · user ${sub.user_id}`);
}

/**
 * Send a renewal reminder DM. Idempotent — only runs if the flag isn't set.
 * `which` is which window we're in (affects the message tone).
 */
export async function sendRenewalReminder(
  subscriptionId: string,
  which: "7d" | "3d" | "1d"
): Promise<void> {
  const flag = `reminded_${which}` as const;

  const { data: sub } = await db
    .from("subscriptions")
    .select("*, users(discord_id)")
    .eq("id", subscriptionId)
    .single();
  if (!sub) return;
  if (sub[flag]) return;  // already sent
  const user = sub.users as unknown as { discord_id: string } | null;

  // Make sure the renewal invoice exists so the DM has a link.
  const invRes = await createRenewalInvoice(subscriptionId);
  if (!invRes.ok) {
    console.error(`[subs] renewal invoice failed for ${subscriptionId}: ${invRes.error}`);
    return;
  }

  const periodEnd = Math.floor(new Date(sub.period_end).getTime() / 1000);
  const tone =
    which === "7d"
      ? `⏰ Your **${tierLabel(sub.tier)}** sub renews in 7 days`
      : which === "3d"
      ? `⏰ 3 days left on your **${tierLabel(sub.tier)}** sub`
      : `⚠️ Tomorrow: your **${tierLabel(sub.tier)}** sub ends`;

  if (user?.discord_id) {
    await notifyDiscordUser(
      user.discord_id,
      `${tone} (<t:${periodEnd}:R>).\n` +
        `Keep your discount + perks — pay with crypto:\n${invRes.invoiceUrl}`
    ).catch((e) => console.error(`[subs] reminder ${which} failed`, e));
  }

  await db.from("subscriptions").update({ [flag]: true }).eq("id", subscriptionId);
}
