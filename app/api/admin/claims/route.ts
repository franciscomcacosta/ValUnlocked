// Admin: replacement / refund claims.
//
// GET  /api/admin/claims?view=open|all → claims with buyer, order and a 7-day video link
// POST /api/admin/claims { action, claimId, note? }
//   action "refund" → refund buyer to credit (+5% bonus), or re-issue a free gift
//   action "deny"   → deny and DM the buyer
//   action "retry"  → try forwarding to qvsp again
//   action "sync"   → re-read the qvsp ticket now
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { db } from "@/lib/supabase";
import { requireAdmin } from "@/lib/session";
import { claimRates } from "@/lib/admin";
import {
  CLAIM_REASONS,
  LEGACY_CLAIM_REASONS,
  VIDEO_BUCKET,
  adminResolveClaim,
  forwardClaimToQvsp,
  syncClaim,
} from "@/lib/claims";

export async function GET(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const view = new URL(req.url).searchParams.get("view") ?? "open";

  let q = db
    .from("replacement_claims")
    .select(
      "id, order_id, user_id, reason, status, qvsp_ticket_id, qvsp_status, forward_error, outcome_note, refund_cents, bonus_cents, video_path, created_at, resolved_at, users(discord_id, discord_username)"
    )
    .order("created_at", { ascending: false })
    .limit(60);
  if (view === "open") q = q.in("status", ["submitted", "under_review"]);
  const { data, error } = await q;
  if (error) return Response.json({ error: error.message }, { status: 500 });

  const rates = await claimRates((data ?? []).map((c) => c.user_id as string)).catch(() => new Map());
  const claims = await Promise.all(
    (data ?? []).map(async (c) => {
      const video = c.video_path
        ? (await db.storage.from(VIDEO_BUCKET).createSignedUrl(c.video_path as string, 60 * 60 * 24 * 7)).data?.signedUrl ?? null
        : null;
      const r = c.reason as string;
      return {
        ...c,
        reason_label: CLAIM_REASONS[r] ?? LEGACY_CLAIM_REASONS[r] ?? r,
        video_url: video,
        buyer_stats: rates.get(c.user_id as string) ?? null,
      };
    })
  );
  return Response.json({ ok: true, claims }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const auth = requireAdmin(req);
  if (auth instanceof Response) return auth;
  const b = (await req.json().catch(() => ({}))) as { action?: string; claimId?: string; note?: string };
  if (!b.claimId) return Response.json({ error: "claimId required" }, { status: 400 });
  const note = (b.note ?? "").trim().slice(0, 300);

  try {
    if (b.action === "refund" || b.action === "deny") {
      const r = await adminResolveClaim(b.claimId, b.action, note);
      return Response.json(r.ok ? { ok: true, message: r.message } : { error: r.message }, { status: r.ok ? 200 : 409 });
    }
    if (b.action === "retry") {
      // Clear the last error so a repeat failure is reported again.
      await db.from("replacement_claims").update({ forward_error: null }).eq("id", b.claimId).is("qvsp_ticket_id", null);
      await forwardClaimToQvsp(b.claimId);
      const { data } = await db.from("replacement_claims").select("qvsp_ticket_id, forward_error").eq("id", b.claimId).single();
      return data?.qvsp_ticket_id
        ? Response.json({ ok: true, message: `Sent to qvsp as ticket ${data.qvsp_ticket_id}.` })
        : Response.json({ error: `qvsp still refused: ${data?.forward_error ?? "unknown error"}` }, { status: 502 });
    }
    if (b.action === "sync") {
      const r = await syncClaim(b.claimId);
      return Response.json({ ok: true, message: `Ticket checked: ${r.replace(/_/g, " ")}.` });
    }
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
