// Valorant asset lookup — skins, content tiers, ranks, agents.
// Source: valorant-api.com (free community API, no auth).
//
// Design: this file is called from server-side API routes only. We cache the
// three catalogs in memory for a day (revalidated on cold start) and expose
// three lookup helpers:
//   - lookupSkinArt(displayName)       → { icon, tier, tierColor }
//   - lookupRank(rankName)             → { icon, color, triad }  (triad = e.g. "Gold 3")
//   - lookupAgent(agentName)           → { portrait, uuid }
//
// On the client, images are hot-linked straight from media.valorant-api.com.
// We only ever resolve the URL — we never download or re-serve Riot's art
// from our own domain. If Riot ever objects, we swap this resolver.

type ContentTier = {
  uuid: string;
  displayName: string;           // "Select Edition" | "Deluxe Edition" | "Premium Edition" | "Exclusive Edition" | "Ultra Edition"
  devName: string;               // "Select" | "Deluxe" | "Premium" | "Exclusive" | "Ultra"
  rank: number;
  highlightColor: string;        // 8-hex (RGBA) without leading #
  displayIcon: string;
};

type Skin = {
  uuid: string;
  displayName: string;           // e.g. "Reaver Vandal"
  contentTierUuid: string | null;
  displayIcon: string | null;    // may be null for default skins
};

type Agent = {
  uuid: string;
  displayName: string;
  displayIcon: string;
  isPlayableCharacter: boolean;
};

type RankTier = {
  tier: number;
  tierName: string;              // "UNRANKED" | "IRON 1" | ... | "RADIANT" (uppercase)
  divisionName: string;
  color: string;                 // 8-hex RGBA no #
  largeIcon: string | null;
  smallIcon: string | null;
};

type Cache = {
  skinsByName: Map<string, Skin>;
  contentTiersByUuid: Map<string, ContentTier>;
  contentTiersByDevName: Map<string, ContentTier>;
  agentsByName: Map<string, Agent>;
  ranksByName: Map<string, RankTier>;
  loadedAt: number;
};

let cache: Cache | null = null;
let pending: Promise<Cache> | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;   // 24h

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { next: { revalidate: 86400 } });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  const body = await res.json();
  return body.data as T;
}

async function loadCache(): Promise<Cache> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache;
  if (pending) return pending;

  pending = (async () => {
    const [skins, tiers, agents, rankSets] = await Promise.all([
      fetchJson<Skin[]>("https://valorant-api.com/v1/weapons/skins"),
      fetchJson<ContentTier[]>("https://valorant-api.com/v1/contenttiers"),
      fetchJson<Agent[]>("https://valorant-api.com/v1/agents?isPlayableCharacter=true"),
      fetchJson<Array<{ tiers: RankTier[] }>>("https://valorant-api.com/v1/competitivetiers"),
    ]);

    const skinsByName = new Map<string, Skin>();
    for (const s of skins) skinsByName.set(s.displayName.toLowerCase(), s);

    const contentTiersByUuid = new Map<string, ContentTier>();
    const contentTiersByDevName = new Map<string, ContentTier>();
    for (const t of tiers) {
      contentTiersByUuid.set(t.uuid, t);
      contentTiersByDevName.set(t.devName.toLowerCase(), t);
    }

    const agentsByName = new Map<string, Agent>();
    for (const a of agents) agentsByName.set(a.displayName.toLowerCase(), a);

    // Latest tier set has the current ranks
    const ranksByName = new Map<string, RankTier>();
    const currentTiers = rankSets[rankSets.length - 1]?.tiers ?? [];
    for (const t of currentTiers) ranksByName.set(t.tierName.toUpperCase(), t);

    cache = {
      skinsByName,
      contentTiersByUuid,
      contentTiersByDevName,
      agentsByName,
      ranksByName,
      loadedAt: Date.now(),
    };
    return cache;
  })();

  try {
    return await pending;
  } finally {
    pending = null;
  }
}

// ---- Public helpers ---------------------------------------------

export type SkinArt = {
  icon: string | null;             // URL to displayIcon on media.valorant-api.com
  tierName: string | null;         // "Premium" | "Ultra" | ...
  tierColor: string | null;        // "#rrggbb" or null
  tierIcon: string | null;         // URL to tier badge
};

/** Look up art for a skin by its displayName (case-insensitive). */
export async function lookupSkinArt(displayName: string): Promise<SkinArt> {
  const c = await loadCache();
  const s = c.skinsByName.get(displayName.toLowerCase());
  if (!s) return { icon: null, tierName: null, tierColor: null, tierIcon: null };
  const tier = s.contentTierUuid ? c.contentTiersByUuid.get(s.contentTierUuid) : null;
  return {
    icon: s.displayIcon,
    tierName: tier?.devName ?? null,
    tierColor: tier ? "#" + tier.highlightColor.slice(0, 6) : null,
    tierIcon: tier?.displayIcon ?? null,
  };
}

export type RankArt = {
  icon: string | null;
  color: string | null;            // "#rrggbb"
  canonicalName: string | null;    // "Gold 3"
};

/** Look up rank icon + color by friendly name like "Gold 3" (case-insensitive). */
export async function lookupRank(rankName: string): Promise<RankArt> {
  const c = await loadCache();
  const key = rankName.trim().toUpperCase();
  const r = c.ranksByName.get(key);
  if (!r) return { icon: null, color: null, canonicalName: null };
  const pretty = r.tierName
    .split(" ")
    .map((w) => w[0] + w.slice(1).toLowerCase())
    .join(" ");
  return {
    icon: r.largeIcon,
    color: "#" + r.color.slice(0, 6),
    canonicalName: pretty,
  };
}

export type AgentArt = {
  portrait: string | null;
  uuid: string | null;
};

/** Look up an agent portrait by name (case-insensitive). */
export async function lookupAgent(agentName: string): Promise<AgentArt> {
  const c = await loadCache();
  const a = c.agentsByName.get(agentName.toLowerCase());
  if (!a) return { portrait: null, uuid: null };
  return { portrait: a.displayIcon, uuid: a.uuid };
}

/** List all agent portraits (for the X-Ray grid or an "all agents" lookup). */
export async function listAllAgents(): Promise<AgentArt[] & { names: string[] }> {
  const c = await loadCache();
  const list: AgentArt[] = [];
  for (const a of c.agentsByName.values()) {
    list.push({ portrait: a.displayIcon, uuid: a.uuid });
  }
  return list as AgentArt[] & { names: string[] };
}

/** Tier icon by devName ("Premium" | "Ultra" | "Exclusive" | "Deluxe" | "Select"). */
export async function lookupContentTier(
  devName: string
): Promise<{ icon: string | null; color: string | null }> {
  const c = await loadCache();
  const t = c.contentTiersByDevName.get(devName.toLowerCase());
  if (!t) return { icon: null, color: null };
  return { icon: t.displayIcon, color: "#" + t.highlightColor.slice(0, 6) };
}
