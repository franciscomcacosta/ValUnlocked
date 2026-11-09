// Admin: point qvsp's webhook at /api/webhooks/qvsp and send a test event.
//   GET  → current qvsp webhook config
//   POST → set the URL (needs QVSP_WEBHOOK_TOKEN + PUBLIC_BASE_URL), then test
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { requireAdmin } from "@/lib/session";
import { qvspRaw } from "@/lib/qvsp";

export async function GET(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const res = await qvspRaw("/webhook");
  return Response.json(res, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const token = process.env.QVSP_WEBHOOK_TOKEN;
  const base = process.env.PUBLIC_BASE_URL;
  if (!token || !base) {
    return Response.json({ ok: false, error: "Set QVSP_WEBHOOK_TOKEN and PUBLIC_BASE_URL on Vercel first" }, { status: 400 });
  }
  const url = `${base.replace(/\/$/, "")}/api/webhooks/qvsp?token=${encodeURIComponent(token)}`;
  const set = await qvspRaw("/webhook", { method: "PUT", json: { webhook_url: url, url } });
  const test = set.ok ? await qvspRaw("/webhook/test", { method: "POST", json: {} }) : null;
  const config = await qvspRaw("/webhook");
  // Never echo the token back.
  const redact = (v: unknown) => JSON.parse(JSON.stringify(v).split(token).join("•••"));
  return Response.json({ ok: set.ok, set: redact(set), test: test && redact(test), config: redact(config) });
}
