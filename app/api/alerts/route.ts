// Restock alerts — "DM me when a <skin range> account drops in <region>".
// The stock watcher matches new listings against these and sends the DMs.
//
// GET    /api/alerts            → { alerts, brackets, regions, max }
// POST   /api/alerts { region, bracket }
// DELETE /api/alerts?id=<uuid>
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { SKIN_BRACKETS } from "@/lib/pricing";

const REGIONS = ["EU", "NA", "AP", "KR", "LATAM", "BR"];
const MAX_ALERTS = 6;

export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "login_required" }, { status: 401 });
  const { data, error } = await db
    .from("restock_alerts")
    .select("id, region, bracket, created_at, last_notified_at")
    .eq("user_id", s.uid)
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) return Response.json({ error: "alerts_unavailable" }, { status: 503 });
  return Response.json(
    {
      ok: true,
      alerts: data ?? [],
      brackets: SKIN_BRACKETS.map((b) => ({ name: b.name, label: b.label })),
      regions: REGIONS,
      max: MAX_ALERTS,
    },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function POST(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "login_required" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { region?: string; bracket?: string };
  const region = (b.region ?? "").toUpperCase();
  if (!REGIONS.includes(region)) return Response.json({ error: "Pick a region." }, { status: 400 });
  if (!SKIN_BRACKETS.some((x) => x.name === b.bracket)) return Response.json({ error: "Pick a skin range." }, { status: 400 });

  const { count } = await db
    .from("restock_alerts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", s.uid)
    .eq("active", true);
  if ((count ?? 0) >= MAX_ALERTS) {
    return Response.json({ error: `You can have up to ${MAX_ALERTS} alerts — remove one first.` }, { status: 400 });
  }

  const { error } = await db
    .from("restock_alerts")
    .upsert(
      { user_id: s.uid, region, bracket: b.bracket, active: true, last_notified_at: null },
      { onConflict: "user_id,region,bracket" }
    );
  if (error) return Response.json({ error: "Couldn't save the alert." }, { status: 500 });
  return Response.json({ ok: true });
}

export async function DELETE(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "login_required" }, { status: 401 });
  const id = new URL(req.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id required" }, { status: 400 });
  await db.from("restock_alerts").delete().eq("id", id).eq("user_id", s.uid);
  return Response.json({ ok: true });
}
