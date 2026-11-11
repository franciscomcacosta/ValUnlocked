// Vouches (buyer ratings).
//
// The site's ops job DMs buyers "⭐ How was your account?" with five buttons
// (customId "vouch:<orderId>:<stars>") once the 10-minute test window has
// passed without a problem report. Here:
//   button  → opens a short modal for an optional comment
//   modal   → saves the rating; 4–5 stars are posted to VOUCH_CHANNEL_ID,
//             1–3 stars go to the staff log instead
//   /vouch  → shows the shop's average rating
//
// Env: VOUCH_CHANNEL_ID  (the public #vouches channel)
import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from "discord.js";
import { db } from "../../lib/supabase";
import { logToStaff } from "../../lib/discord";
import { accountSummary } from "../../lib/discord-messages";
import { BASE_URL } from "../base-url";

const GOLD = 0xffd400;
const stars = (n: number) => "⭐".repeat(n);

export const data = new SlashCommandBuilder()
  .setName("vouch")
  .setDescription("See Val Unlocked's rating from verified buyers");

export async function execute(interaction: ChatInputCommandInteraction) {
  const { data: rows } = await db.from("vouches").select("stars");
  const list = rows ?? [];
  const avg = list.length ? list.reduce((s, r) => s + (r.stars as number), 0) / list.length : 0;
  const five = list.filter((r) => r.stars === 5).length;
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(list.length ? `${avg.toFixed(1)} / 5 ${stars(Math.round(avg))}` : "No ratings yet")
    .setDescription(
      list.length
        ? `From **${list.length}** verified purchase${list.length === 1 ? "" : "s"} · **${five}** gave 5 stars.`
        : "Ratings appear here after buyers rate their accounts."
    )
    .setFooter({ text: "Only buyers can rate · Val Unlocked" });
  await interaction.reply({ embeds: [embed] });
}

/** Loads the order and checks the clicker is its buyer. */
async function ownOrder(orderId: string, discordUserId: string) {
  const { data: order } = await db
    .from("orders")
    .select("id, user_id, status, users(discord_id)")
    .eq("id", orderId)
    .maybeSingle();
  const did = (order?.users as unknown as { discord_id?: string } | null)?.discord_id;
  if (!order || did !== discordUserId) return null;
  return order as { id: string; user_id: string; status: string };
}

function parse(customId: string): { orderId: string; n: number } | null {
  const [, orderId, raw] = customId.split(":");
  const n = parseInt(raw ?? "", 10);
  if (!orderId || !(n >= 1 && n <= 5)) return null;
  return { orderId, n };
}

export async function handleButton(interaction: ButtonInteraction) {
  const p = parse(interaction.customId);
  if (!p) return;
  const order = await ownOrder(p.orderId, interaction.user.id);
  if (!order) {
    await interaction.reply({ content: "This rating button isn't for your account.", ephemeral: true });
    return;
  }
  const { data: existing } = await db.from("vouches").select("stars").eq("order_id", p.orderId).maybeSingle();
  if (existing) {
    await interaction.reply({ content: `You already rated this order ${stars(existing.stars as number)} — thank you!`, ephemeral: true });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`vouch:${p.orderId}:${p.n}`)
    .setTitle(`${stars(p.n)} — thanks!`)
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("comment")
          .setLabel(p.n >= 4 ? "Anything to add? (optional)" : "What went wrong? (optional)")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(false)
          .setMaxLength(300)
          .setPlaceholder(p.n >= 4 ? "e.g. fast delivery, great skins" : "Tell us so we can fix it")
      )
    );
  await interaction.showModal(modal);
}

export async function handleModal(interaction: ModalSubmitInteraction) {
  const p = parse(interaction.customId);
  if (!p) return;
  const order = await ownOrder(p.orderId, interaction.user.id);
  if (!order) {
    await interaction.reply({ content: "This rating isn't for your account.", ephemeral: true });
    return;
  }
  const comment = interaction.fields.getTextInputValue("comment")?.trim().slice(0, 300) || null;

  const { error } = await db.from("vouches").insert({ order_id: p.orderId, user_id: order.user_id, stars: p.n, comment });
  if (error) {
    const dup = /duplicate|unique/i.test(error.message);
    await interaction.reply({ content: dup ? "You already rated this order — thank you!" : "Couldn't save your rating, try again.", ephemeral: true });
    return;
  }

  const { data: acct } = await db.from("qvsp_stock").select("region, skin_count").eq("claimed_order_id", p.orderId).maybeSingle();
  const summary = accountSummary(acct?.region as string | undefined, acct?.skin_count as number | undefined, "Valorant account");

  if (p.n >= 4) {
    const channelId = process.env.VOUCH_CHANNEL_ID;
    if (channelId) {
      try {
        const ch = await interaction.client.channels.fetch(channelId);
        if (ch && ch.isTextBased() && "send" in ch) {
          const embed = new EmbedBuilder()
            .setColor(GOLD)
            .setTitle(stars(p.n))
            .setDescription(comment ? `> ${comment.replace(/\n/g, "\n> ")}` : null)
            .addFields(
              { name: "Buyer", value: `<@${interaction.user.id}>`, inline: true },
              { name: "Bought", value: summary, inline: true }
            )
            .setThumbnail(interaction.user.displayAvatarURL({ size: 128 }))
            .setFooter({ text: "✔ Verified purchase · Val Unlocked" })
            .setTimestamp();
          await ch.send({
            embeds: [embed],
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setStyle(ButtonStyle.Link).setLabel("Open the shop").setURL(BASE_URL)
              ),
            ],
            allowedMentions: { parse: [] },
          });
          await db.from("vouches").update({ posted: true }).eq("order_id", p.orderId);
        }
      } catch (e) {
        console.error("[vouch] post failed", e);
      }
    }
  } else {
    await logToStaff(
      `📉 ${stars(p.n)} rating from <@${interaction.user.id}> (order VU-${p.orderId.slice(0, 8).toUpperCase()} · ${summary})` +
        (comment ? `: "${comment}"` : " — no comment.")
    ).catch(() => {});
  }

  const thanks = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`Thanks for rating ${stars(p.n)}`)
    .setDescription(
      p.n >= 4
        ? "Glad you liked it! Your rating was shared in #vouches."
        : "Sorry it wasn't great — staff have seen your feedback. If something's broken, open a ticket in our Discord."
    )
    .setFooter({ text: `Val Unlocked · Order VU-${p.orderId.slice(0, 8).toUpperCase()}` });

  if (interaction.isFromMessage()) await interaction.update({ embeds: [thanks], components: [] });
  else await interaction.reply({ embeds: [thanks], ephemeral: true });
}
