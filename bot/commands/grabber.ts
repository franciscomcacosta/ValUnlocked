// /grabber — DMs the current email-grabber script + bookmarklet + how-to.
// Tier-gated: Standard or higher. Fetches from the `tools` table so updates
// don't require a bot restart.
import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";
import { createClient } from "@supabase/supabase-js";
import { getTool, tierMeets } from "../../lib/tools";
import { TIER_COLOR, tierLabel, type SubTier } from "../../lib/pricing";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false },
});

export const data = new SlashCommandBuilder()
  .setName("grabber")
  .setDescription("Get the Riot email grabber script (Standard+ only)");

export async function execute(interaction: ChatInputCommandInteraction) {
  await interaction.deferReply({ ephemeral: true });

  // Resolve user → sub tier.
  const { data: user } = await db
    .from("users")
    .select("id")
    .eq("discord_id", interaction.user.id)
    .maybeSingle();

  let tier: SubTier | null = null;
  if (user?.id) {
    const { data: sub } = await db
      .from("subscriptions")
      .select("tier")
      .eq("user_id", user.id)
      .in("status", ["active", "grace"])
      .maybeSingle();
    tier = (sub?.tier ?? null) as SubTier | null;
  }

  const tool = await getTool("email_grabber");
  if (!tool) {
    await interaction.editReply("Tool unavailable right now. Try again in a moment.");
    return;
  }

  if (!tierMeets(tier, tool.min_tier)) {
    await interaction.editReply({
      content: `🔒 The Email Grabber is for **${tierLabel(tool.min_tier)}** subscribers and above. Use \`/sub\` to upgrade.`,
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setColor(TIER_COLOR[tier!])
    .setTitle(`🔑 ${tool.display_name}`)
    .setDescription(tool.description ?? "")
    .addFields(
      { name: "Target site", value: tool.target_site ?? "—", inline: true },
      { name: "Version", value: `v${tool.version}`, inline: true }
    );

  const row = tool.target_site
    ? new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setLabel("Open target site").setStyle(ButtonStyle.Link).setURL(tool.target_site)
      )
    : null;

  // Discord truncates at 2000 chars per message. Script + bookmarklet + how-to
  // all fit comfortably, but send them as separate code blocks for easy copy.
  await interaction.editReply({
    embeds: [embed],
    components: row ? [row] : [],
  });

  await interaction.followUp({
    ephemeral: true,
    content: `**Console script** — paste into DevTools console:\n\`\`\`js\n${tool.script}\n\`\`\``,
  });

  if (tool.bookmarklet) {
    await interaction.followUp({
      ephemeral: true,
      content:
        `**Bookmarklet** — create a new bookmark, paste this as the URL:\n\`\`\`\n${tool.bookmarklet}\n\`\`\``,
    });
  }

  if (tool.instructions) {
    await interaction.followUp({
      ephemeral: true,
      content: tool.instructions,
    });
  }
}
