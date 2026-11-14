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

  // Stock shape check (read-only): everything EXCEPT the items themselves,
  // how many items came back, and whether ids stay the same between two
  // calls a moment apart — to see paging / re-keyed ids.
  const stock = async (region: string) => {
    const res = await fetch(`${BASE}/stock?kind=skinned&region=${region}`, { headers: { authorization: `Bearer ${key}` } });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(text); } catch { return { region, status: res.status, raw: text.slice(0, 300) }; }
    const items = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>) : [];
    const meta = Object.fromEntries(Object.entries(body).filter(([k]) => k !== "items"));
    const headers = Object.fromEntries([...res.headers].filter(([k]) => /link|page|total|cursor|count|limit|next/i.test(k)));
    return { region, status: res.status, count: items.length, meta, headers, itemKeys: Object.keys(items[0] ?? {}), firstIds: items.slice(0, 3).map((i) => i.id), lastIds: items.slice(-2).map((i) => i.id) };
  };
  const eu1 = await stock("eu").catch((e) => ({ error: String(e) }));
  await new Promise((r) => setTimeout(r, 1500));
  const eu2 = await stock("eu").catch((e) => ({ error: String(e) }));
  const ap = await stock("ap").catch((e) => ({ error: String(e) }));

  return Response.json({ base: BASE, stock: { eu_first: eu1, eu_second: eu2, ap }, results }, { headers: { "cache-control": "no-store" } });
}
