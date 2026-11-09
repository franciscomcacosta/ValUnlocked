// /sub — points users at the dashboard. Managing tiers, picking a plan,
// paying renewals all happen on valunlock.online where the UI is richer.
// The bot just gets you the link, pre-authenticated via Discord OAuth.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
} from "discord.js";

import { BASE_URL } from "../base-url";
const BASE = BASE_URL;

export const data = new SlashCommandBuilder()
  .setName("sub")
  .setDescription("Pick or manage your subscription on the dashboard");

export async function execute(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setColor(0xff4655)
    .setTitle("Subscriptions live on the dashboard")
    .setDescription(
      `Pick a tier, see your discount, manage renewal — all on **Val Unlocked**.\n\n` +
        `Sign in with this same Discord account and your membership syncs back here automatically.`
    )
    .setFooter({ text: "Role granted the instant your payment confirms on-chain." });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("See plans").setEmoji("💎").setStyle(ButtonStyle.Link).setURL(`${BASE}/pricing`),
    new ButtonBuilder().setLabel("My account").setEmoji("👤").setStyle(ButtonStyle.Link).setURL(`${BASE}/account`)
  );

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}
