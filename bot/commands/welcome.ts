// /welcome — admin-only. Posts the sticky welcome card into the current
// channel. Run this once in your #welcome channel after inviting the bot.
// Pin the resulting message so new members see it.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";

const BASE = process.env.PUBLIC_BASE_URL!;

export const data = new SlashCommandBuilder()
  .setName("welcome")
  .setDescription("Post the welcome / login card in this channel (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction) {
  // Belt-and-braces admin check — defaultMemberPermissions is bypass-able
  // by server admins reconfiguring command perms.
  const adminIds = (process.env.ADMIN_DISCORD_IDS ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!adminIds.includes(interaction.user.id)) {
    await interaction.reply({ content: "Admins only.", ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(0xff4655)
    .setTitle("👋 Welcome to Val Unlocked")
    .setDescription(
      `**Full-access Valorant accounts — delivered instantly.**\n\n` +
        `Everything you need is on the dashboard. Sign in with this Discord account — your perks, discounts, and purchases sync automatically.\n\n` +
        `**What you get on the dashboard:**\n` +
        `🛒 Browse the live account shop — every region, updated live\n` +
        `💎 Memberships: **Standard 10%** · **Premium 20%** · **Ultra 30%** off every account\n` +
        `⚡ Premium & Ultra see new restocks **2 hours early**\n` +
        `👤 Manage your plan + store credit\n` +
        `📦 View past orders and credentials\n`
    )
    .setFooter({
      text: "Pay in crypto · No chargebacks · Instant delivery",
    });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel("Log in to the dashboard")
      .setEmoji("🔓")
      .setStyle(ButtonStyle.Link)
      .setURL(`${BASE}/api/auth/login`),
    new ButtonBuilder().setLabel("See pricing").setEmoji("💎").setStyle(ButtonStyle.Link).setURL(`${BASE}/pricing`)
  );

  // Non-ephemeral so it sits visible in the channel for everyone.
  await interaction.reply({ embeds: [embed], components: [row] });
}
