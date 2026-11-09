// Fields added in migration 004 (max_peak, min_vp, budget_cents). Until that
// migration is applied in Supabase, writes that include them fail with an
// "unknown column" error; callers retry without them so the rest of the
// rule still saves.
export const EXTRA_AUTOBUY_COLUMNS = ["max_peak", "min_vp", "budget_cents"] as const;

export function parseExtraAutobuyFields(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if ("max_peak" in body) out.max_peak = (body.max_peak as string | null)?.toString().trim().toLowerCase() || null;
  if ("min_vp" in body) out.min_vp = Math.max(0, parseInt(String(body.min_vp ?? 0), 10) || 0) || null;
  if ("budget_cents" in body) out.budget_cents = Math.max(0, parseInt(String(body.budget_cents ?? 0), 10) || 0) || null;
  return out;
}

export function isMissingColumnError(msg: string | undefined): boolean {
  if (!msg) return false;
  return EXTRA_AUTOBUY_COLUMNS.some((c) => msg.includes(c)) &&
    /column|schema cache/i.test(msg);
}

export function withoutExtraColumns<T extends Record<string, unknown>>(row: T): T {
  const copy = { ...row };
  for (const c of EXTRA_AUTOBUY_COLUMNS) delete (copy as Record<string, unknown>)[c];
  return copy;
}
