// POST /api/stock/skin-art  { names: string[] }
// Resolves skin display names to art (icon + content-tier colour) from the
// cached valorant-api catalogue. Used by the X-Ray inventory grid, which
// only needs art for the one account being inspected — cheaper than
// attaching art to every row of the X-Ray listing.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { lookupSkinArt } from "@/lib/valorant-assets";

const MAX_NAMES = 400;

function clean(raw: string): string {
  return raw
    .replace(/\s*\(\d+\s*Level(?:s)?\)\s*$/i, "")
    .replace(/\s*\(5\s*Levels,\s*5\s*Variants\)\s*$/i, "")
    .trim();
}

export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  let body: { names?: unknown };
  try { body = await req.json(); }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }
  const names = Array.isArray(body.names)
    ? (body.names as unknown[]).filter((n): n is string => typeof n === "string").slice(0, MAX_NAMES)
    : [];

  const art: Record<string, { icon: string | null; tier: string | null; tierColor: string | null; tierIcon: string | null }> = {};
  await Promise.all(
    names.map(async (n) => {
      const a = await lookupSkinArt(clean(n));
      art[n] = { icon: a.icon, tier: a.tierName, tierColor: a.tierColor, tierIcon: a.tierIcon };
    })
  );
  return Response.json({ ok: true, art });
}
