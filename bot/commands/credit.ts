// /credit — admin-only. Add or remove store credit for a client.
//
//   /credit user:@someone amount:5        → +€5.00
//   /credit user:@someone amount:-2.5     → −€2.50 (never below €0)
//   /credit user:@someone amount:0        → just shows their balance
//
// Every change goes through add_credit, so it's in the credit ledger with
// a reason, and staff-log gets a line.
import {
  SlashCommandBuilder,
  EmbedBuilder,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from "discord.js";
import { db } from "../../lib/supabase";
import { logToStaff } from "../../lib/discord";
import { isAdmin, ensureUser } from "./grant";
import { BASE_URL } from "../base-url";

const eur = (c: number) => `€${(c / 100).toFixed(2)}`;

export const data = new SlashCommandBuilder()
  .setName("credit")
  .setDescription("Add or remove store credit for a client (admin only)")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addUserOption((o) => o.setName("user").setDescription("The client").setRequired(true))
  .addNumberOption((o) =>
    o.setName("amount").setDescription("Euros — e.g. 5 to add, -2.50 to remove, 0 to check").setRequired(true).setMinValue(-1000).setMaxValue(1000)
  )
  .addStringOption((o) => o.setName("reason").setDescription("Why (saved in the credit history)").setMaxLength(120))
  .addBooleanOption((o) => o.setName("dm").setDescription("DM them about it (default: yes when adding)"));

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!isAdmin(interaction.user.id)) {
    await interaction.reply({ content: "Admins only.", ephemeral: true });
    return;
  }
  const target = interaction.options.getUser("user", true);
  const cents = Math.round(interaction.options.getNumber("amount", true) * 100);
  const reason = interaction.options.getString("reason")?.trim() || null;
  if (target.bot) {
    await interaction.reply({ content: "Bots don't have credit.", ephemeral: true });
    return;
  }
  await interaction.deferReply({ ephemeral: true });

  const userId = await ensureUser(target.id, target.username);
  const { data: before } = await db.from("users").select("credit_cents").eq("id", userId).single();
  const balance = (before?.credit_cents as number) ?? 0;

  if (cents === 0) {
    await interaction.editReply(`<@${target.id}> has **${eur(balance)}** credit.`);
    return;
  }

  // Removing more than they have → take it down to €0, not below.
  const delta = cents < 0 ? -Math.min(balance, -cents) : cents;
  if (delta === 0) {
    await interaction.editReply(`<@${target.id}> already has €0.00 credit — nothing to remove.`);
    return;
  }

  const { error } = await db.rpc("add_credit", {
    p_user_id: userId,
    p_cents: delta,
    p_reason: `admin:${interaction.user.username}${reason ? `: ${reason}` : ""}`.slice(0, 200),
    p_order_id: null,
  });
  if (error) {
    await interaction.editReply(`Couldn't change credit: ${error.message}`);
    return;
  }
  const { data: after } = await db.from("users").select("credit_cents").eq("id", userId).single();
  const now = (after?.credit_cents as number) ?? balance + delta;
  const capped = cents < 0 && -cents > -delta;

  const dm = interaction.options.getBoolean("dm") ?? delta > 0;
  let dmNote = "";
  if (dm) {
    const ok = await interaction.client.users
      .send(
        target.id,
        delta > 0
          ? `💳 **${eur(delta)}** store credit was added to your Val Unlocked account${reason ? ` (${reason})` : ""}.\n` +
              `Your balance is now **${eur(now)}** — spend it on any account: ${BASE_URL}`
          : `💳 **${eur(-delta)}** was removed from your Val Unlocked credit${reason ? ` (${reason})` : ""}. Your balance is now **${eur(now)}**.`
      )
      .then(() => true, () => false);
    dmNote = ok ? " · DM sent" : " · couldn't DM them (DMs closed)";
  }

  const sign = delta > 0 ? "+" : "−";
  await logToStaff(
    `💳 ${interaction.user.username} ${delta > 0 ? "added" : "removed"} ${eur(Math.abs(delta))} credit ${delta > 0 ? "to" : "from"} <@${target.id}>` +
      `${reason ? ` — ${reason}` : ""} · balance ${eur(balance)} → ${eur(now)}`
  ).catch(() => {});

  const embed = new EmbedBuilder()
    .setColor(delta > 0 ? 0x4ade80 : 0xff4655)
    .setTitle(`${sign}${eur(Math.abs(delta))} credit`)
    .setDescription(
      `<@${target.id}> · **${eur(balance)} → ${eur(now)}**` +
        (reason ? `\nReason: ${reason}` : "") +
        (capped ? `\n⚠️ They only had ${eur(balance)}, so I removed that much (balance can't go below €0).` : "") +
        dmNote
    );
  await interaction.editReply({ embeds: [embed] });
}
