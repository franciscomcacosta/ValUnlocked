// Referrals ("Invite friends").
//
//   • Each user has a short code → share link  <PUBLIC_BASE_URL>/r/<code>
//   • A friend who opens it and hasn't ordered before gets linked to the
//     inviter (users.referred_by).
//   • When that friend's first paid order (≥ REFERRAL_MIN_ORDER) is
//     delivered, the inviter and the friend both get store credit — once.
//
// Amounts come from env (cents), with defaults:
//   REFERRAL_REWARD_CENTS     inviter's reward       (default 150 = €1.50)
//   REFERRAL_FRIEND_CENTS     friend's bonus         (default 150 = €1.50)
//   REFERRAL_MIN_ORDER_CENTS  min first order value  (default 300 = €3.00)
import { randomInt } from "crypto";
import { db } from "./supabase";
import { notifyDiscordUser, logToStaff } from "./discord";

const num = (v: string | undefined, d: number) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : d;
};
export const REFERRAL_REWARD_CENTS = num(process.env.REFERRAL_REWARD_CENTS, 150);
export const REFERRAL_FRIEND_CENTS = num(process.env.REFERRAL_FRIEND_CENTS, 150);
export const REFERRAL_MIN_ORDER_CENTS = num(process.env.REFERRAL_MIN_ORDER_CENTS, 300);
export const REFERRAL_COOKIE = "vs_ref";

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const base = () => process.env.PUBLIC_BASE_URL ?? "https://valunlock.online";
// No 0/o/1/l/i — easy to read out loud.
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export const referralLink = (code: string) => `${base()}/r/${code}`;
export const cleanCode = (raw: string | null | undefined) =>
  (raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || null;

/** The user's referral code, created on first use. */
export async function ensureReferralCode(userId: string): Promise<string> {
  const { data } = await db.from("users").select("referral_code").eq("id", userId).single();
  if (data?.referral_code) return data.referral_code as string;
  for (let i = 0; i < 8; i++) {
    const code = Array.from({ length: 7 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
    const { data: set, error } = await db
      .from("users")
      .update({ referral_code: code })
      .eq("id", userId)
      .is("referral_code", null)
      .select("referral_code");
    if (!error && set?.length) return code;
    if (!error) {
      // Someone (another tab) set it first — use theirs.
      const { data: again } = await db.from("users").select("referral_code").eq("id", userId).single();
      if (again?.referral_code) return again.referral_code as string;
    }
    // error = code clash on the unique index → try another.
  }
  throw new Error("couldn't create a referral code");
}

/**
 * Link a user to whoever invited them. Only works once, only for users
 * who haven't placed any order yet, and never to themselves.
 * Returns true when the link was made.
 */
export async function attachReferrer(userId: string, rawCode: string | null | undefined): Promise<boolean> {
  const code = cleanCode(rawCode);
  if (!code) return false;
  const { data: referrer } = await db.from("users").select("id, discord_id").eq("referral_code", code).maybeSingle();
  if (!referrer || referrer.id === userId) return false;

  const { count } = await db.from("orders").select("id", { count: "exact", head: true }).eq("user_id", userId);
  if ((count ?? 0) > 0) return false; // existing customer — not a new referral

  const { data: linked } = await db
    .from("users")
    .update({ referred_by: referrer.id, referred_at: new Date().toISOString() })
    .eq("id", userId)
    .is("referred_by", null)
    .select("discord_id, discord_username");
  if (!linked?.length) return false;

  const friend = linked[0];
  await notifyDiscordUser(
    referrer.discord_id as string,
    `👋 **${friend.discord_username ?? "A friend"}** just joined Val Unlocked with your invite link. ` +
      `When they make their first purchase you'll get **${eur(REFERRAL_REWARD_CENTS)}** credit.`
  ).catch(() => {});
  return true;
}

/** Called after an order is delivered. Pays the referral reward if this is
 *  the friend's first qualifying order. Safe to call more than once. */
export async function rewardReferral(orderId: string): Promise<void> {
  const { data: referrerId, error } = await db.rpc("apply_referral_reward", {
    p_order_id: orderId,
    p_referrer_cents: REFERRAL_REWARD_CENTS,
    p_referee_cents: REFERRAL_FRIEND_CENTS,
    p_min_paid_cents: REFERRAL_MIN_ORDER_CENTS,
  });
  if (error) {
    // Migration 008 not run yet → just skip.
    console.warn("[referrals] reward check failed", error.message);
    return;
  }
  if (!referrerId) return;

  const [{ data: referrer }, { data: order }] = await Promise.all([
    db.from("users").select("discord_id, discord_username").eq("id", referrerId as string).single(),
    db.from("orders").select("users(discord_id, discord_username)").eq("id", orderId).single(),
  ]);
  const friend = order?.users as unknown as { discord_id: string; discord_username: string | null } | null;

  if (referrer?.discord_id && REFERRAL_REWARD_CENTS > 0) {
    await notifyDiscordUser(
      referrer.discord_id as string,
      `🎉 **${friend?.discord_username ?? "Your friend"}** made their first purchase — ` +
        `**${eur(REFERRAL_REWARD_CENTS)}** credit is now in your account. Keep inviting: ${base()}`
    ).catch(() => {});
  }
  if (friend?.discord_id && REFERRAL_FRIEND_CENTS > 0) {
    await notifyDiscordUser(
      friend.discord_id,
      `🎁 Thanks for joining through a friend's invite — **${eur(REFERRAL_FRIEND_CENTS)}** bonus credit was added to your account.`
    ).catch(() => {});
  }
  await logToStaff(
    `🤝 Referral paid: <@${referrer?.discord_id}> +${eur(REFERRAL_REWARD_CENTS)}, ` +
      `<@${friend?.discord_id}> +${eur(REFERRAL_FRIEND_CENTS)} (order ${orderId.slice(0, 8).toUpperCase()}).`
  );
}

/** Numbers for a user's own Invite page. */
export async function referralStats(userId: string) {
  const [{ data: friends }, { data: earned }] = await Promise.all([
    db
      .from("users")
      .select("discord_username, referred_at, referral_rewarded_at")
      .eq("referred_by", userId)
      .order("referred_at", { ascending: false })
      .limit(50),
    db.from("credit_ledger").select("delta_cents").eq("user_id", userId).eq("reason", "referral"),
  ]);
  const list = friends ?? [];
  return {
    invited: list.length,
    rewarded: list.filter((f) => f.referral_rewarded_at).length,
    earnedCents: (earned ?? []).reduce((s, r) => s + ((r.delta_cents as number) ?? 0), 0),
    friends: list.slice(0, 20).map((f) => ({
      // Only show the first letters of friends' names to the inviter.
      name: f.discord_username ? `${String(f.discord_username).slice(0, 3)}***` : "friend",
      joinedAt: f.referred_at as string | null,
      bought: !!f.referral_rewarded_at,
    })),
  };
}
