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

  // "Fresh stock" discovery (read-only GETs). For each candidate URL: status,
  // item count, top-level fields, and — for any item field with only a few
  // distinct values — how often each value appears (finds flags like
  // fresh:true / tag:"fresh"). No credentials are ever in stock listings.
  const summarize = (items: Array<Record<string, unknown>>) => {
    const out: Record<string, Record<string, number>> = {};
    const keys = new Set(items.slice(0, 200).flatMap((i) => Object.keys(i)));
    for (const k of keys) {
      const counts: Record<string, number> = {};
      for (const it of items) {
        const v = it[k];
        if (v !== null && typeof v === "object") continue;
        const key = String(v);
        counts[key] = (counts[key] ?? 0) + 1;
        if (Object.keys(counts).length > 8) break;
      }
      if (Object.keys(counts).length && Object.keys(counts).length <= 8) out[k] = counts;
    }
    return out;
  };
  const tryUrl = async (path: string) => {
    try {
      const res = await fetch(`${BASE}${path}`, { headers: { authorization: `Bearer ${key}` } });
      const text = await res.text();
      let body: Record<string, unknown> | null = null;
      try { body = JSON.parse(text); } catch { return { path, status: res.status, raw: text.slice(0, 200) }; }
      const items = Array.isArray(body?.items) ? (body!.items as Array<Record<string, unknown>>) : Array.isArray(body) ? (body as unknown as Array<Record<string, unknown>>) : [];
      const meta = body && !Array.isArray(body) ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== "items")) : {};
      return { path, status: res.status, count: items.length, meta, itemKeys: Object.keys(items[0] ?? {}), fewValueFields: summarize(items) };
    } catch (e) {
      return { path, error: String(e) };
    }
  };
  const fresh = await Promise.all(
    [
      "/stock?kind=fresh&region=eu",
      "/stock?kind=skinned&region=eu&fresh=1",
      "/stock?kind=skinned&region=eu&fresh=true",
      "/stock?kind=skinned&region=eu&type=fresh",
      "/stock/fresh?region=eu",
      "/fresh?region=eu",
      "/stock?region=eu",
      "/kinds",
      "/stock/kinds",
    ].map(tryUrl)
  );
  const skinnedEu = await tryUrl("/stock?kind=skinned&region=eu");

  return Response.json(
    { base: BASE, fresh_discovery: fresh, skinned_eu_fields: skinnedEu, stock: { eu_first: eu1, eu_second: eu2, ap }, results },
    { headers: { "cache-control": "no-store" } }
  );
}
