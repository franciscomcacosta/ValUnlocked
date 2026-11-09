// /syncroles — admin-only. Gives every active member the Discord role for
// their plan (and strips the other tier roles). Use after granting plans
// by hand in the database, or if someone lost their role.
import { SlashCommandBuilder, PermissionFlagsBits, type ChatInputCommandInteraction } from "discord.js";
import { db } from "../../lib/supabase";
import { setTierRole } from "../../lib/discord";
import type { SubTier } from "../../lib/pricing";
import { isAdmin } from "./grant";

export const data = new SlashCommandBuilder()
  .setName("syncroles")
  .setDescription("Give every active member the role for their plan (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "Admins only.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const { data, error } = await db
    .from("subscriptions")
    .select("tier, users(discord_id)")
    .in("status", ["active", "grace"]);
  if (error) throw error;

  let ok = 0;
  const failed: string[] = [];
  for (const row of data ?? []) {
    const discordId = (row.users as unknown as { discord_id: string } | null)?.discord_id;
    if (!discordId) continue;
    try {
      await setTierRole(discordId, row.tier as SubTier);
      ok++;
    } catch (e) {
      failed.push(`<@${discordId}>: ${(e as Error).message.slice(0, 120)}`);
    }
  }
  await interaction.editReply(
    `Synced **${ok}** member role${ok === 1 ? "" : "s"}.` + (failed.length ? `\n⚠️ Failed:\n${failed.slice(0, 10).join("\n")}` : "")
  );
}
