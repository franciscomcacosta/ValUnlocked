// /grant — admin-only. Gives (or removes) a membership plan for free and
// keeps the Discord role in sync in one step.
//
//   /grant user:@someone tier:Ultra days:30   → active Ultra for 30 days + Ultra role
//   /grant user:@someone tier:Remove          → ends their plan + strips tier roles
//
// Same tier again extends from the current end date; a different tier
// switches the plan and keeps whichever end date is later.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import { db } from "../../lib/supabase";
import { setTierRole, clearTierRoles, notifyDiscordUser, logToStaff } from "../../lib/discord";
import { SUB_GRACE_HOURS, tierLabel, type SubTier } from "../../lib/pricing";

const TIERS: SubTier[] = ["standard", "premium", "ultra"];

export const data = new SlashCommandBuilder()
  .setName("grant")
  .setDescription("Give or remove a membership plan (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addUserOption((o) => o.setName("user").setDescription("Who gets it").setRequired(true))
  .addStringOption((o) =>
    o
      .setName("tier")
      .setDescription("Plan to give")
      .setRequired(true)
      .addChoices(
        { name: "Standard", value: "standard" },
        { name: "Premium", value: "premium" },
        { name: "Ultra", value: "ultra" },
        { name: "Remove plan", value: "remove" }
      )
  )
  .addIntegerOption((o) => o.setName("days").setDescription("How long (default 30)").setMinValue(1).setMaxValue(365))
  .addBooleanOption((o) => o.setName("dm").setDescription("DM them about it (default yes)"));

export function isAdmin(id: string): boolean {
  return (process.env.ADMIN_DISCORD_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean).includes(id);
}


/** Find or create the site account for a Discord user. */
export async function ensureUser(discordId: string, username: string): Promise<string> {
  const { data: user } = await db.from("users").select("id").eq("discord_id", discordId).maybeSingle();
  if (user?.id) return user.id as string;
  const ins = await db.from("users").insert({ discord_id: discordId, discord_username: username }).select("id").single();
  if (ins.error) throw ins.error;
  return ins.data.id as string;
}

/** Give a plan for N days. Same tier → extends from the current end;
 *  different tier → switches and keeps whichever end date is later. */
export async function applyPlan(userId: string, tier: SubTier, days: number): Promise<{ end: Date; previousTier: SubTier | null }> {
  const { data: current } = await db
    .from("subscriptions")
    .select("id, tier, period_end")
    .eq("user_id", userId)
    .in("status", ["active", "grace"])
    .maybeSingle();
  const now = Date.now();
  const curEnd = current ? new Date(current.period_end as string).getTime() : 0;
  const end = new Date(
    current && current.tier === tier
      ? Math.max(now, curEnd) + days * 86_400_000
      : Math.max(curEnd, now + days * 86_400_000)
  );
  const fields = {
    tier,
    status: "active",
    period_end: end.toISOString(),
    grace_until: new Date(end.getTime() + SUB_GRACE_HOURS * 3_600_000).toISOString(),
    current_invoice_id: null,
    reminded_7d: false,
    reminded_3d: false,
    reminded_1d: false,
    cancelled_at: null,
  };
  const res = current
    ? await db.from("subscriptions").update(fields).eq("id", current.id)
    : await db.from("subscriptions").insert({ user_id: userId, ...fields });
  if (res.error) throw res.error;
  return { end, previousTier: (current?.tier as SubTier | undefined) ?? null };
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "Admins only.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const target = interaction.options.getUser("user", true);
  const choice = interaction.options.getString("tier", true);
  const days = interaction.options.getInteger("days") ?? 30;
  const dm = interaction.options.getBoolean("dm") ?? true;

  const userId = await ensureUser(target.id, target.username);

  const { data: current } = await db
    .from("subscriptions")
    .select("id, tier, period_end")
    .eq("user_id", userId)
    .in("status", ["active", "grace"])
    .maybeSingle();

  // ── Remove ────────────────────────────────────────────────────────────
  if (choice === "remove") {
    if (current) await db.from("subscriptions").update({ status: "expired" }).eq("id", current.id);
    const roleNote = await clearTierRoles(target.id).then(() => "roles removed", (e) => `⚠️ role removal failed: ${e.message}`);
    await logToStaff(`🛠️ ${interaction.user.username} removed the plan from <@${target.id}>`).catch(() => {});
    await interaction.editReply(
      current ? `Removed **${tierLabel(current.tier as SubTier)}** from <@${target.id}> · ${roleNote}` : `<@${target.id}> had no active plan · ${roleNote}`
    );
    return;
  }

  // ── Grant ─────────────────────────────────────────────────────────────
  const tier = choice as SubTier;
  if (!TIERS.includes(tier)) {
    await interaction.editReply("Unknown tier.");
    return;
  }
  const { end, previousTier } = await applyPlan(userId, tier, days);

  const roleNote = await setTierRole(target.id, tier).then(
    () => `**${tierLabel(tier)}** role given`,
    (e) => `⚠️ plan saved but the role failed: ${e.message}`
  );

  if (dm) {
    await notifyDiscordUser(
      target.id,
      `🎁 You've been given **${tierLabel(tier)}** on Val Unlocked until <t:${Math.floor(end.getTime() / 1000)}:D>.\n` +
        `Your discount, early access and perks are live now: ${process.env.PUBLIC_BASE_URL ?? "https://valunlock.online"}`
    ).catch(() => {});
  }
  await logToStaff(
    `🛠️ ${interaction.user.username} granted **${tierLabel(tier)}** to <@${target.id}> until <t:${Math.floor(end.getTime() / 1000)}:D>`
  ).catch(() => {});

  const embed = new EmbedBuilder()
    .setColor(tier === "ultra" ? 0xfad663 : tier === "premium" ? 0xd1548d : 0x9aa5b1)
    .setTitle(`${tierLabel(tier)} granted`)
    .setDescription(
      `<@${target.id}> · until <t:${Math.floor(end.getTime() / 1000)}:D> (<t:${Math.floor(end.getTime() / 1000)}:R>)\n${roleNote}` +
        (previousTier && previousTier !== tier ? `\nSwitched from ${tierLabel(previousTier)}.` : "")
    );
  await interaction.editReply({ embeds: [embed] });
}
