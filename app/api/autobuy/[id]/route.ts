// PATCH  /api/autobuy/[id]   → update fields on a rule (toggle active, change max price, ...)
// DELETE /api/autobuy/[id]   → delete a rule entirely

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { parseExtraAutobuyFields, isMissingColumnError, withoutExtraColumns } from "@/lib/autobuy-fields";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  const { id } = await ctx.params;
  let body: Record<string, unknown>;
  try { body = await req.json(); }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }

  // Whitelist what can be patched.
  const patch: Record<string, unknown> = {};
  if (typeof body.active === "boolean") patch.active = body.active;
  if (typeof body.name === "string") patch.name = body.name.trim() || "Unnamed rule";
  if (Array.isArray(body.regions)) patch.regions = (body.regions as string[]).map((r) => r.toUpperCase());
  if (Array.isArray(body.kinds)) patch.kinds = body.kinds;
  if ("min_skins" in body) patch.min_skins = parseInt(String(body.min_skins), 10) || null;
  if ("max_price_cents" in body) {
    const v = parseInt(String(body.max_price_cents), 10);
    if (v > 0) patch.max_price_cents = v;
  }
  if ("min_level" in body) patch.min_level = parseInt(String(body.min_level), 10) || null;
  if ("min_peak" in body) patch.min_peak = (body.min_peak as string | null)?.toString().trim().toLowerCase() || null;
  if (Array.isArray(body.required_skins)) patch.required_skins = body.required_skins;
  if ("max_buys_per_day" in body) {
    const v = parseInt(String(body.max_buys_per_day), 10);
    if (v >= 1 && v <= 20) patch.max_buys_per_day = v;
  }
  if ("min_credit_cents" in body) {
    const v = parseInt(String(body.min_credit_cents), 10);
    if (v >= 0) patch.min_credit_cents = v;
  }

  Object.assign(patch, parseExtraAutobuyFields(body));

  if (Object.keys(patch).length === 0) {
    return Response.json({ error: "nothing_to_update" }, { status: 400 });
  }

  const run = (p: Record<string, unknown>) =>
    db.from("autobuy_configs").update(p).eq("id", id).eq("user_id", session.uid).select().single();
  let { data, error } = await run(patch);
  if (error && isMissingColumnError(error.message)) {
    const rest = withoutExtraColumns(patch);
    if (Object.keys(rest).length > 0) ({ data, error } = await run(rest));
  }
  if (error) return Response.json({ error: error.message }, { status: 500 });
  if (!data) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({ ok: true, rule: data });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  const { id } = await ctx.params;
  const { error } = await db
    .from("autobuy_configs")
    .delete()
    .eq("id", id)
    .eq("user_id", session.uid);
  if (error) return Response.json({ error: error.message }, { status: 500 });
  return Response.json({ ok: true });
}
