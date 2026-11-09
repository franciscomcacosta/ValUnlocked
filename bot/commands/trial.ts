// /trial role:@Verified days:7 — admin-only, one-off promo.
//
// Gives everyone with the role a free Standard trial + a free 1–25 skins
// account they claim on the dashboard, and DMs each of them the perks.
//
// Step 1 (the command) only COUNTS: who qualifies, who's skipped, and the
// worst-case cost if every single person claims their account. Nothing
// happens until you press Confirm.
//
// Skipped automatically: bots, anyone with an active/grace plan (never
// downgrades a paying member), anyone who already got a trial before.
//
// Needs "Server Members Intent" ON in the Discord Developer Portal
// (Bot → Privileged Gateway Intents) so the bot can list role members.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  Routes,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type Client,
  type APIGuildMember,
} from "discord.js";
import { db } from "../../lib/supabase";
import { logToStaff } from "../../lib/discord";
import { SKIN_BRACKETS } from "../../lib/pricing";
import { isAdmin, ensureUser, applyPlan } from "./grant";

const BASE = process.env.PUBLIC_BASE_URL ?? "https://valunlock.online";
const GIFT_BRACKET = SKIN_BRACKETS.find((b) => b.name === "s_1_25")!;
const PAUSE_MS = 1100; // between members — keeps DMs well under Discord's spam limits
let running = false;

export const data = new SlashCommandBuilder()
  .setName("trial")
  .setDescription("Give everyone with a role a free Standard trial + free account (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addRoleOption((o) => o.setName("role").setDescription("Who gets it, e.g. @Verified").setRequired(true))
  .addIntegerOption((o) => o.setName("days").setDescription("Trial length (default 7)").setMinValue(1).setMaxValue(30));

// ── Who qualifies ─────────────────────────────────────────────────────────
type Plan = { eligible: APIGuildMember[]; total: number; subscribed: number; hadTrial: number; bots: number };

async function membersWithRole(client: Client, guildId: string, roleId: string): Promise<APIGuildMember[]> {
  const out: APIGuildMember[] = [];
  let after = "0";
  for (;;) {
    const page = (await client.rest.get(Routes.guildMembers(guildId), {
      query: new URLSearchParams({ limit: "1000", after }),
    })) as APIGuildMember[];
    out.push(...page.filter((m) => m.roles.includes(roleId)));
    if (page.length < 1000) break;
    after = page[page.length - 1].user!.id;
  }
  return out;
}

async function buildPlan(client: Client, guildId: string, roleId: string): Promise<Plan> {
  const members = await membersWithRole(client, guildId, roleId);
  const humans = members.filter((m) => m.user && !m.user.bot);
  const ids = humans.map((m) => m.user!.id);

  // discord_id → users.id for people who already have a site account.
  const userIdByDiscord = new Map<string, string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data } = await db.from("users").select("id, discord_id").in("discord_id", ids.slice(i, i + 200));
    for (const u of data ?? []) userIdByDiscord.set(u.discord_id as string, u.id as string);
  }
  const known = [...userIdByDiscord.values()];
  const subscribed = new Set<string>();
  const hadTrial = new Set<string>();
  for (let i = 0; i < known.length; i += 200) {
    const chunk = known.slice(i, i + 200);
    const [{ data: subs }, { data: trials }] = await Promise.all([
      db.from("subscriptions").select("user_id").in("user_id", chunk).in("status", ["active", "grace"]),
      db.from("sub_invoices").select("user_id").in("user_id", chunk).eq("purpose", "trial"),
    ]);
    for (const s of subs ?? []) subscribed.add(s.user_id as string);
    for (const t of trials ?? []) hadTrial.add(t.user_id as string);
  }

  let nSub = 0, nTrial = 0;
  const eligible = humans.filter((m) => {
    const uid = userIdByDiscord.get(m.user!.id);
    if (uid && subscribed.has(uid)) { nSub++; return false; }
    if (uid && hadTrial.has(uid)) { nTrial++; return false; }
    return true;
  });
  return { eligible, total: members.length, subscribed: nSub, hadTrial: nTrial, bots: members.length - humans.length };
}

async function giftStockTotal(): Promise<number> {
  const { count } = await db
    .from("qvsp_stock")
    .select("qvsp_id", { count: "exact", head: true })
    .eq("kind", "skinned")
    .gte("skin_count", GIFT_BRACKET.minSkins)
    .lte("skin_count", GIFT_BRACKET.maxSkins)
    .lte("qvsp_price_cents", GIFT_BRACKET.maxAcceptableCostCents)
    .is("reserved_order_id", null)
    .is("removed_at", null)
    .eq("claimed", false);
  return count ?? 0;
}

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

// ── Step 1: preview ───────────────────────────────────────────────────────
export async function execute(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "Admins only.", ephemeral: true });
    return;
  }
  if (running) {
    await interaction.reply({ content: "A trial run is already in progress.", ephemeral: true });
    return;
  }
  const role = interaction.options.getRole("role", true);
  const days = interaction.options.getInteger("days") ?? 7;
  await interaction.deferReply({ ephemeral: true });

  let plan: Plan;
  try {
    plan = await buildPlan(interaction.client, interaction.guildId!, role.id);
  } catch (e) {
    const msg = (e as Error).message;
    await interaction.editReply(
      /Missing Access|50001|privileged|intent/i.test(msg)
        ? "I can't list server members. Turn on **Server Members Intent** in the Discord Developer Portal → your app → Bot → Privileged Gateway Intents, then try again."
        : `Couldn't list members: ${msg}`
    );
    return;
  }
  const stock = await giftStockTotal();
  const n = plan.eligible.length;
  const worst = Math.min(n, stock) * GIFT_BRACKET.maxAcceptableCostCents;
  const minutes = Math.ceil((n * (PAUSE_MS + 400)) / 60000);

  const embed = new EmbedBuilder()
    .setColor(0xffd400)
    .setTitle(`Trial preview · @${role.name}`)
    .setDescription(
      `**${n}** member${n === 1 ? "" : "s"} will get:\n` +
        `• **${days}-day Standard** plan + Standard role\n` +
        `• a **free 1–25 skins account** to claim on the dashboard\n` +
        `• a DM explaining it all\n\n` +
        `Skipped: ${plan.subscribed} already on a plan · ${plan.hadTrial} already had a trial · ${plan.bots} bots\n\n` +
        `💸 **Worst case if everyone claims:** ${Math.min(n, stock)} × up to ${eur(GIFT_BRACKET.maxAcceptableCostCents)} = **${eur(worst)}** from your qvsp balance` +
        (n > stock ? `\n⚠️ Only **${stock}** 1–25 accounts are in stock right now — the rest would see "no stock" until restocks.` : "") +
        `\n⏱️ Takes about ${minutes} min (paced so DMs don't get flagged).`
    );
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`trial:go:${role.id}:${days}`).setLabel(`Confirm — give ${n} trials`).setStyle(ButtonStyle.Success).setDisabled(n === 0),
    new ButtonBuilder().setCustomId("trial:cancel").setLabel("Cancel").setStyle(ButtonStyle.Secondary)
  );
  await interaction.editReply({ embeds: [embed], components: [row] });
}

// ── Step 2: run ───────────────────────────────────────────────────────────
function dmEmbed(days: number, endTs: number) {
  return new EmbedBuilder()
    .setColor(0xffd400)
    .setTitle("🎁 You got a FREE Valorant account + a free Standard sub")
    .setDescription(
      `Thanks for being part of **Val Unlocked**! As a verified member you just got:\n\n` +
        `🎮 **A FREE Valorant account** — 1–25 skins, full access. Pick your region and claim it in one click.\n` +
        `🎟️ **${days} days of Standard** — worth **€9.99**, on us.\n\n` +
        `**Your Standard perks:**\n` +
        `• **10% off** every account in the shop\n` +
        `• Members-only Discord channel\n` +
        `• Written method + guides\n` +
        `• Live drops feed — see every restock\n\n` +
        `Your trial ends <t:${endTs}:D> (<t:${endTs}:R>). No payment needed and nothing renews on its own.`
    )
    .setFooter({ text: "Log in with this Discord account to claim" });
}

export async function handleButton(interaction: ButtonInteraction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "Admins only.", ephemeral: true });
    return;
  }
  const [, action, roleId, daysRaw] = interaction.customId.split(":");
  if (action === "cancel") {
    await interaction.update({ content: "Cancelled — nothing was given.", embeds: [], components: [] });
    return;
  }
  if (action !== "go" || !roleId) return;
  if (running) {
    await interaction.reply({ content: "Already running.", ephemeral: true });
    return;
  }
  running = true;
  const days = Number(daysRaw) || 7;
  await interaction.update({ content: "⏳ Starting…", embeds: [], components: [] });

  const client = interaction.client;
  const guildId = interaction.guildId!;
  const stdRole = process.env.DISCORD_ROLE_STANDARD;
  const stats = { given: 0, dmFailed: 0, roleFailed: 0, errors: 0 };
  const errors: string[] = [];
  const progress = (msg: string) => interaction.editReply({ content: msg }).catch(() => {}); // token lasts 15 min

  try {
    // Re-check right now (someone may have subscribed since the preview).
    const plan = await buildPlan(client, guildId, roleId);
    const total = plan.eligible.length;
    const claimRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setLabel("Claim my free account").setEmoji("🎮").setStyle(ButtonStyle.Link).setURL(`${BASE}/?claim=trial`)
    );

    for (const [i, m] of plan.eligible.entries()) {
      const u = m.user!;
      try {
        const userId = await ensureUser(u.id, u.username);
        const { end, subscriptionId } = await applyPlan(userId, "standard", days, { trial: true });
        // €0 marker: "had a trial" + unlocks the free 1–25 account.
        const mark = await db.from("sub_invoices").insert({
          subscription_id: subscriptionId,
          user_id: userId,
          tier: "standard",
          amount_cents: 0,
          currency: "eur",
          purpose: "trial",
          paid_at: new Date().toISOString(),
        });
        if (mark.error) throw mark.error;

        if (stdRole) {
          await client.rest.put(Routes.guildMemberRole(guildId, u.id, stdRole)).catch(() => { stats.roleFailed++; });
        } else stats.roleFailed++;

        await client.users
          .send(u.id, { embeds: [dmEmbed(days, Math.floor(end.getTime() / 1000))], components: [claimRow] })
          .catch(() => { stats.dmFailed++; }); // DMs closed — they still get everything
        stats.given++;
      } catch (e) {
        stats.errors++;
        if (errors.length < 8) errors.push(`${u.username}: ${(e as Error).message.slice(0, 100)}`);
      }
      if ((i + 1) % 10 === 0 || i + 1 === total) await progress(`⏳ ${i + 1}/${total} done…`);
      await new Promise((r) => setTimeout(r, PAUSE_MS));
    }

    const summary =
      `✅ **Trial run finished** · ${stats.given} members got ${days}-day Standard + a free 1–25 account` +
      (stats.dmFailed ? `\n📭 ${stats.dmFailed} have DMs closed (they still got everything)` : "") +
      (stats.roleFailed ? `\n⚠️ ${stats.roleFailed} role assignments failed — run /syncroles` : "") +
      (stats.errors ? `\n❌ ${stats.errors} errors:\n${errors.join("\n")}` : "");
    await progress(summary);
    await logToStaff(summary).catch(() => {});
  } catch (e) {
    const msg = `❌ Trial run stopped: ${(e as Error).message}\nGiven so far: ${stats.given}. Running /trial again skips everyone who already got it.`;
    await progress(msg);
    await logToStaff(msg).catch(() => {});
  } finally {
    running = false;
  }
}
