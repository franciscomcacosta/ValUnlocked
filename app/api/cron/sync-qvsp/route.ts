export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Every 2 minutes: pull qvsp live stock, upsert into our mirror, mark stale
// rows removed. Triggered by Vercel Cron — add
//   { "path": "/api/cron/sync-qvsp", "schedule": "*/2 * * * *" }
// to vercel.json. Protected by CRON_SECRET.
//
// This is the single source of truth for what we have available. Checkout,
// snipe-watcher, and autobuy-worker all read from qvsp_stock, not from qvsp
// directly — keeps us from hammering their api and lets us apply embargo.

import { db } from "@/lib/supabase";
import { getAllStock, normalizeRank, qvspPriceToCents, QvspApiError } from "@/lib/qvsp";
import { bracketForSkinCount, SKIN_BRACKETS } from "@/lib/pricing";

// Mirror public_price_cents on each row so admin queries don't have to
// recompute. For skinned items it's the skin-bracket price; ranked items
// (which we don't show in v1) just get the lowest bracket as a placeholder.
function computePublicPriceCents(kind: string, skinCount: number): number {
  if (kind === "skinned") return bracketForSkinCount(skinCount).publicPriceCents;
  return SKIN_BRACKETS[0].publicPriceCents;
}

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return runSync();
}

// Also allow POST so it can be triggered manually from an admin button.
export async function POST(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return runSync();
}

async function runSync() {
  const start = Date.now();
  let items;
  try {
    items = await getAllStock();
  } catch (e) {
    const err = e instanceof QvspApiError ? `${e.code}: ${e.message}` : String(e);
    console.error("[sync-qvsp] fetch failed", err);
    return Response.json({ ok: false, error: err }, { status: 502 });
  }

  // Build the upsert rows. Compute public price here so UI never has to.
  const now = new Date().toISOString();
  const rows = items.map((item) => {
    const qvspCents = qvspPriceToCents(item.price);
    return {
      qvsp_id: item.id,
      kind: item.kind,
      region: item.region,
      level: item.level,
      peak: item.peak,
      rank: item.rank,
      rank_normalized: normalizeRank(item.rank),
      qvsp_price_cents: qvspCents,
      public_price_cents: computePublicPriceCents(item.kind, item.skin_count ?? 0),
      // Ranked items omit these fields — they're sold on rank, not loot.
      skin_count: item.skin_count ?? 0,
      skins: item.skins ?? [],
      buddies: item.buddies ?? [],
      vp: item.vp ?? null,
      vp_value_cents: item.vp_value != null ? Math.round(item.vp_value) : null,
      last_played: item.last_played ?? null,
      added_epoch: item.added_epoch ?? null,
      last_synced_at: now,
      // first_seen_at and public_at only set on insert (upsert ignores the old).
    };
  });

  // Chunk upsert — supabase caps request size, and we may have ~14k rows.
  const chunkSize = 500;
  let upserted = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const { error } = await db
      .from("qvsp_stock")
      .upsert(chunk, { onConflict: "qvsp_id", ignoreDuplicates: false });
    if (error) {
      console.error("[sync-qvsp] upsert chunk failed", error);
      return Response.json({ ok: false, error: error.message, upserted }, { status: 500 });
    }
    upserted += chunk.length;
  }

  // Mark rows removed from qvsp as such (they sold on their side, or were pulled).
  // We DON'T delete — we need the history for /mypurchases and audit.
  const liveIds = new Set(items.map((i) => i.id));
  const { data: ours } = await db
    .from("qvsp_stock")
    .select("qvsp_id")
    .is("removed_at", null)
    .eq("claimed", false)
    .is("reserved_order_id", null);
  const toRemove = (ours ?? []).filter((r) => !liveIds.has(r.qvsp_id)).map((r) => r.qvsp_id);

  let removed = 0;
  if (toRemove.length) {
    const { error } = await db
      .from("qvsp_stock")
      .update({ removed_at: now })
      .in("qvsp_id", toRemove);
    if (error) {
      console.error("[sync-qvsp] mark removed failed", error);
    } else {
      removed = toRemove.length;
    }
  }

  const elapsed = Date.now() - start;
  console.log(`[sync-qvsp] ok — ${upserted} upserted, ${removed} removed in ${elapsed}ms`);
  return Response.json({ ok: true, upserted, removed, elapsed_ms: elapsed });
}
