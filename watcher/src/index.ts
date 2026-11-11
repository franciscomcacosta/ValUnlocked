// Val Unlocked — qvsp stock watcher.
//
// Every ~15 s: fetch qvsp's skinned stock for each region, compare with the
// previous pass, and write ONLY the differences to Supabase:
//   • new listing id          → restock: inserted (DB default public_at =
//                               now + 2h gives Premium its early access)
//   • listing id disappeared  → sold elsewhere / pulled: removed_at = now
//   • price or details changed → updated
// Then one compact summary is broadcast on Supabase Realtime channel
// "stock" so open dashboards refresh instantly.
//
// Safety:
//   • a region whose fetch fails is skipped entirely (no removals from it)
//   • a region that suddenly comes back EMPTY is only cleared after two
//     empty passes in a row (guards against a qvsp glitch hiding stock)
//   • reserved / claimed rows (our own in-flight orders) are never touched
//   • on 429 / errors the interval backs off up to 2 min, then recovers
//
// Env (Fly secrets):
//   QVSP_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
//   QVSP_API_BASE            default https://nfa.qvsp.net/partner/v1
//   INTERVAL_MS              default 15000
//   DISCORD_BOT_TOKEN, DISCORD_LOG_CHANNEL_ID   optional daily heartbeat
//   RESTOCK_CHANNEL_ID       Discord channel for RESTOCK announcements
//                            (default 1520260513735639182; needs DISCORD_BOT_TOKEN)
//   RESTOCK_MIN              listings needed to count as a big restock (default 25)

import { createClient } from "@supabase/supabase-js";

const QVSP_BASE = process.env.QVSP_API_BASE ?? "https://nfa.qvsp.net/partner/v1";
const QVSP_KEY = process.env.QVSP_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BASE_INTERVAL = Math.max(10_000, parseInt(process.env.INTERVAL_MS ?? "15000", 10) || 15_000);
const MAX_INTERVAL = 120_000;
const REGIONS = ["eu", "na", "ap", "kr", "latam", "br"] as const;

if (!QVSP_KEY || !SUPABASE_URL || !SERVICE_KEY) {
  console.error("[watcher] missing QVSP_API_KEY / SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// ─── qvsp ──────────────────────────────────────────────────────────────

interface QvspItem {
  id: string;
  kind: string;
  region: string;
  level: number;
  peak: string;
  rank: string;
  price: number;
  skin_count?: number;
  skins?: string[];
  buddies?: string[];
  vp?: number;
  vp_value?: number;
  last_played?: string;
  added_epoch?: number;
}

class HttpError extends Error {
  constructor(public status: number, msg: string) { super(msg); }
}

async function fetchRegion(region: string): Promise<QvspItem[]> {
  const res = await fetch(`${QVSP_BASE}/stock?kind=skinned&region=${region}`, {
    headers: { authorization: `Bearer ${QVSP_KEY}` },
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  if (!res.ok) throw new HttpError(res.status, text.slice(0, 160));
  const body = JSON.parse(text) as { ok?: boolean; items?: QvspItem[] };
  if (body.ok === false || !Array.isArray(body.items)) throw new HttpError(res.status, "bad_body");
  return body.items;
}

// ─── row mapping (mirrors app/api/cron/sync-qvsp) ───────────────────────

const BRACKETS = [
  { min: 1, max: 25, cents: 499 },
  { min: 26, max: 50, cents: 699 },
  { min: 51, max: 100, cents: 1199 },
  { min: 101, max: 150, cents: 1799 },
  { min: 151, max: 200, cents: 2299 },
  { min: 201, max: 99_999, cents: 2799 },
];
const bracketCents = (n: number) => (BRACKETS.find((b) => n >= b.min && n <= b.max) ?? BRACKETS[0]).cents;
const normalizeRank = (raw?: string | null) => {
  const s = (raw ?? "").trim().toLowerCase();
  return !s || s === "n/a" ? "unranked" : s;
};

function toRow(item: QvspItem, now: string) {
  return {
    qvsp_id: item.id,
    kind: item.kind,
    region: item.region,
    level: item.level,
    peak: item.peak,
    rank: item.rank,
    rank_normalized: normalizeRank(item.rank),
    qvsp_price_cents: Math.round(item.price * 100),
    public_price_cents: bracketCents(item.skin_count ?? 0),
    skin_count: item.skin_count ?? 0,
    skins: item.skins ?? [],
    buddies: item.buddies ?? [],
    vp: item.vp ?? null,
    vp_value_cents: item.vp_value != null ? Math.round(item.vp_value) : null,
    last_played: item.last_played ?? null,
    added_epoch: item.added_epoch ?? null,
    last_synced_at: now,
    removed_at: null,          // a re-listed account becomes visible again
  };
}

// What counts as "changed" for an existing listing.
const fingerprint = (r: { qvsp_price_cents: number; skin_count: number | null; vp: number | null; level: number | null; peak: string | null; rank_normalized: string | null }) =>
  [r.qvsp_price_cents, r.skin_count ?? 0, r.vp ?? "", r.level ?? "", r.peak ?? "", r.rank_normalized ?? ""].join("|");

// ─── skin tiers (for "New drop" toasts) ────────────────────────────────

const TIER_RANK: Record<string, number> = { Ultra: 5, Exclusive: 4, Premium: 3, Deluxe: 2, Select: 1 };
let skinTier = new Map<string, string>();
let tiersLoadedAt = 0;

async function loadSkinTiers() {
  if (Date.now() - tiersLoadedAt < 24 * 3600_000 && skinTier.size) return;
  try {
    const [skins, tiers] = await Promise.all([
      fetch("https://valorant-api.com/v1/weapons/skins").then((r) => r.json()),
      fetch("https://valorant-api.com/v1/contenttiers").then((r) => r.json()),
    ]);
    const tierName = new Map<string, string>((tiers.data as Array<{ uuid: string; devName: string }>).map((t) => [t.uuid, t.devName]));
    const m = new Map<string, string>();
    for (const s of skins.data as Array<{ displayName: string; contentTierUuid: string | null }>) {
      const t = s.contentTierUuid ? tierName.get(s.contentTierUuid) : null;
      if (t) m.set(s.displayName.toLowerCase(), t);
    }
    skinTier = m;
    tiersLoadedAt = Date.now();
  } catch (e) {
    console.warn("[watcher] skin tiers unavailable (toasts fall back to skin count)", String(e));
  }
}

const bareSkin = (raw: string) => raw.replace(/\s*\(\d+\s*Levels?(?:,\s*\d+\s*Variants?)?\)\s*$/i, "").trim();

/** The best skin on an account, for the "New drop · Reaver Vandal" toast. */
function headlineSkin(item: QvspItem): { skin: string; tier: string } | null {
  let best: { skin: string; tier: string; rank: number } | null = null;
  for (const raw of item.skins ?? []) {
    const name = bareSkin(raw);
    const tier = skinTier.get(name.toLowerCase());
    const rank = tier ? TIER_RANK[tier] ?? 0 : 0;
    if (rank >= 3 && (!best || rank > best.rank)) best = { skin: name, tier: tier!, rank };
  }
  return best ? { skin: best.skin, tier: best.tier } : null;
}

// ─── state ─────────────────────────────────────────────────────────────

type Known = { region: string; fp: string };
const known = new Map<string, Known>();
const emptyStreak = new Map<string, number>();
const stats = { passes: 0, added: 0, removed: 0, changed: 0, errors: 0, since: Date.now() };

async function loadKnown() {
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from("qvsp_stock")
      .select("qvsp_id, region, qvsp_price_cents, skin_count, vp, level, peak, rank_normalized")
      .eq("kind", "skinned")
      .is("removed_at", null)
      .order("qvsp_id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`load known: ${error.message}`);
    for (const r of data ?? []) known.set(r.qvsp_id, { region: String(r.region).toLowerCase(), fp: fingerprint(r) });
    if (!data || data.length < PAGE) break;
  }
  console.log(`[watcher] loaded ${known.size} live listings`);
}

// ─── one pass ──────────────────────────────────────────────────────────

let interval = BASE_INTERVAL;

async function pass() {
  const now = new Date().toISOString();
  const upserts: Array<ReturnType<typeof toRow> & { public_at?: string }> = [];
  const removedIds: string[] = [];
  const drops: Array<{ region: string; skin: string; tier: string; skins: number }> = [];
  const byRegion: Record<string, { added: number; removed: number }> = {};
  let failures = 0;
  let rateLimited = false;

  for (const region of REGIONS) {
    let items: QvspItem[];
    try {
      items = await fetchRegion(region);
    } catch (e) {
      failures++;
      if (e instanceof HttpError && e.status === 429) rateLimited = true;
      console.warn(`[watcher] ${region} fetch failed: ${e instanceof HttpError ? e.status : ""} ${String((e as Error).message).slice(0, 120)}`);
      continue;   // skip this region entirely this pass
    }

    const prevCount = [...known.values()].filter((k) => k.region === region).length;
    if (items.length === 0 && prevCount > 20) {
      const streak = (emptyStreak.get(region) ?? 0) + 1;
      emptyStreak.set(region, streak);
      if (streak < 2) {
        console.warn(`[watcher] ${region} came back empty (had ${prevCount}) — waiting one more pass before clearing`);
        continue;
      }
    } else {
      emptyStreak.set(region, 0);
    }

    const freshIds = new Set(items.filter((i) => i.kind === "skinned").map((i) => i.id));
    const goneIds: string[] = [];
    for (const [id, k] of known) if (k.region === region && !freshIds.has(id)) goneIds.push(id);

    // Resync guard: if most of a region's listings "disappear" at once,
    // qvsp has re-keyed its stock (or our mirror was stale) — it's the same
    // accounts, not a sell-out + mass restock. Treat the new ids as existing
    // stock: visible immediately (no 2h early-access window) and no
    // "New drop" broadcasts.
    const resync = prevCount > 20 && goneIds.length / prevCount >= 0.5;
    if (resync) console.warn(`[watcher] ${region}: ${goneIds.length}/${prevCount} ids changed — resync, not drops`);

    const reg = { added: 0, removed: 0 };
    for (const item of items) {
      if (item.kind !== "skinned") continue;
      const row = toRow(item, now);
      const prev = known.get(item.id);
      if (!prev) {
        upserts.push(resync ? { ...row, public_at: now } : row);
        if (!resync) {
          reg.added++;
          const h = headlineSkin(item);
          if (h) drops.push({ region: item.region, skin: h.skin, tier: h.tier, skins: item.skin_count ?? 0 });
        }
      } else if (prev.fp !== fingerprint(row)) {
        upserts.push(row);
        stats.changed++;
      }
    }
    for (const id of goneIds) {
      removedIds.push(id);
      if (!resync) reg.removed++;
    }
    if (reg.added || reg.removed) byRegion[region.toUpperCase()] = reg;
  }

  // Write the differences.
  for (let i = 0; i < upserts.length; i += 500) {
    const chunk = upserts.slice(i, i + 500);
    const { error } = await db.from("qvsp_stock").upsert(chunk, { onConflict: "qvsp_id" });
    if (error) throw new Error(`upsert: ${error.message}`);
  }
  for (let i = 0; i < removedIds.length; i += 300) {
    const chunk = removedIds.slice(i, i + 300);
    const { error } = await db
      .from("qvsp_stock")
      .update({ removed_at: now })
      .in("qvsp_id", chunk)
      .eq("claimed", false)
      .is("reserved_order_id", null);   // never touch our own in-flight orders
    if (error) throw new Error(`remove: ${error.message}`);
  }

  // Update memory only after the DB accepted the writes.
  for (const r of upserts) known.set(r.qvsp_id, { region: String(r.region).toLowerCase(), fp: fingerprint(r) });
  for (const id of removedIds) known.delete(id);

  const added = Object.values(byRegion).reduce((a, r) => a + r.added, 0);
  const removed = Object.values(byRegion).reduce((a, r) => a + r.removed, 0);
  stats.passes++;
  stats.added += added;
  stats.removed += removed;

  if (added || removed || upserts.length) {
    await broadcast({
      at: now,
      added,
      removed,
      changed: upserts.length - added,
      byRegion,
      drops: drops
        .sort((a, b) => (TIER_RANK[b.tier] ?? 0) - (TIER_RANK[a.tier] ?? 0) || b.skins - a.skins)
        .slice(0, 6),
    });
  }
  if (added || removed) console.log(`[watcher] +${added} −${removed} ~${upserts.length - added}`);
  if (added) noteRestock(byRegion, drops);

  // Pace: back off on rate limits / total failure, recover on success.
  if (rateLimited || failures === REGIONS.length) interval = Math.min(interval * 2, MAX_INTERVAL);
  else interval = BASE_INTERVAL;
  if (failures) stats.errors++;
}

// ─── realtime broadcast ────────────────────────────────────────────────

async function broadcast(payload: unknown) {
  try {
    const res = await fetch(`${SUPABASE_URL}/realtime/v1/api/broadcast`, {
      method: "POST",
      headers: { apikey: SERVICE_KEY!, authorization: `Bearer ${SERVICE_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ topic: "stock", event: "changes", payload, private: false }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) console.warn(`[watcher] broadcast ${res.status}: ${(await res.text()).slice(0, 120)}`);
  } catch (e) {
    console.warn("[watcher] broadcast failed", String(e));
  }
}

// ─── RESTOCK announcements ─────────────────────────────────────────────
// A big restock usually lands over several passes, so new listings are
// collected into one burst. The burst is announced once it has been quiet
// for QUIET_MS (or MAX_BURST_MS has passed), if it reached RESTOCK_MIN.
// Resync passes (qvsp re-keying ids) never count — they aren't new stock.

const RESTOCK_CHANNEL_ID = process.env.RESTOCK_CHANNEL_ID ?? "1520260513735639182";
const RESTOCK_MIN = Math.max(1, parseInt(process.env.RESTOCK_MIN ?? "25", 10) || 25);
const QUIET_MS = 90_000;
const MAX_BURST_MS = 10 * 60_000;
const EARLY_ACCESS_MS = 2 * 3600_000;   // matches the DB default for public_at
const REGION_NAME: Record<string, string> = { EU: "Europe", AP: "Asia Pacific", KR: "Korea", LATAM: "Latin America", BR: "Brazil", NA: "North America" };

type Burst = {
  startedAt: number;
  lastAt: number;
  byRegion: Record<string, number>;
  drops: Array<{ region: string; skin: string; tier: string; skins: number }>;
};
let burst: Burst | null = null;

function noteRestock(
  byRegion: Record<string, { added: number; removed: number }>,
  drops: Array<{ region: string; skin: string; tier: string; skins: number }>
) {
  const now = Date.now();
  if (!burst) burst = { startedAt: now, lastAt: now, byRegion: {}, drops: [] };
  burst.lastAt = now;
  for (const [r, c] of Object.entries(byRegion)) if (c.added) burst.byRegion[r] = (burst.byRegion[r] ?? 0) + c.added;
  burst.drops.push(...drops);
}

async function maybeAnnounceRestock() {
  if (!burst) return;
  const now = Date.now();
  const settled = now - burst.lastAt >= QUIET_MS || now - burst.startedAt >= MAX_BURST_MS;
  if (!settled) return;
  const b = burst;
  burst = null;
  const total = Object.values(b.byRegion).reduce((a, n) => a + n, 0);
  if (total < RESTOCK_MIN) return;
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return;

  // Regular buyers get access 2 h after the first listing of the burst landed.
  const publicAt = Math.floor((b.startedAt + EARLY_ACCESS_MS) / 1000);
  const regions = Object.entries(b.byRegion)
    .sort((x, y) => y[1] - x[1])
    .map(([r, n]) => `**${REGION_NAME[r] ?? r}** — ${n} account${n === 1 ? "" : "s"}`)
    .join("\n");
  const seen = new Set<string>();
  const highlights = b.drops
    .sort((x, y) => (TIER_RANK[y.tier] ?? 0) - (TIER_RANK[x.tier] ?? 0) || y.skins - x.skins)
    .filter((d) => (seen.has(d.skin) ? false : (seen.add(d.skin), true)))
    .slice(0, 6)
    .map((d) => `• ${d.skin} · ${d.region}`)
    .join("\n");

  const embed = {
    title: "🔓 RESTOCK",
    color: 0xff4655,
    description: `**${total} new accounts** just landed.`,
    fields: [
      { name: "Regions", value: regions || "—", inline: false },
      ...(highlights ? [{ name: "Highlights", value: highlights, inline: false }] : []),
      { name: "💎 Premium & Ultra", value: "Have access **now**.", inline: true },
      { name: "Standard & free", value: `Get access <t:${publicAt}:R> (<t:${publicAt}:t>).`, inline: true },
    ],
    footer: { text: "Val Unlocked · valunlock.online" },
    timestamp: new Date(b.startedAt).toISOString(),
  };

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${RESTOCK_CHANNEL_ID}/messages`, {
      method: "POST",
      headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
      body: JSON.stringify({
        content: "**RESTOCK**",
        embeds: [embed],
        components: [{ type: 1, components: [{ type: 2, style: 5, label: "Open the shop", url: "https://valunlock.online" }] }],
      }),
    });
    if (!res.ok) console.warn(`[watcher] restock post ${res.status}: ${(await res.text()).slice(0, 160)}`);
    else console.log(`[watcher] announced restock: ${total} accounts`);
  } catch (e) {
    console.warn("[watcher] restock post failed", String(e));
  }
}

// ─── daily heartbeat to the staff log (optional) ───────────────────────

let lastHeartbeat = Date.now();
async function heartbeat() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const channel = process.env.DISCORD_LOG_CHANNEL_ID;
  if (!token || !channel || Date.now() - lastHeartbeat < 24 * 3600_000) return;
  lastHeartbeat = Date.now();
  const mem = Math.round(process.memoryUsage().rss / 1048576);
  const content =
    `👀 Stock watcher — last 24h: ${stats.passes} checks, +${stats.added} restocked, ` +
    `−${stats.removed} sold elsewhere, ${stats.errors} passes with errors. ` +
    `Live listings: ${known.size}. Memory ${mem} MB / 256 MB.`;
  Object.assign(stats, { passes: 0, added: 0, removed: 0, changed: 0, errors: 0, since: Date.now() });
  await fetch(`https://discord.com/api/v10/channels/${channel}/messages`, {
    method: "POST",
    headers: { authorization: `Bot ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ content }),
  }).catch(() => {});
}

// ─── main loop ─────────────────────────────────────────────────────────

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
process.on("SIGINT", () => { stopping = true; });

async function main() {
  await loadSkinTiers();
  await loadKnown();
  console.log(`[watcher] running every ${BASE_INTERVAL / 1000}s`);
  while (!stopping) {
    const started = Date.now();
    try {
      await loadSkinTiers();
      await pass();
      await heartbeat();
      await maybeAnnounceRestock();
    } catch (e) {
      stats.errors++;
      interval = Math.min(interval * 2, MAX_INTERVAL);
      console.error("[watcher] pass failed:", String(e).slice(0, 300));
    }
    const wait = Math.max(1_000, interval - (Date.now() - started));
    await new Promise((r) => setTimeout(r, wait));
  }
  console.log("[watcher] stopped");
}

main().catch((e) => {
  console.error("[watcher] fatal", e);
  process.exit(1);
});
