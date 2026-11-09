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
  // Never echo the webhook token, even to admins.
  const token = process.env.QVSP_WEBHOOK_TOKEN;
  const safe = token ? JSON.parse(JSON.stringify(res).split(token).join("•••")) : res;
  return Response.json(safe, { headers: { "cache-control": "no-store" } });
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

  // qvsp sits behind Cloudflare, which blocked a PUT with an HTML
  // challenge page. Try POST first (also listed for /webhook), then PUT,
  // with the minimal body; report each attempt in plain words.
  const attempts: Array<{ method: string; status: number; ok: boolean; note: string }> = [];
  let set: Awaited<ReturnType<typeof qvspRaw>> = { ok: false, status: 0, body: null };
  for (const method of ["POST", "PUT"] as const) {
    set = await qvspRaw("/webhook", { method, json: { url } });   // qvsp: "Missing url."
    attempts.push({ method, status: set.status, ok: set.ok, note: describe(set.body) });
    if (set.ok) break;
  }
  const test = set.ok ? await qvspRaw("/webhook/test", { method: "POST", json: {} }) : null;
  const config = await qvspRaw("/webhook");
  // Never echo the token back.
  const redact = (v: unknown) => JSON.parse(JSON.stringify(v).split(token).join("•••"));
  return Response.json({
    ok: set.ok,
    attempts: redact(attempts),
    error: set.ok ? undefined : redact(attempts.map((a) => `${a.method} → ${a.status}: ${a.note}`).join(" · ")),
    test: test && redact({ ok: test.ok, status: test.status, note: describe(test.body) }),
    config: redact(config),
  });
}

/** Short human-readable summary of a qvsp response (JSON or HTML page). */
function describe(body: unknown): string {
  if (typeof body === "string") {
    const title = body.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim();
    const cf = /cloudflare|cf-ray|attention required/i.test(body);
    return `${cf ? "Cloudflare block page" : "HTML page"}${title ? ` ("${title}")` : ""}`;
  }
  const b = body as { error?: string; message?: string } | null;
  return (b?.message || b?.error || JSON.stringify(body) || "").slice(0, 200);
}
