// GET  /api/welcome-account → { state, orderId?, stock: { EU: n, ... } }
// POST /api/welcome-account { region } → claims the free Standard account
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { welcomeStatus, welcomeStock, claimWelcomeAccount } from "@/lib/welcome-account";

export async function GET(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "login_required" }, { status: 401 });
  const status = await welcomeStatus(s.uid);
  const stock = status.state === "available" ? await welcomeStock() : {};
  return Response.json({ ...status, stock }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const s = sessionFromRequest(req);
  if (!s) return Response.json({ error: "login_required" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { region?: string };
  const r = await claimWelcomeAccount(s.uid, body.region ?? "");
  if (!r.ok) {
    const code = r.error === "out_of_stock" || r.error === "already_claimed" ? 409 : r.error === "not_eligible" ? 403 : 400;
    return Response.json(r, { status: code });
  }
  return Response.json(r);
}
