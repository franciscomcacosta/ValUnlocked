// Every buyer-facing Discord DM, as embeds with fields + link buttons.
//
// Links go in BUTTONS, not in the message text: Discord would otherwise try
// to preview valunlock.online, get bounced to the Discord login (the site is
// login-only) and show a big "Discord – Group Chat" card under the message.
//
// Credentials always sit in their own fields, in `code` style, so they're
// easy to spot and copy (long-press on mobile).
import type { DiscordMessage } from "./discord";
import { tierLabel, type SubTier } from "./pricing";

// ─── look & feel ─────────────────────────────────────────────────────

export const COLOR = {
  brand: 0xff4655,   // Valorant red
  ok: 0x22c55e,      // green
  warn: 0xf59e0b,    // amber
  bad: 0xef4444,     // red
  info: 0x3b82f6,    // blue
  gold: 0xffd400,    // credit
} as const;
const TIER_COLOR: Record<SubTier, number> = { standard: 0x9aa5b1, premium: 0xd1548d, ultra: 0xfad663 };
const TIER_EMOJI: Record<SubTier, string> = { standard: "🎟️", premium: "💎", ultra: "👑" };

const base = () => process.env.PUBLIC_BASE_URL ?? "https://valunlock.online";
const orderUrl = (orderId: string) => `${base()}/orders/${orderId}`;
export const orderRef = (orderId: string) => `VU-${orderId.slice(0, 8).toUpperCase()}`;
const eur = (c: number) => `€${(c / 100).toFixed(2)}`;
const ts = (d: Date | number) => Math.floor((typeof d === "number" ? d : d.getTime()) / 1000);

const REGION: Record<string, string> = {
  EU: "Europe", NA: "North America", AP: "Asia Pacific", KR: "Korea", LATAM: "Latin America", BR: "Brazil",
};
/** "SILVER 2" → "Silver 2", "N/A" / empty → "Unranked". */
function nice(rank: string | null | undefined): string {
  const s = (rank ?? "").trim();
  if (!s || s.toUpperCase() === "N/A") return "Unranked";
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
/** Inline code that survives backticks in passwords. */
const code = (v: string) => (v.includes("`") ? `\`\` ${v} \`\`` : `\`${v}\``);
const clip = (s: string, n = 1000) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

type Field = { name: string; value: string; inline?: boolean };
type Button = { label: string; url: string };

/** One embed + up to 5 link buttons. Empty fields are dropped. */
function card(o: {
  title: string;
  color: number;
  description?: string;
  fields?: Array<Field | null | false | undefined>;
  orderId?: string;
  buttons?: Button[];
}): DiscordMessage {
  const fields = (o.fields ?? []).filter((f): f is Field => !!f && !!f.value).map((f) => ({ ...f, value: clip(f.value) }));
  const btns = (o.buttons ?? []).slice(0, 5);
  return {
    embeds: [
      {
        title: o.title,
        color: o.color,
        ...(o.description ? { description: clip(o.description, 3500) } : {}),
        ...(fields.length ? { fields } : {}),
        footer: { text: o.orderId ? `Val Unlocked · Order ${orderRef(o.orderId)}` : "Val Unlocked" },
        timestamp: new Date().toISOString(),
      },
    ],
    ...(btns.length
      ? { components: [{ type: 1, components: btns.map((b) => ({ type: 2, style: 5, label: b.label, url: b.url })) }] }
      : {}),
  };
}

const openOrder = (orderId: string): Button => ({ label: "Open order", url: orderUrl(orderId) });
const openShop = (): Button => ({ label: "Open the shop", url: base() });

/** Login / password / email fields for any delivered account. */
function credFields(
  c: { login: string; password: string; email?: string | null; emailPassword?: string | null },
  emailPending = false
): Field[] {
  return [
    { name: "Login", value: code(c.login), inline: true },
    { name: "Password", value: code(c.password), inline: true },
    c.email
      ? { name: "Recovery email", value: code(c.email), inline: !!c.emailPassword }
      : { name: "Recovery email", value: emailPending ? "⏳ Coming in a second message (about a minute)" : "On the order page", inline: false },
    ...(c.email && c.emailPassword ? [{ name: "Email password", value: code(c.emailPassword), inline: true }] : []),
  ];
}
const changePasswords: Field = { name: "🔐 First thing", value: "Change the account **and** email passwords.", inline: false };

// ─── orders ──────────────────────────────────────────────────────────

/** "Your account is ready" — qvsp account with its stats. */
export function accountReadyMessage(o: {
  orderId: string;
  region: string;
  skins: number;
  peak: string | null;
  login: string;
  password: string;
  email: string | null;      // null → email arrives in a second DM
  verified: boolean;         // we already tested the login ourselves
}): DiscordMessage {
  return card({
    title: "✅ Your account is ready",
    color: o.verified ? COLOR.ok : COLOR.brand,
    description: `**${REGION[o.region.toUpperCase()] ?? o.region}** · **${o.skins} skins** · Peak **${nice(o.peak)}**`,
    fields: [
      ...credFields({ login: o.login, password: o.password, email: o.email }, !o.email),
      o.verified
        ? { name: "✔️ Tested", value: "We logged in to this account ourselves — it works." }
        : {
            name: "⏱️ Test it now — you have 10 minutes",
            value:
              "Log in straight away. If anything's wrong (wrong password, banned, asks for a code), open the order and press " +
              "**\"No, there's a problem\"** to get a replacement or your money back.",
          },
      changePasswords,
    ],
    orderId: o.orderId,
    buttons: [openOrder(o.orderId)],
  });
}

/** "Your order is ready" — legacy own-stock items (no account stats). */
export function orderReadyMessage(o: { orderId: string; productName: string; login: string | null; password: string | null }): DiscordMessage {
  return card({
    title: "✅ Your order is ready",
    color: COLOR.brand,
    description: `**${o.productName}**`,
    fields: [...(o.login && o.password ? credFields({ login: o.login, password: o.password }) : []), changePasswords],
    orderId: o.orderId,
    buttons: [openOrder(o.orderId)],
  });
}

/** Second DM: the recovery email pulled by the worker. */
export function emailReadyMessage(o: { orderId: string; email: string; login: string | null }): DiscordMessage {
  return card({
    title: "✉️ Recovery email ready",
    color: COLOR.ok,
    fields: [
      o.login ? { name: "Account", value: code(o.login), inline: true } : null,
      { name: "Recovery email", value: code(o.email), inline: true },
    ],
    orderId: o.orderId,
    buttons: [openOrder(o.orderId)],
  });
}

/** Second DM when the worker couldn't pull the email. */
export function emailDelayedMessage(o: { orderId: string }): DiscordMessage {
  return card({
    title: "⏳ Recovery email coming soon",
    color: COLOR.warn,
    description:
      "We couldn't pull the recovery email automatically this time. Staff have been pinged and will add it to your order shortly.\n\n" +
      "Your login and password already work — go ahead and use them.",
    orderId: o.orderId,
    buttons: [openOrder(o.orderId)],
  });
}

/** Paid, but buying the account from the supplier failed. */
export function deliveryDelayedMessage(o: { orderId: string }): DiscordMessage {
  return card({
    title: "⏳ Your order is taking a little longer",
    color: COLOR.warn,
    description:
      "Your payment came through, but we hit a snag delivering your account. Staff have been alerted and will sort it out in a few minutes — " +
      "you'll get another message here as soon as it's ready.",
    orderId: o.orderId,
    buttons: [openOrder(o.orderId)],
  });
}

/** The account sold out mid-payment → refunded to credit. */
export function soldOutRefundMessage(o: { orderId: string; itemName: string; refundCents: number; balanceCents: number | null }): DiscordMessage {
  return card({
    title: "💸 Sold out — you've been refunded",
    color: COLOR.gold,
    description: `Sorry — the last **${o.itemName}** account sold out the moment you paid, and there was no matching one left.`,
    fields: [
      { name: "Refunded to credit", value: `**${eur(o.refundCents)}**`, inline: true },
      o.balanceCents != null ? { name: "Your balance", value: eur(o.balanceCents), inline: true } : null,
      { name: "What now?", value: "Your credit is ready to spend on any other account." },
    ],
    orderId: o.orderId,
    buttons: [openShop()],
  });
}

/** A free gift sold out mid-delivery → claim again. */
export function giftSoldOutMessage(o: { itemName: string }): DiscordMessage {
  return card({
    title: "🎁 Your free account is still waiting",
    color: COLOR.warn,
    description:
      `Sorry — that free **${o.itemName}** account sold out the moment it was being delivered.\n\n` +
      "**Your free account is still yours** — pick a region and claim it again.",
    buttons: [{ label: "Claim free account", url: `${base()}/?claim=gift` }],
  });
}

/** Staff refunded an order to credit (admin panel). */
export function orderRefundedMessage(o: { orderId: string; refundCents: number; balanceCents: number; reason?: string | null }): DiscordMessage {
  return card({
    title: "💛 Order refunded",
    color: COLOR.gold,
    fields: [
      { name: "Refunded to credit", value: `**${eur(o.refundCents)}**`, inline: true },
      { name: "Your balance", value: eur(o.balanceCents), inline: true },
      o.reason ? { name: "Reason", value: o.reason } : null,
    ],
    orderId: o.orderId,
    buttons: [openShop()],
  });
}

// ─── replacement claims ──────────────────────────────────────────────

/** Claim approved with a NEW account. */
export function replacementReadyMessage(o: {
  orderId: string;
  login: string;
  password: string;
  email?: string | null;
  emailPassword?: string | null;
  reasonLabel?: string | null;
}): DiscordMessage {
  return card({
    title: "🔁 Replacement approved — here's your new account",
    color: COLOR.ok,
    description: "We've swapped it into your order.",
    fields: [
      ...credFields({ login: o.login, password: o.password, email: o.email, emailPassword: o.emailPassword }),
      o.reasonLabel ? { name: "Your report", value: o.reasonLabel } : null,
      changePasswords,
    ],
    orderId: o.orderId,
    buttons: [openOrder(o.orderId)],
  });
}

/** Claim approved → refunded to credit + apology bonus. */
export function claimRefundMessage(o: {
  orderId: string;
  refundCents: number;
  bonusCents: number;
  balanceCents: number | null;
  reasonLabel?: string | null;
  note?: string | null;
}): DiscordMessage {
  return card({
    title: "💛 Report approved — you've been refunded",
    color: COLOR.ok,
    fields: [
      { name: "Refunded", value: eur(o.refundCents), inline: true },
      { name: "Apology bonus", value: `+${eur(o.bonusCents)}`, inline: true },
      { name: "Total credit", value: `**${eur(o.refundCents + o.bonusCents)}**`, inline: true },
      o.balanceCents != null ? { name: "Your new balance", value: eur(o.balanceCents), inline: true } : null,
      o.reasonLabel ? { name: "Your report", value: o.reasonLabel } : null,
      o.note ? { name: "Decision", value: o.note } : null,
      { name: "What now?", value: "Your credit is ready to spend on any account." },
    ],
    orderId: o.orderId,
    buttons: [openShop()],
  });
}

/** Claim on a FREE gift approved → claim a new free account. */
export function giftReissuedMessage(o: { orderId: string }): DiscordMessage {
  return card({
    title: "🎁 You get a brand-new free account",
    color: COLOR.ok,
    description: "Sorry that free account didn't work. Pick your region and claim a fresh one.",
    orderId: o.orderId,
    buttons: [{ label: "Claim free account", url: `${base()}/?claim=gift` }],
  });
}

/** Claim denied. */
export function claimDeniedMessage(o: { orderId: string; reasonLabel?: string | null; note?: string | null }): DiscordMessage {
  return card({
    title: "⛔ Report not approved",
    color: COLOR.bad,
    fields: [
      o.reasonLabel ? { name: "Your report", value: o.reasonLabel } : null,
      { name: "Decision", value: o.note || "The supplier reviewed your report and didn't approve it." },
      { name: "Think that's wrong?", value: "Open a ticket in our Discord and staff will take a look." },
    ],
    orderId: o.orderId,
    buttons: [openOrder(o.orderId)],
  });
}

// ─── credit ──────────────────────────────────────────────────────────

export function creditChangedMessage(o: { deltaCents: number; balanceCents: number; reason?: string | null }): DiscordMessage {
  const added = o.deltaCents > 0;
  return card({
    title: added ? "💳 Credit added" : "💳 Credit removed",
    color: added ? COLOR.gold : COLOR.warn,
    fields: [
      { name: added ? "Added" : "Removed", value: `**${added ? "+" : "−"}${eur(Math.abs(o.deltaCents))}**`, inline: true },
      { name: "Your balance", value: eur(o.balanceCents), inline: true },
      o.reason ? { name: "Reason", value: o.reason } : null,
    ],
    buttons: added ? [openShop()] : [],
  });
}

// ─── memberships ─────────────────────────────────────────────────────

/** Plan given by staff (/grant, admin panel) or gifted by someone (/gift). */
export function planGrantedMessage(o: { tier: SubTier; end: Date; giftedBy?: string | null }): DiscordMessage {
  return card({
    title: `${TIER_EMOJI[o.tier]} ${o.giftedBy ? "You've been gifted" : "You've been given"} ${tierLabel(o.tier)}`,
    color: TIER_COLOR[o.tier],
    description: o.giftedBy ? `**${o.giftedBy}** gifted you a **${tierLabel(o.tier)}** membership. 🎉` : undefined,
    fields: [
      { name: "Plan", value: `**${tierLabel(o.tier)}**`, inline: true },
      { name: "Active until", value: `<t:${ts(o.end)}:D> (<t:${ts(o.end)}:R>)`, inline: true },
      { name: "Perks", value: "Your discount, early access and perks are live now." },
    ],
    buttons: [openShop()],
  });
}

/** Paid subscription is active (new or renewed). */
export function subActiveMessage(o: { tier: SubTier; end: Date; creditCents: number; renewed: boolean }): DiscordMessage {
  return card({
    title: `${TIER_EMOJI[o.tier]} ${tierLabel(o.tier)} ${o.renewed ? "renewed" : "activated"}`,
    color: TIER_COLOR[o.tier],
    fields: [
      { name: "Plan", value: `**${tierLabel(o.tier)}**`, inline: true },
      { name: "Active until", value: `<t:${ts(o.end)}:D>`, inline: true },
      o.creditCents > 0 ? { name: "Monthly credit", value: `**+${eur(o.creditCents)}** — used automatically on your next purchase` } : null,
      { name: "Perks", value: "New perks are unlocked in the Discord." },
    ],
    buttons: [openShop()],
  });
}

/** Free welcome account that comes with a first Standard month. */
export function welcomeAccountMessage(): DiscordMessage {
  return card({
    title: "🎁 Your FREE account is waiting",
    color: COLOR.gold,
    description: "Your first **Standard** month comes with a **free 26–50 skins account**. Pick your region and claim it.",
    buttons: [{ label: "Claim free account", url: `${base()}/?claim=welcome` }],
  });
}

export function subGraceMessage(o: { tier: SubTier; graceEnd: Date }): DiscordMessage {
  return card({
    title: `⚠️ Your ${tierLabel(o.tier)} plan has expired`,
    color: COLOR.warn,
    description: "You're in a **48-hour grace period** — renew now to keep your role and perks.",
    fields: [{ name: "Grace period ends", value: `<t:${ts(o.graceEnd)}:R> (<t:${ts(o.graceEnd)}:f>)` }],
    buttons: [{ label: "Renew now", url: `${base()}/account` }],
  });
}

export function subEndedMessage(o: { tier: SubTier }): DiscordMessage {
  return card({
    title: `❌ Your ${tierLabel(o.tier)} plan has ended`,
    color: COLOR.bad,
    description: "Your role and perks have been removed. You can resubscribe any time.",
    buttons: [{ label: "Resubscribe", url: `${base()}/account` }],
  });
}

export function subReminderMessage(o: { tier: SubTier; which: "7d" | "3d" | "1d"; end: Date; invoiceUrl: string }): DiscordMessage {
  const title =
    o.which === "7d" ? `⏰ Your ${tierLabel(o.tier)} plan renews in 7 days`
    : o.which === "3d" ? `⏰ 3 days left on your ${tierLabel(o.tier)} plan`
    : `⚠️ Your ${tierLabel(o.tier)} plan ends tomorrow`;
  return card({
    title,
    color: o.which === "1d" ? COLOR.warn : TIER_COLOR[o.tier],
    description: "Keep your discount and perks — renew with crypto in one click.",
    fields: [{ name: "Ends", value: `<t:${ts(o.end)}:D> (<t:${ts(o.end)}:R>)` }],
    buttons: [{ label: "Renew now", url: o.invoiceUrl }],
  });
}

// ─── referrals ───────────────────────────────────────────────────────

export function referralJoinedMessage(o: { friendName: string; rewardCents: number }): DiscordMessage {
  return card({
    title: "👋 A friend joined with your invite",
    color: COLOR.info,
    fields: [
      { name: "Friend", value: o.friendName, inline: true },
      { name: "You'll get", value: `${eur(o.rewardCents)} after their first purchase`, inline: true },
    ],
  });
}

export function referralRewardMessage(o: { friendName: string; rewardCents: number }): DiscordMessage {
  return card({
    title: "🎉 You earned referral credit",
    color: COLOR.gold,
    fields: [
      { name: "Friend", value: `${o.friendName} made their first purchase` },
      { name: "Added to your credit", value: `**+${eur(o.rewardCents)}**`, inline: true },
    ],
    buttons: [{ label: "Invite more friends", url: base() }],
  });
}

export function referralWelcomeMessage(o: { friendCents: number }): DiscordMessage {
  return card({
    title: "🎁 Bonus credit for joining through a friend",
    color: COLOR.gold,
    fields: [{ name: "Added to your credit", value: `**+${eur(o.friendCents)}**`, inline: true }],
    buttons: [openShop()],
  });
}

// ─── staff ───────────────────────────────────────────────────────────

/** Free-text DM written by staff in the admin panel. */
export function staffMessage(o: { text: string }): DiscordMessage {
  return card({ title: "✉️ Message from Val Unlocked", color: COLOR.brand, description: o.text });
}
