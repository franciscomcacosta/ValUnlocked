// Referrals in Discord.
//
//   /invite               → (anyone) your personal invite link + stats, only you see it
//   /invite panel:true    → (admins) posts the "Invite friends" panel in this channel,
//                           with a "Get my invite link" button for everyone
//
// The button (customId "invite:link") gives the same private reply as /invite.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type User,
} from "discord.js";
import { isAdmin, ensureUser } from "./grant";
import {
  ensureReferralCode,
  referralLink,
  referralStats,
  REFERRAL_FRIEND_CENTS,
  REFERRAL_MIN_ORDER_CENTS,
  REFERRAL_REWARD_CENTS,
} from "../../lib/referrals";

const RED = 0xff4655;
const GOLD = 0xffd400;
const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

export const data = new SlashCommandBuilder()
  .setName("invite")
  .setDescription("Get your invite link — you and your friend both earn store credit")
  .addBooleanOption((o) => o.setName("panel").setDescription("Admins: post the public invite panel in this channel"));

/** The private "here's your link" reply. */
async function linkReply(user: User) {
  const userId = await ensureUser(user.id, user.username);
  const code = await ensureReferralCode(userId);
  const link = referralLink(code);
  const s = await referralStats(userId);

  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle("🎁 Your invite link")
    .setDescription(
      `\`\`\`\n${link}\n\`\`\`` +
        `Share it anywhere. When a friend joins with it and makes their first purchase of **${eur(REFERRAL_MIN_ORDER_CENTS)}+**, ` +
        `you get **${eur(REFERRAL_REWARD_CENTS)}** and they get **${eur(REFERRAL_FRIEND_CENTS)}** in store credit.`
    )
    .addFields(
      { name: "Friends joined", value: String(s.invited), inline: true },
      { name: "Bought", value: String(s.rewarded), inline: true },
      { name: "You've earned", value: eur(s.earnedCents), inline: true }
    )
    .setFooter({ text: "Only new customers count · Val Unlocked" });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open my link").setURL(link)
  );
  return { embeds: [embed], components: [row], ephemeral: true as const };
}

/** The public panel posted by admins. */
function panel() {
  const embed = new EmbedBuilder()
    .setColor(RED)
    .setTitle("🎁 Invite friends, earn credit")
    .setDescription(
      `Bring a friend to **Val Unlocked** and you both get rewarded:\n\n` +
        `> **You** get **${eur(REFERRAL_REWARD_CENTS)}** store credit\n` +
        `> **Your friend** gets **${eur(REFERRAL_FRIEND_CENTS)}** store credit\n\n` +
        `once they make their first purchase of **${eur(REFERRAL_MIN_ORDER_CENTS)}** or more. No limit — invite as many friends as you like.\n\n` +
        `Tap the button to get your personal link (only you can see it).`
    )
    .setFooter({ text: "Credit is added automatically · Val Unlocked" });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId("invite:link").setStyle(ButtonStyle.Success).setLabel("Get my invite link").setEmoji("🔗")
  );
  return { embeds: [embed], components: [row] };
}

export async function execute(interaction: ChatInputCommandInteraction) {
  if (interaction.options.getBoolean("panel")) {
    if (!isAdmin(interaction.user.id)) {
      await interaction.reply({ content: "Only admins can post the invite panel.", ephemeral: true });
      return;
    }
    const ch = interaction.channel;
    if (!ch || !ch.isTextBased() || !("send" in ch)) {
      await interaction.reply({ content: "Run this in a text channel.", ephemeral: true });
      return;
    }
    await ch.send(panel());
    await interaction.reply({ content: "Invite panel posted ✅", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });
  const r = await linkReply(interaction.user);
  await interaction.editReply({ embeds: r.embeds, components: r.components });
}

export async function handleButton(interaction: ButtonInteraction) {
  if (interaction.customId !== "invite:link") return;
  await interaction.deferReply({ ephemeral: true });
  try {
    const r = await linkReply(interaction.user);
    await interaction.editReply({ embeds: r.embeds, components: r.components });
  } catch (e) {
    console.error("[invite] link failed", e);
    await interaction.editReply({ content: "Invites aren't set up yet — try again later." });
  }
}
