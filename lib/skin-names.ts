// qvsp lists skins as "Champions 2023 Kunai (3 Levels)"; the game catalogue
// and our UI use "Champions 2023 Kunai". "(N Levels)" is the only suffix in
// qvsp's data (checked against live stock), so matching just strips it.

export function normalizeSkinName(raw: string): string {
  const cleaned = raw.replace(/\s*\(\d+\s*Levels?(?:,\s*\d+\s*Variants?)?\)\s*$/i, "").trim();
  if (!cleaned || /^invalid_?skin$/i.test(cleaned) || /^unknown$/i.test(cleaned)) return "";
  return cleaned;
}

export const skinKey = (raw: string) => normalizeSkinName(raw).toLowerCase();

/** Every spelling qvsp may store for a skin, for array-overlap queries. */
export function skinVariants(label: string): string[] {
  const base = normalizeSkinName(label);
  const out = [base];
  for (let n = 1; n <= 10; n++) out.push(`${base} (${n} Levels)`);
  out.push(`${base} (1 Level)`);
  return out;
}

/** qvsp often lists the same account several times under different ids.
 *  Two listings with identical level / ranks / VP / skin list are the
 *  same account; this is the key we dedupe on. */
export function accountSignature(r: {
  level: number | null; peak: string | null; rank_normalized: string | null;
  vp: number | null; skin_count: number | null; skins: string[] | null; region?: string | null;
}): string {
  return [r.region ?? "", r.level ?? "", r.peak ?? "", r.rank_normalized ?? "", r.vp ?? "", r.skin_count ?? "", (r.skins ?? []).join("|")].join("§");
}
