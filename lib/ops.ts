// Background ops, run every minute by /api/cron/ops (the Discord bot calls it).
// Each step is independent: one failing never stops the others.
//
//   checkBalance   — cache the qvsp balance; pause sales when it can't cover
//                    even the cheapest account, resume when it can; warn staff
//                    when it gets low.
//   checkWatcher   — staff alert if the stock watcher stops checking in.
//   remindUnpaid   — one DM ~30 min after an unpaid checkout.
//   askVouches     — one "How was it? ⭐" DM after the 10-min test window.
//
// Env (optional):
//   QVSP_LOW_BALANCE_CENTS   warn staff below this (default 2000 = €20)
//   VOUCHES_ENABLED          "false" to stop asking for ratings
import { db } from "./supabase";
import { getBalance } from "./qvsp";
import { logToStaff, notifyDiscordUser } from "./discord";
import { getFlag, setFlag, getSalesPause } from "./shop-flags";
import { unpaidReminderMessage, vouchRequestMessage, accountSummary } from "./discord-messages";

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const minsAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
const LOW_BALANCE = (() => {
  const n = parseInt(process.env.QVSP_LOW_BALANCE_CENTS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 2000;
})();

// ─── 2. qvsp balance → pause / resume sales ──────────────────────────

export async function checkBalance(): Promise<string> {
  let bal: { cents: number; currency: string };
  try {
    bal = await getBalance();
  } catch (e) {
    return `balance unavailable (${String(e).slice(0, 80)})`; // never pause on a failed read
  }
  await setFlag("qvsp_balance", { ...bal, at: new Date().toISOString() });

  // Cheapest account anyone could buy right now.
  const { data: cheapest } = await db
    .from("qvsp_stock")
    .select("qvsp_price_cents")
    .eq("kind", "skinned")
    .is("removed_at", null)
    .eq("claimed", false)
    .is("reserved_order_id", null)
    .order("qvsp_price_cents", { ascending: true })
    .limit(1)
    .maybeSingle();
  const minCost = (cheapest?.qvsp_price_cents as number | undefined) ?? 0;

  const pause = await getSalesPause();
  const cantBuyAnything = minCost > 0 && bal.cents < minCost;
  if (cantBuyAnything && !pause.paused) {
    await setFlag("sales_paused", {
      paused: true,
      by: "auto",
      reason: `qvsp balance ${eur(bal.cents)} can't cover the cheapest account (${eur(minCost)})`,
      since: new Date().toISOString(),
    });
    await logToStaff(
      `🛑 **Sales paused automatically** — qvsp balance is **${eur(bal.cents)}**, not enough for even the cheapest account (${eur(minCost)}). ` +
        `Top up qvsp; sales resume on their own within a minute.`
    );
  } else if (!cantBuyAnything && pause.paused && pause.by === "auto") {
    await setFlag("sales_paused", { paused: false });
    await logToStaff(`✅ **Sales resumed** — qvsp balance is back to **${eur(bal.cents)}**.`);
  }

  // Low-balance warning, once per dip.
  const warned = (await getFlag<{ low: boolean }>("balance_alert"))?.low ?? false;
  if (bal.cents < LOW_BALANCE && !warned) {
    await setFlag("balance_alert", { low: true });
    await logToStaff(`⚠️ qvsp balance is low: **${eur(bal.cents)}** (warning level ${eur(LOW_BALANCE)}). Top up soon to avoid stuck orders.`);
  } else if (bal.cents >= LOW_BALANCE && warned) {
    await setFlag("balance_alert", { low: false });
  }
  return `balance ${eur(bal.cents)}${cantBuyAnything ? " (paused)" : ""}`;
}

// ─── 3. stock watcher health ─────────────────────────────────────────

export async function checkWatcher(): Promise<string> {
  const { data, error } = await db.from("service_heartbeats").select("beat_at").eq("name", "watcher").maybeSingle();
  if (error) return "heartbeat table missing (run migration 009)";
  if (!data) return "watcher has never checked in";
  const ageMin = (Date.now() - new Date(data.beat_at as string).getTime()) / 60_000;
  const state = (await getFlag<{ down: boolean }>("watcher_alert"))?.down ?? false;

  if (ageMin > 5 && !state) {
    await setFlag("watcher_alert", { down: true, since: data.beat_at });
    await logToStaff(
      `🚨 **Stock watcher is down** — last check-in ${Math.round(ageMin)} min ago, so stock isn't syncing.\n` +
        "Run `fly machine list -a valo-shop-watcher` and `fly logs -a valo-shop-watcher --no-tail`."
    );
  } else if (ageMin <= 5 && state) {
    await setFlag("watcher_alert", { down: false });
    await logToStaff("✅ Stock watcher is back — stock is syncing again.");
  }
  return `watcher ${ageMin <= 5 ? "ok" : `stale ${Math.round(ageMin)}m`}`;
}

// ─── 6. unpaid-order reminder ────────────────────────────────────────

export async function remindUnpaid(): Promise<string> {
  const { data: orders, error } = await db
    .from("orders")
    .select("id, created_at, charge_cents, np_invoice_id, users(discord_id), products(name)")
    .in("status", ["pending", "waiting"])
    .is("unpaid_reminded_at", null)
    .not("np_invoice_id", "is", null)
    .gt("charge_cents", 0)
    .lte("created_at", minsAgo(25))
    .gte("created_at", minsAgo(150)) // unpaid orders expire at 3 h
    .limit(25);
  if (error) return `unpaid: ${error.message}`;

  let sent = 0;
  for (const o of orders ?? []) {
    // Claim the reminder first so two runs can't both send it.
    const { data: mine } = await db
      .from("orders")
      .update({ unpaid_reminded_at: new Date().toISOString() })
      .eq("id", o.id)
      .is("unpaid_reminded_at", null)
      .select("id");
    if (!mine?.length) continue;
    const did = (o.users as unknown as { discord_id?: string } | null)?.discord_id;
    if (!did) continue;
    await notifyDiscordUser(
      did,
      unpaidReminderMessage({
        orderId: o.id as string,
        itemName: (o.products as unknown as { name?: string } | null)?.name ?? "your account",
        amountCents: o.charge_cents as number,
        expiresAt: new Date(new Date(o.created_at as string).getTime() + 3 * 3_600_000),
        payUrl: o.np_invoice_id ? `https://nowpayments.io/payment/?iid=${o.np_invoice_id}` : null,
      })
    ).then(() => sent++, () => {});
  }
  return `unpaid reminders ${sent}`;
}

// ─── 4. ask for a vouch after the test window ───────────────────────

export async function askVouches(): Promise<string> {
  if ((process.env.VOUCHES_ENABLED ?? "true").toLowerCase() === "false") return "vouches off";
  const { data: orders, error } = await db
    .from("orders")
    .select("id, credit_used_cents, charge_cents, users(discord_id)")
    .eq("status", "fulfilled")
    .is("vouch_asked_at", null)
    .lte("fulfilled_at", minsAgo(12))   // 10-min test window + a little slack
    .gte("fulfilled_at", minsAgo(48 * 60))
    .limit(20);
  if (error) return `vouches: ${error.message}`;
  const paid = (orders ?? []).filter((o) => ((o.credit_used_cents as number) ?? 0) + ((o.charge_cents as number) ?? 0) > 0);
  if (!paid.length) return "vouches 0";

  const ids = paid.map((o) => o.id as string);
  const [{ data: claims }, { data: accounts }] = await Promise.all([
    db.from("replacement_claims").select("order_id").in("order_id", ids),
    db.from("qvsp_stock").select("claimed_order_id, region, skin_count").in("claimed_order_id", ids),
  ]);
  const reported = new Set((claims ?? []).map((c) => c.order_id as string));
  const acct = new Map((accounts ?? []).map((a) => [a.claimed_order_id as string, a]));

  let sent = 0;
  for (const o of paid) {
    const { data: mine } = await db
      .from("orders")
      .update({ vouch_asked_at: new Date().toISOString() })
      .eq("id", o.id)
      .is("vouch_asked_at", null)
      .select("id");
    if (!mine?.length) continue;
    if (reported.has(o.id as string)) continue;   // they had a problem — don't ask for stars
    const did = (o.users as unknown as { discord_id?: string } | null)?.discord_id;
    if (!did) continue;
    const a = acct.get(o.id as string);
    await notifyDiscordUser(
      did,
      vouchRequestMessage({ orderId: o.id as string, summary: accountSummary(a?.region as string | undefined, a?.skin_count as number | undefined) })
    ).then(() => sent++, () => {});
  }
  return `vouches ${sent}`;
}

/** Everything above, isolated from each other. */
export async function runOps(): Promise<Record<string, string>> {
  const steps: Array<[string, () => Promise<string>]> = [
    ["balance", checkBalance],
    ["watcher", checkWatcher],
    ["unpaid", remindUnpaid],
    ["vouches", askVouches],
  ];
  const out: Record<string, string> = {};
  for (const [name, fn] of steps) {
    out[name] = await fn().catch((e) => `error: ${String(e).slice(0, 120)}`);
  }
  return out;
}
