// Minimal Discord REST helpers so the web backend can DM buyers, log sales,
// and manage subscription roles without running the full bot process.
const API = "https://discord.com/api/v10";

function headers() {
  return {
    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
    "content-type": "application/json",
  };
}

export async function notifyDiscordUser(discordId: string, content: string) {
  const dm = await fetch(`${API}/users/@me/channels`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ recipient_id: discordId }),
  });
  if (!dm.ok) throw new Error(`open DM failed: ${dm.status}`);
  const { id } = await dm.json();
  await sendChannelMessage(id, content);
}

export async function sendChannelMessage(channelId: string, content: string) {
  const res = await fetch(`${API}/channels/${channelId}/messages`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) throw new Error(`send message failed: ${res.status}`);
}

// Private staff channel for sales and payments that need attention.
export async function logToStaff(content: string) {
  const ch = process.env.DISCORD_LOG_CHANNEL_ID;
  if (ch) await sendChannelMessage(ch, content).catch((e) => console.error("staff log failed", e));
}

// Public channel for drop announcements (optional — no-ops if unset).
export async function announceDrop(content: string) {
  const ch = process.env.DISCORD_DROPS_CHANNEL_ID;
  if (ch) await sendChannelMessage(ch, content).catch((e) => console.error("drop announce failed", e));
}

// ─── Role management ─────────────────────────────────────────────────

/**
 * Grant a role to a guild member. Bot must have Manage Roles permission
 * and its own role must be ABOVE the target role in the server hierarchy.
 */
export async function addGuildRole(discordId: string, roleId: string): Promise<void> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) throw new Error("DISCORD_GUILD_ID not set");
  const res = await fetch(
    `${API}/guilds/${guildId}/members/${discordId}/roles/${roleId}`,
    { method: "PUT", headers: headers() }
  );
  // 204 = success, 404 = user not in guild (fine, nothing to do)
  if (!res.ok && res.status !== 404) {
    throw new Error(`add role failed: ${res.status} ${await res.text()}`);
  }
}

export async function removeGuildRole(discordId: string, roleId: string): Promise<void> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) throw new Error("DISCORD_GUILD_ID not set");
  const res = await fetch(
    `${API}/guilds/${guildId}/members/${discordId}/roles/${roleId}`,
    { method: "DELETE", headers: headers() }
  );
  if (!res.ok && res.status !== 404) {
    throw new Error(`remove role failed: ${res.status} ${await res.text()}`);
  }
}

/**
 * Map a sub tier to its configured Discord role ID.
 */
import type { SubTier } from "./pricing";
export function roleIdForTier(tier: SubTier): string | undefined {
  return {
    standard: process.env.DISCORD_ROLE_STANDARD,
    premium:  process.env.DISCORD_ROLE_PREMIUM,
    ultra:    process.env.DISCORD_ROLE_ULTRA,
  }[tier];
}

/**
 * Set a user to exactly one tier role (removing the others).
 * Used when a sub starts, renews, or upgrades/downgrades.
 */
export async function setTierRole(discordId: string, tier: SubTier): Promise<void> {
  const want = roleIdForTier(tier);
  if (!want) throw new Error(`No role id configured for tier ${tier}`);

  const allRoles: Array<[SubTier, string | undefined]> = [
    ["standard", process.env.DISCORD_ROLE_STANDARD],
    ["premium",  process.env.DISCORD_ROLE_PREMIUM],
    ["ultra",    process.env.DISCORD_ROLE_ULTRA],
  ];

  // Add the wanted role first (so there's no brief window with no role),
  // then strip any other tier roles.
  await addGuildRole(discordId, want);
  await Promise.all(
    allRoles
      .filter(([t, id]) => id && t !== tier)
      .map(([, id]) => removeGuildRole(discordId, id!).catch((e) => console.error("strip tier role", e)))
  );
}

/**
 * Remove every tier role from a user (sub expired / cancelled).
 */
export async function clearTierRoles(discordId: string): Promise<void> {
  const ids = [
    process.env.DISCORD_ROLE_STANDARD,
    process.env.DISCORD_ROLE_PREMIUM,
    process.env.DISCORD_ROLE_ULTRA,
  ].filter(Boolean) as string[];
  await Promise.all(ids.map((id) => removeGuildRole(discordId, id).catch((e) => console.error("clear role", e))));
}
