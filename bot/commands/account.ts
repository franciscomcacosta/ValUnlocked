// /account — points to the dashboard account page. The web UI is richer
// and lets the user manage sub + credit + orders in one place.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
} from "discord.js";

const BASE = process.env.PUBLIC_BASE_URL!;

export const data = new SlashCommandBuilder()
  .setName("account")
  .setDescription("Open your account dashboard (subscription, orders, credit)");

export async function execute(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setColor(0xff4655)
    .setTitle("Your account is on the dashboard")
    .setDescription(
      `Sub status, renewal, store credit, order history, and account credentials all live on **Val Unlocked**.\n\n` +
        `Sign in with this same Discord account.`
    );

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel("Open account").setEmoji("👤").setStyle(ButtonStyle.Link).setURL(`${BASE}/account`),
    new ButtonBuilder().setLabel("Shop").setEmoji("🛒").setStyle(ButtonStyle.Link).setURL(BASE)
  );

  await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}
