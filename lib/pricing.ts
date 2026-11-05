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
  // Highest qvsp cost we'll accept for this bracket. Accounts above this
  // can still exist in qvsp_stock (and sell through Guaranteed Skins with
  // dynamic pricing), but they won't be eligible for random bracket picks.
  // Derived so Ultra at 30% off still nets ≥ €2 margin:
  //   maxCost = public × 0.70 − 200
  maxAcceptableCostCents: number;
}

// Skin-count brackets. Moderate public prices — sub tier discount + monthly
// credit (see SUB_MONTHLY_CREDIT_CENTS) carry the sub value proposition.
// maxAcceptableCostCents filters out qvsp accounts too expensive to sell
// at the bracket price without losing money at Ultra 30% off.
//
//                                                       Ultra-30%  min-margin
//                                       public   max cost  pays     at max cost
//   1–25        €4.99     €1.50          €3.49    €1.99
//   26–50       €6.99     €2.80          €4.89    €2.09
//   51–100     €11.99     €6.40          €8.39    €1.99
//   101–150    €17.99    €10.60         €12.59    €1.99
//   151–200    €22.99    €14.00         €16.09    €2.09
//   200+       €27.99    €17.60         €19.59    €1.99
export const SKIN_BRACKETS: SkinBracket[] = [
  { name: "s_1_25",     label: "1–25 skins",    minSkins: 1,   maxSkins: 25,       publicPriceCents:  499, maxAcceptableCostCents:  150 },
  { name: "s_26_50",    label: "26–50 skins",   minSkins: 26,  maxSkins: 50,       publicPriceCents:  699, maxAcceptableCostCents:  280 },
  { name: "s_51_100",   label: "51–100 skins",  minSkins: 51,  maxSkins: 100,      publicPriceCents: 1199, maxAcceptableCostCents:  640 },
  { name: "s_101_150",  label: "101–150 skins", minSkins: 101, maxSkins: 150,      publicPriceCents: 1799, maxAcceptableCostCents: 1060 },
  { name: "s_151_200",  label: "151–200 skins", minSkins: 151, maxSkins: 200,      publicPriceCents: 2299, maxAcceptableCostCents: 1400 },
  { name: "s_200_plus", label: "200+ skins",    minSkins: 201, maxSkins: 99999,    publicPriceCents: 2799, maxAcceptableCostCents: 1760 },
];

// Monthly subscription prices.
export const SUB_PRICE_CENTS: Record<SubTier, number> = {
  standard:  999,
  premium:  2499,
  ultra:    5999,
};

// Tier discounts per bracket. Flat 10/20/30 — makes the sub feel like a
// real deal ("30% off every account" is a believable sell-point). Combined
// with the monthly credit (SUB_MONTHLY_CREDIT_CENTS) the perceived value
// jumps without eating margin.
const TIER_DISCOUNT: Record<SubTier, Record<BracketName, number>> = {
  standard: { s_1_25: 0.10, s_26_50: 0.10, s_51_100: 0.10, s_101_150: 0.10, s_151_200: 0.10, s_200_plus: 0.10 },
  premium:  { s_1_25: 0.20, s_26_50: 0.20, s_51_100: 0.20, s_101_150: 0.20, s_151_200: 0.20, s_200_plus: 0.20 },
  ultra:    { s_1_25: 0.30, s_26_50: 0.30, s_51_100: 0.30, s_101_150: 0.30, s_151_200: 0.30, s_200_plus: 0.30 },
};

// Monthly store credit granted on every sub payment (initial + each renewal).
// Zero margin impact (we already collected the sub fee) but huge perceived
// value — "1 free account per month as an Ultra member" is a killer pitch.
export const SUB_MONTHLY_CREDIT_CENTS: Record<SubTier, number> = {
  standard:  300,   // €3
  premium:   800,   // €8
  ultra:    2000,   // €20
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

// ─── Featured ("guaranteed") skins ──────────────────────────
// Named hunted skins. Buyer picks one, backend reserves the cheapest
// available qvsp account that contains that skin in its skins[] array.
// Dynamic price = cheapest-qvsp-cost × markupMultiplier, floor-rounded
// to the nearest €1, then tier discount applied.

export interface FeaturedSkin {
  // Must match qvsp's `skins` array entries EXACTLY (case-sensitive).
  // We accept several spellings for skins with level-suffixes qvsp appends
  // (e.g. "Reaver Vandal" vs "Reaver Vandal (5 Levels)").
  matchAny: string[];
  // Pretty name for the card.
  label: string;
  // Weapon type, shown in UI subtitle.
  weapon: string;
  // Minimum sell price in cents, even if 2.5× the floor is lower.
  // Prevents giving Reaver Vandal away at €7 if a cheap stub appears.
  minPriceCents: number;
}

// Featured-skin pricing model: FLAT markup + safety floor.
// public = max(qvsp_cost + FEATURED_FLAT_MARKUP, per-skin minPrice, safetyFloor)
// safetyFloor = (cost + MIN_MARGIN) / (1 − MAX_TIER_DISCOUNT) — guarantees
// ≥ €2 profit even at Ultra 30% off, for ANY qvsp cost.
export const FEATURED_FLAT_MARKUP_CENTS = 500;    // €5 added to qvsp cost
export const FEATURED_MIN_MARGIN_CENTS  = 200;    // €2 minimum profit
export const FEATURED_MAX_TIER_DISCOUNT = 0.30;   // Ultra cap (matches brackets)

export const FEATURED_SKINS: FeaturedSkin[] = [
  { matchAny: ["Reaver Vandal", "Reaver Vandal (4 Levels)", "Reaver Vandal (5 Levels)"], label: "Reaver Vandal", weapon: "Vandal", minPriceCents: 1799 },
  { matchAny: ["Prime Vandal", "Prime Vandal (4 Levels)"], label: "Prime Vandal", weapon: "Vandal", minPriceCents: 1599 },
  { matchAny: ["Oni Vandal", "Oni Vandal (4 Levels)"], label: "Oni Vandal", weapon: "Vandal", minPriceCents: 1599 },
  { matchAny: ["Elderflame Vandal", "Elderflame Vandal (4 Levels)"], label: "Elderflame Vandal", weapon: "Vandal", minPriceCents: 1699 },
  { matchAny: ["Prelude to Chaos Vandal", "Prelude to Chaos Vandal (4 Levels)"], label: "Prelude to Chaos Vandal", weapon: "Vandal", minPriceCents: 1799 },
  { matchAny: ["RGX 11z Pro Vandal", "RGX 11z Pro Vandal (5 Levels)"], label: "RGX 11z Pro Vandal", weapon: "Vandal", minPriceCents: 1499 },
  { matchAny: ["Ion Phantom", "Ion Phantom (4 Levels)"], label: "Ion Phantom", weapon: "Phantom", minPriceCents: 1499 },
  { matchAny: ["Sovereign Ghost", "Sovereign Ghost (4 Levels)"], label: "Sovereign Ghost", weapon: "Ghost", minPriceCents: 1199 },
  { matchAny: ["Prime Ghost", "Prime Ghost (4 Levels)"], label: "Prime Ghost", weapon: "Ghost", minPriceCents: 1199 },
  { matchAny: ["Reaver Operator", "Reaver Operator (4 Levels)"], label: "Reaver Operator", weapon: "Operator", minPriceCents: 1599 },
  { matchAny: ["Oni Operator", "Oni Operator (4 Levels)"], label: "Oni Operator", weapon: "Operator", minPriceCents: 1599 },
  { matchAny: ["Araxys Operator", "Araxys Operator (4 Levels)"], label: "Araxys Operator", weapon: "Operator", minPriceCents: 1799 },
];

export interface FeaturedSkinPrice {
  skin: FeaturedSkin;
  available: number;
  cheapestQvspCents: number | null;
  publicCents: number;         // computed sell price before tier discount
  finalCents: number;          // after tier discount
  savingsCents: number;
  discountPct: number;
}

/**
 * Flat markup + per-skin floor + margin-safety floor.
 * Takes the max of:
 *   1. cost + FEATURED_FLAT_MARKUP        (simple markup)
 *   2. per-skin minPriceCents             (brand floor on named skins)
 *   3. (cost + MIN_MARGIN) / (1 − MAX_DISCOUNT)  — safety so even an Ultra
 *      buyer leaves ≥ FEATURED_MIN_MARGIN_CENTS in our pocket on every sale.
 */
export function markupPublicPrice(cheapestQvspCents: number, minPriceCents: number): number {
  const flat = cheapestQvspCents + FEATURED_FLAT_MARKUP_CENTS;
  const safetyFloor = Math.ceil(
    (cheapestQvspCents + FEATURED_MIN_MARGIN_CENTS) / (1 - FEATURED_MAX_TIER_DISCOUNT) / 100
  ) * 100;
  return Math.max(flat, minPriceCents, safetyFloor);
}

/**
 * Apply a tier discount to a featured-skin public price. Uses the same
 * per-tier-per-bracket matrix as skin ranges by mapping the public cents
 * back to the nearest bracket. Falls back to top-bracket rates for prices
 * above the whale bracket.
 */
export function featuredPriceForUser(cheapestQvspCents: number, minPriceCents: number, tier: SubTier | null): {
  publicCents: number;
  finalCents: number;
  savingsCents: number;
  discountPct: number;
} {
  const publicCents = markupPublicPrice(cheapestQvspCents, minPriceCents);
  if (!tier) return { publicCents, finalCents: publicCents, savingsCents: 0, discountPct: 0 };
  // Flat 10/20/30 discount on featured skins — matches the bracket tier
  // schedule so subs have a single, memorable headline % across all products.
  const featuredDiscount: Record<SubTier, number> = {
    standard: 0.10,
    premium: 0.20,
    ultra: FEATURED_MAX_TIER_DISCOUNT,
  };
  const pct = featuredDiscount[tier];
  const final = Math.floor(publicCents * (1 - pct));
  return { publicCents, finalCents: final, savingsCents: publicCents - final, discountPct: pct };
}
