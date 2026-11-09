// Free-account gifts (Standard welcome 26–50, trial 1–25).
// GET  /api/welcome-account → { gift: {kind, label, worthCents} | null, claimed: [...], stock }
// POST /api/welcome-account { kind, region } → claims that gift
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { allGifts, giftStock, claimGift, GIFTS, type GiftKind } from "@/lib/welcome-account";

export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "login_required" }, { status: 401 });
  const gifts = await allGifts(s.uid);
  const next = gifts.find((g) => g.state === "available") ?? null;
  const stock = next ? await giftStock(next.kind) : {};
  return Response.json(
    { gift: next, pending: gifts.filter((g) => g.state === "available").length, stock },
    { headers: { "cache-control": "no-store" } }
  );
}

export async function POST(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "login_required" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { kind?: string; region?: string };
  const kind = (body.kind && body.kind in GIFTS ? body.kind : "standard_welcome") as GiftKind;
  const r = await claimGift(s.uid, kind, body.region ?? "");
  if (!r.ok) {
    const code = r.error === "out_of_stock" || r.error === "already_claimed" ? 409 : r.error === "not_eligible" ? 403 : 400;
    return Response.json(r, { status: code });
  }
  return Response.json(r);
}
