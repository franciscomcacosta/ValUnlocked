// Single source of truth for account pricing + subscription tier discounts.
// Used by: bot /stock, web shop, auto-buy worker, sync cron.
// If you change bracket boundaries or discount percentages, every surface
// updates on the next request/sync. Do NOT duplicate this logic elsewhere.

export type SubTier = "standard" | "premium" | "ultra";
export type BracketName = "ranked" | "low" | "mid" | "high" | "loaded" | "whale";

// All amounts in cents (EUR) to avoid float drift.

interface Bracket {
  name: BracketName;
  // Supplier cost range from qvsp (inclusive low, exclusive high).
  qvspMinCents: number;
  qvspMaxCents: number;
  // What we charge the public.
  publicPriceCents: number;
}

// Markup ladder. qvsp costs €0.90–€14.00 across their inventory.
// Keep cheap stuff near-breakeven (acquisition bait) and fat-margin the top.
const BRACKETS: Bracket[] = [
  { name: "ranked", qvspMinCents:   90, qvspMaxCents:  151, publicPriceCents:  299 },
  { name: "low",    qvspMinCents:  151, qvspMaxCents:  301, publicPriceCents:  599 },
  { name: "mid",    qvspMinCents:  301, qvspMaxCents:  601, publicPriceCents:  999 },
  { name: "high",   qvspMinCents:  601, qvspMaxCents:  901, publicPriceCents: 1699 },
  { name: "loaded", qvspMinCents:  901, qvspMaxCents: 1201, publicPriceCents: 2499 },
  { name: "whale",  qvspMinCents: 1201, qvspMaxCents: 1500, publicPriceCents: 3499 },
];

// Tier discounts, per bracket. Non-subscribers pay publicPriceCents.
// Ultra whale row is the headline: 50% off.
const TIER_DISCOUNT: Record<SubTier, Record<BracketName, number>> = {
  standard: { ranked: 0.05, low: 0.05, mid: 0.08, high: 0.10, loaded: 0.10, whale: 0.10 },
  premium:  { ranked: 0.10, low: 0.12, mid: 0.18, high: 0.22, loaded: 0.25, whale: 0.30 },
  ultra:    { ranked: 0.15, low: 0.20, mid: 0.30, high: 0.35, loaded: 0.40, whale: 0.50 },
};

// Monthly subscription prices, in cents.
export const SUB_PRICE_CENTS: Record<SubTier, number> = {
  standard:  999,   // €9.99
  premium:  2499,   // €24.99
  ultra:    5999,   // €59.99
};

// Length of a paid period. Renewal reminders go out at T-7/T-3/T-1 days,
// strict cutoff at T=0, 48h soft grace, then role revoked.
export const SUB_PERIOD_DAYS = 30;
export const SUB_GRACE_HOURS = 48;

// How early subs see new drops before the public shop.
export const SUB_EMBARGO_HOURS = 2;

// Default autobuy cap (per day, per config). Overridable up to 20 via /autobuy.
export const AUTOBUY_DEFAULT_DAILY_CAP = 5;

/**
 * Find the bracket a qvsp cost falls into. qvsp sometimes returns odd
 * fractional prices (e.g. €1.4999); we round to cents before matching.
 */
export function bracketForCost(qvspCostCents: number): Bracket {
  for (const b of BRACKETS) {
    if (qvspCostCents >= b.qvspMinCents && qvspCostCents < b.qvspMaxCents) return b;
  }
  // Below floor (shouldn't happen, their cheapest is €0.90): use ranked.
  if (qvspCostCents < BRACKETS[0].qvspMinCents) return BRACKETS[0];
  // Above ceiling (also shouldn't): use whale.
  return BRACKETS[BRACKETS.length - 1];
}

/**
 * Public price (what a non-subscriber pays) for a given qvsp cost.
 */
export function publicPriceCents(qvspCostCents: number): number {
  return bracketForCost(qvspCostCents).publicPriceCents;
}

export interface TierPrice {
  publicCents: number;      // sticker price
  finalCents: number;       // what the user actually pays
  discountPct: number;      // 0–1, for display
  savingsCents: number;     // publicCents - finalCents
  bracket: BracketName;
}

/**
 * Apply a tier discount on top of the public bracket price.
 * Returns full breakdown for UI/DM rendering.
 * Pass null tier for non-subscribers.
 */
export function priceForUser(qvspCostCents: number, tier: SubTier | null): TierPrice {
  const b = bracketForCost(qvspCostCents);
  if (!tier) {
    return {
      publicCents: b.publicPriceCents,
      finalCents: b.publicPriceCents,
      discountPct: 0,
      savingsCents: 0,
      bracket: b.name,
    };
  }
  const pct = TIER_DISCOUNT[tier][b.name];
  // Round to whole cents, always down (we eat the fractional cent, user gets
  // the nicer number). Ceil would nickel-and-dime, floor builds trust.
  const final = Math.floor(b.publicPriceCents * (1 - pct));
  return {
    publicCents: b.publicPriceCents,
    finalCents: final,
    discountPct: pct,
    savingsCents: b.publicPriceCents - final,
    bracket: b.name,
  };
}

/**
 * Our margin on an auto-buy for an Ultra user, in cents.
 * Negative means we'd lose money — autobuy worker should skip those.
 */
export function marginForTier(qvspCostCents: number, tier: SubTier): number {
  return priceForUser(qvspCostCents, tier).finalCents - qvspCostCents;
}

/**
 * Render a price in EUR with two decimals. Shared formatter so bot and
 * web agree on the string.
 */
export function formatEur(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}

/**
 * The tier that is strictly better than the given one (for upsell copy).
 * Returns null if already ultra.
 */
export function nextTier(tier: SubTier | null): SubTier | null {
  if (tier === null) return "standard";
  if (tier === "standard") return "premium";
  if (tier === "premium") return "ultra";
  return null;
}

/**
 * Human-readable tier name for embeds / UI copy.
 */
export function tierLabel(tier: SubTier | null): string {
  if (tier === null) return "Guest";
  return tier[0].toUpperCase() + tier.slice(1);
}

/**
 * Tier-color for embeds and UI accents. Matches the Discord role colors.
 *   Standard = blue, Premium = red/pink, Ultra = yellow/gold
 */
export const TIER_COLOR: Record<SubTier, number> = {
  standard: 0x3b82f6,
  premium:  0xff4655,
  ultra:    0xffd400,
};
