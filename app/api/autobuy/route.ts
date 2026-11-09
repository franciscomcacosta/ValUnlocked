// GET  /api/autobuy          → list my autobuy rules + today's usage per rule
// POST /api/autobuy          → create a new rule
//
// Ultra-only. Rules buy matching qvsp drops the instant they land, paid
// from the user's credit, as long as:
//   - account.region ∈ rule.regions (empty = any)
//   - account.kind ∈ rule.kinds (empty = any)
//   - account.skin_count ≥ rule.min_skins
//   - account.level ≥ rule.min_level
//   - account.peak rank ≥ rule.min_peak
//   - account.required_skins ⊆ account.skins
//   - final price ≤ rule.max_price_cents
//   - rule.bought_today < max_buys_per_day
//   - user.credit_cents ≥ max(rule.min_credit_cents, final price)
//
// The actual firing happens inside the sync-qvsp cron whenever a new row
// is upserted. This endpoint is just CRUD.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import type { SubTier } from "@/lib/pricing";

async function requireUltra(uid: string): Promise<{ ok: true } | { ok: false; status: number; body: object }> {
  const { data: sub } = await db
    .from("subscriptions")
    .select("tier")
    .eq("user_id", uid)
    .in("status", ["active", "grace"])
    .maybeSingle();
  const tier = (sub?.tier ?? null) as SubTier | null;
  if (tier !== "ultra") {
    return { ok: false, status: 403, body: { error: "ultra_required", currentTier: tier } };
  }
  return { ok: true };
}

export async function GET(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });
  const gate = await requireUltra(session.uid);
  if (!gate.ok) return Response.json(gate.body, { status: gate.status });

  const { data, error } = await db
    .from("autobuy_configs")
    .select(
      "id, name, active, regions, kinds, min_skins, max_price_cents, min_level, min_peak, required_skins, max_buys_per_day, min_credit_cents, bought_today, bought_today_date, last_fired_at, created_at"
    )
    .eq("user_id", session.uid)
    .order("created_at", { ascending: false });
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, rules: data ?? [] });
}

export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });
  const gate = await requireUltra(session.uid);
  if (!gate.ok) return Response.json(gate.body, { status: gate.status });

  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }

  const name = (body.name as string | undefined)?.trim() || "Unnamed rule";
  const regions = Array.isArray(body.regions) ? (body.regions as string[]).map((r) => r.toUpperCase()) : [];
  const kinds = Array.isArray(body.kinds) ? (body.kinds as string[]) : ["skinned"];
  const minSkins = Math.max(0, parseInt(String(body.min_skins ?? 0), 10) || 0);
  const maxPriceCents = Math.max(100, parseInt(String(body.max_price_cents ?? 0), 10) || 0);
  if (!maxPriceCents) {
    return Response.json({ error: "max_price_cents_required" }, { status: 400 });
  }
  const minLevel = Math.max(0, parseInt(String(body.min_level ?? 0), 10) || 0);
  const minPeak = (body.min_peak as string | undefined)?.trim().toLowerCase() || null;
  const requiredSkins = Array.isArray(body.required_skins) ? (body.required_skins as string[]) : [];
  const maxBuysPerDay = Math.min(20, Math.max(1, parseInt(String(body.max_buys_per_day ?? 5), 10) || 5));
  const minCreditCents = Math.max(0, parseInt(String(body.min_credit_cents ?? 5000), 10) || 5000);

  const { data, error } = await db
    .from("autobuy_configs")
    .insert({
      user_id: session.uid,
      name,
      active: true,
      regions,
      kinds,
      min_skins: minSkins || null,
      max_price_cents: maxPriceCents,
      min_level: minLevel || null,
      min_peak: minPeak,
      required_skins: requiredSkins,
      max_buys_per_day: maxBuysPerDay,
      min_credit_cents: minCreditCents,
    })
    .select()
    .single();
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true, rule: data });
}
