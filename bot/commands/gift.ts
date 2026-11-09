// /gift — gift a membership plan to someone and announce it in #general:
//   "@gifter gifted a Ultra sub to @someone"
//
// Who can use it: everyone in ADMIN_DISCORD_IDS plus GIFTER_DISCORD_IDS
// (defaults to 751197680805478451). Channel: GIFT_CHANNEL_ID (defaults to
// #general 1524132175530688632).
import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
  type TextBasedChannel,
} from "discord.js";
import { setTierRole, notifyDiscordUser, logToStaff } from "../../lib/discord";
import { tierLabel, type SubTier } from "../../lib/pricing";
import { isAdmin, ensureUser, applyPlan } from "./grant";

const GIFT_CHANNEL_ID = process.env.GIFT_CHANNEL_ID ?? "1524132175530688632";
const TIER_COLOR: Record<SubTier, number> = { standard: 0x9aa5b1, premium: 0xd1548d, ultra: 0xfad663 };
const TIER_EMOJI: Record<SubTier, string> = { standard: "🎟️", premium: "💎", ultra: "👑" };

function canGift(id: string): boolean {
  const gifters = (process.env.GIFTER_DISCORD_IDS ?? "751197680805478451").split(",").map((x) => x.trim()).filter(Boolean);
  return isAdmin(id) || gifters.includes(id);
}

export const data = new SlashCommandBuilder()
  .setName("gift")
  .setDescription("Gift a membership plan to someone")
  .addUserOption((o) => o.setName("user").setDescription("Who gets the gift").setRequired(true))
  .addStringOption((o) =>
    o
      .setName("tier")
      .setDescription("Plan to gift")
      .setRequired(true)
      .addChoices({ name: "Standard", value: "standard" }, { name: "Premium", value: "premium" }, { name: "Ultra", value: "ultra" })
  )
  .addIntegerOption((o) => o.setName("days").setDescription("How long (default 30)").setMinValue(1).setMaxValue(365));

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!canGift(interaction.user.id)) {
    await interaction.reply({ content: "You can't gift plans.", ephemeral: true });
    return;
  }
  const target = interaction.options.getUser("user", true);
  const tier = interaction.options.getString("tier", true) as SubTier;
  const days = interaction.options.getInteger("days") ?? 30;
  if (target.bot) {
    await interaction.reply({ content: "Bots can't get plans.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const userId = await ensureUser(target.id, target.username);
  const { end } = await applyPlan(userId, tier, days);
  const ts = Math.floor(end.getTime() / 1000);
  const roleNote = await setTierRole(target.id, tier).then(() => "role given", (e) => `⚠️ role failed: ${e.message}`);

  // Public announcement in #general.
  let announced = "announced in #general";
  try {
    const ch = await interaction.client.channels.fetch(GIFT_CHANNEL_ID);
    if (!ch || !ch.isTextBased() || !("send" in ch)) throw new Error("channel not found");
    const embed = new EmbedBuilder()
      .setColor(TIER_COLOR[tier])
      .setTitle(`${TIER_EMOJI[tier]} ${tierLabel(tier).toUpperCase()} GIFTED`)
      .setDescription(`<@${interaction.user.id}> gifted a **${tierLabel(tier)}** sub to <@${target.id}>`)
      .setThumbnail(target.displayAvatarURL({ size: 128 }))
      .setFooter({ text: `${days} day${days === 1 ? "" : "s"} of ${tierLabel(tier)} perks · valunlock.online` })
      .setTimestamp();
    await (ch as TextBasedChannel & { send: Function }).send({
      content: `<@${interaction.user.id}> gifted a **${tierLabel(tier)}** sub to <@${target.id}> 🎉`,
      embeds: [embed],
      allowedMentions: { users: [target.id, interaction.user.id] },
    });
  } catch (e) {
    announced = `⚠️ couldn't post in #general: ${(e as Error).message}`;
  }

  await notifyDiscordUser(
    target.id,
    `🎁 **${interaction.user.username}** gifted you **${tierLabel(tier)}** on Val Unlocked — active until <t:${ts}:D>.\n` +
      `Your discount and perks are live now: ${process.env.PUBLIC_BASE_URL ?? "https://valunlock.online"}`
  ).catch(() => {});
  await logToStaff(`🎁 ${interaction.user.username} gifted **${tierLabel(tier)}** (${days}d) to <@${target.id}>`).catch(() => {});

  await interaction.editReply(`Gifted **${tierLabel(tier)}** to <@${target.id}> until <t:${ts}:D> · ${roleNote} · ${announced}`);
}
