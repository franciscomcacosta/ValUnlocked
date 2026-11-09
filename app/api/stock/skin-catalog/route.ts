// GET /api/stock/skin-catalog → every Premium / Exclusive / Ultra skin in
// the game (in stock or not), for the Auto-buy "Must include" picker.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { listSkinCatalog } from "@/lib/valorant-assets";

export async function GET(req: Request) {
  if (!sessionFromRequest(req)) return Response.json({ error: "auth_required" }, { status: 401 });
  const skins = await listSkinCatalog("Premium");
  return Response.json(
    { ok: true, skins: skins.map((s) => ({ key: s.label, label: s.label, icon: s.icon, tier: s.tier, tierColor: s.tierColor })) },
    { headers: { "cache-control": "private, max-age=3600" } }
  );
}
