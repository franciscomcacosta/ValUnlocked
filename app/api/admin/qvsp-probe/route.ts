// GET /api/admin/qvsp-probe  (admin only)
// Read-only discovery of what the qvsp partner API supports around
// webhooks and replacements. Only GET requests — nothing is bought,
// claimed or reconfigured. Response bodies are truncated; the API key is
// never echoed back.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { requireAdmin } from "@/lib/session";

const BASE = process.env.QVSP_API_BASE ?? "https://nfa.qvsp.net/partner/v1";
const PATHS = ["/webhook", "/replacements", "/openapi.json", "/docs", "/"];

export async function GET(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const key = process.env.QVSP_API_KEY;
  if (!key) return Response.json({ error: "QVSP_API_KEY not set" }, { status: 500 });

  const results = await Promise.all(
    PATHS.map(async (path) => {
      try {
        const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}` } });
        const text = await res.text();
        let body: unknown = text.slice(0, 3000);
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        return { path, status: res.status, contentType: res.headers.get("content-type"), body };
      } catch (e) {
        return { path, error: String(e) };
      }
    })
  );

  return Response.json({ base: BASE, results }, { headers: { "cache-control": "no-store" } });
}
