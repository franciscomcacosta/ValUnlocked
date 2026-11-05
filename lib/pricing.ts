// Single source of truth for pricing + tier discounts.
// Public prices are per SKIN-RANGE BRACKET (not per account) — buyer picks a
// bracket + region, we pick a random account inside it. This hides "bad skin
// collections" by bundling them with good ones at the same bracket price.

export type SubTier = "standard" | "premium" | "ultra";
export type BracketName = "s_1_25" | "s_26_50" | "s_51_100" | "s_101_150" | "s_151_200" | "s_200_plus";

export interface SkinBracket {
  name: BracketName;
  label: string;         // UI label: "1–25 skins"
  minSkins: number;
  maxSkins: number;      // inclusive; use Infinity for the open-ended top
  publicPriceCents: number;
}

// Skin-count brackets. Prices tuned so the lowest bracket is impulse-buy
// cheap and the top is still way under eneba/g2g for a 200+ skin account.
export const SKIN_BRACKETS: SkinBracket[] = [
  { name: "s_1_25",     label: "1–25 skins",    minSkins: 1,   maxSkins: 25,       publicPriceCents:  499 },
  { name: "s_26_50",    label: "26–50 skins",   minSkins: 26,  maxSkins: 50,       publicPriceCents:  999 },
  { name: "s_51_100",   label: "51–100 skins",  minSkins: 51,  maxSkins: 100,      publicPriceCents: 1699 },
  { name: "s_101_150",  label: "101–150 skins", minSkins: 101, maxSkins: 150,      publicPriceCents: 2499 },
  { name: "s_151_200",  label: "151–200 skins", minSkins: 151, maxSkins: 200,      publicPriceCents: 3499 },
  { name: "s_200_plus", label: "200+ skins",    minSkins: 201, maxSkins: 99999,    publicPriceCents: 4499 },
];

// Monthly subscription prices.
export const SUB_PRICE_CENTS: Record<SubTier, number> = {
  standard:  999,
  premium:  2499,
  ultra:    5999,
};

// Tier discounts per bracket (0 = no discount, 1 = free).
const TIER_DISCOUNT: Record<SubTier, Record<BracketName, number>> = {
  standard: { s_1_25: 0.05, s_26_50: 0.05, s_51_100: 0.08, s_101_150: 0.10, s_151_200: 0.10, s_200_plus: 0.10 },
  premium:  { s_1_25: 0.10, s_26_50: 0.12, s_51_100: 0.18, s_101_150: 0.22, s_151_200: 0.25, s_200_plus: 0.30 },
  ultra:    { s_1_25: 0.15, s_26_50: 0.20, s_51_100: 0.30, s_101_150: 0.35, s_151_200: 0.40, s_200_plus: 0.50 },
};

// Subscription period + grace + drop-embargo settings.
export const SUB_PERIOD_DAYS = 30;
export const SUB_GRACE_HOURS = 48;
export const SUB_EMBARGO_HOURS = 2;
export const AUTOBUY_DEFAULT_DAILY_CAP = 5;

export interface TierPrice {
  publicCents: number;
  finalCents: number;
  discountPct: number;
  savingsCents: number;
}

export function bracketForSkinCount(skinCount: number): SkinBracket {
  for (const b of SKIN_BRACKETS) {
    if (skinCount >= b.minSkins && skinCount <= b.maxSkins) return b;
  }
  return SKIN_BRACKETS[0];
}

export function priceForBracket(bracket: BracketName, tier: SubTier | null): TierPrice {
  const b = SKIN_BRACKETS.find((x) => x.name === bracket)!;
  if (!tier) {
    return { publicCents: b.publicPriceCents, finalCents: b.publicPriceCents, discountPct: 0, savingsCents: 0 };
  }
  const pct = TIER_DISCOUNT[tier][b.name];
  const final = Math.floor(b.publicPriceCents * (1 - pct));
  return {
    publicCents: b.publicPriceCents,
    finalCents: final,
    discountPct: pct,
    savingsCents: b.publicPriceCents - final,
  };
}

export function formatEur(cents: number): string {
  return `€${(cents / 100).toFixed(2)}`;
}

export function nextTier(tier: SubTier | null): SubTier | null {
  if (tier === null) return "standard";
  if (tier === "standard") return "premium";
  if (tier === "premium") return "ultra";
  return null;
}

export function tierLabel(tier: SubTier | null): string {
  if (tier === null) return "Guest";
  return tier[0].toUpperCase() + tier.slice(1);
}

export const TIER_COLOR: Record<SubTier, number> = {
  standard: 0x3b82f6,
  premium:  0xff4655,
  ultra:    0xffd400,
};
