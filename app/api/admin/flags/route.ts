// POST /api/admin/flags { paused: boolean, reason? } → pause / resume sales by hand.
// A manual pause stays until staff resume it (the balance check only
// lifts pauses it started itself).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { requireAdmin } from "@/lib/session";
import { setFlag } from "@/lib/shop-flags";
import { logToStaff } from "@/lib/discord";

export async function POST(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const b = (await req.json().catch(() => ({}))) as { paused?: boolean; reason?: string };
  const paused = !!b.paused;
  try {
    await setFlag(
      "sales_paused",
      paused
        ? { paused: true, by: "manual", reason: (b.reason ?? "").trim().slice(0, 200) || `paused by ${auth.name}`, since: new Date().toISOString() }
        : { paused: false }
    );
  } catch {
    return Response.json({ error: "Run migration 010 first (shop_flags table is missing)." }, { status: 503 });
  }
  await logToStaff(paused ? `⏸️ ${auth.name} paused sales.` : `▶️ ${auth.name} resumed sales.`);
  return Response.json({ ok: true, message: paused ? "Sales paused — buyers see a 'restocking' message." : "Sales resumed." });
}
