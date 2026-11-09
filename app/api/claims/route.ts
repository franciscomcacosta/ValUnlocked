// Report-a-problem claims.
//   GET  ?orderId=<id>        → claims for one of the caller's orders
//   GET  ?unseen=1            → resolved claims the caller hasn't been shown yet
//   POST { action: "upload-url", orderId, filename, size, type }
//        → signed URL to PUT the screen recording straight to storage
//   POST { action: "submit", orderId, reason, details?, videoPath }
//        → creates the claim and forwards it to qvsp
//   POST { action: "seen", ids }  → marks outcome notices as shown
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { logToStaff } from "@/lib/discord";
import {
  CLAIM_WINDOW_MS, CLAIM_SUBMIT_GRACE_MS, CLAIM_BONUS_PCT, CLAIM_REASONS,
  VIDEO_BUCKET, MAX_VIDEO_BYTES, ensureVideoBucket, forwardClaimToQvsp,
} from "@/lib/claims";

const PUBLIC_COLS =
  "id, order_id, reason, details, status, outcome_note, refund_cents, bonus_cents, qvsp_ticket_id, created_at, resolved_at, customer_seen_at";

async function ownedDeliveredOrder(userId: string, orderId: string) {
  const { data } = await db
    .from("orders")
    .select("id, user_id, status, price_cents, fulfilled_at")
    .eq("id", orderId)
    .maybeSingle();
  if (!data || data.user_id !== userId) return { error: "not_found" as const };
  if (data.status !== "fulfilled" || !data.fulfilled_at) return { error: "not_delivered" as const };
  return { order: data };
}

export async function GET(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });
  const url = new URL(req.url);

  if (url.searchParams.get("unseen")) {
    const { data, error } = await db
      .from("replacement_claims")
      .select(PUBLIC_COLS)
      .eq("user_id", session.uid)
      .in("status", ["refunded", "replaced"])
      .is("customer_seen_at", null)
      .order("resolved_at", { ascending: false });
    if (error) return Response.json({ ok: true, claims: [] });   // table not migrated yet
    return Response.json({ ok: true, claims: data ?? [] }, { headers: { "cache-control": "no-store" } });
  }

  const orderId = url.searchParams.get("orderId");
  if (!orderId) return Response.json({ error: "orderId_required" }, { status: 400 });
  const { data, error } = await db
    .from("replacement_claims")
    .select(PUBLIC_COLS)
    .eq("user_id", session.uid)
    .eq("order_id", orderId)
    .order("created_at", { ascending: false });
  if (error) return Response.json({ ok: true, claims: [] });
  return Response.json({ ok: true, claims: data ?? [] }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const action = String(body?.action ?? "");

  if (action === "seen") {
    const ids = Array.isArray(body?.ids) ? (body!.ids as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (ids.length) {
      await db
        .from("replacement_claims")
        .update({ customer_seen_at: new Date().toISOString() })
        .eq("user_id", session.uid)
        .in("id", ids);
    }
    return Response.json({ ok: true });
  }

  const orderId = String(body?.orderId ?? "");
  const owned = await ownedDeliveredOrder(session.uid, orderId);
  if ("error" in owned) return Response.json({ error: owned.error }, { status: owned.error === "not_found" ? 404 : 409 });
  const order = owned.order;
  const sinceDelivery = Date.now() - new Date(order.fulfilled_at as string).getTime();

  if (action === "upload-url") {
    if (sinceDelivery > CLAIM_WINDOW_MS) return Response.json({ error: "window_closed" }, { status: 409 });
    const size = Number(body?.size ?? 0);
    const type = String(body?.type ?? "");
    if (!type.startsWith("video/")) return Response.json({ error: "video_required" }, { status: 400 });
    if (!size || size > MAX_VIDEO_BYTES) return Response.json({ error: "video_too_large" }, { status: 400 });
    const ext = (String(body?.filename ?? "").split(".").pop() ?? "mp4").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "mp4";
    const path = `${order.id}/${Date.now()}.${ext}`;
    try {
      await ensureVideoBucket();
      const { data, error } = await db.storage.from(VIDEO_BUCKET).createSignedUploadUrl(path);
      if (error || !data) throw error ?? new Error("no signed url");
      return Response.json({ ok: true, path, uploadUrl: data.signedUrl });
    } catch (e) {
      console.error("[claims] upload url failed", e);
      return Response.json({ error: "upload_unavailable" }, { status: 503 });
    }
  }

  if (action === "submit") {
    if (sinceDelivery > CLAIM_WINDOW_MS + CLAIM_SUBMIT_GRACE_MS) {
      return Response.json({ error: "window_closed" }, { status: 409 });
    }
    const reason = String(body?.reason ?? "");
    if (!(reason in CLAIM_REASONS)) return Response.json({ error: "invalid_reason" }, { status: 400 });
    const videoPath = String(body?.videoPath ?? "");
    if (!videoPath.startsWith(`${order.id}/`)) return Response.json({ error: "video_required" }, { status: 400 });
    const details = String(body?.details ?? "").trim().slice(0, 1000) || null;

    const price = order.price_cents as number;
    const { data: claim, error } = await db
      .from("replacement_claims")
      .insert({
        order_id: order.id,
        user_id: session.uid,
        reason,
        details,
        video_path: videoPath,
        refund_cents: price,
        bonus_cents: Math.round(price * CLAIM_BONUS_PCT),
      })
      .select("id")
      .single();
    if (error || !claim) {
      const dup = /duplicate|unique/i.test(error?.message ?? "");
      const missing = /replacement_claims/.test(error?.message ?? "") && /exist|schema/i.test(error?.message ?? "");
      return Response.json(
        { error: dup ? "already_reported" : missing ? "claims_unavailable" : "claim_failed" },
        { status: dup ? 409 : 503 }
      );
    }

    try {
      await forwardClaimToQvsp(claim.id);
    } catch (e) {
      console.error("[claims] forward crashed", e);
      await logToStaff(`🧾 Claim ${claim.id} saved but forwarding to qvsp crashed: ${String(e).slice(0, 300)}`);
    }
    return Response.json({ ok: true, id: claim.id, ticket: `RF-${claim.id.slice(0, 8).toUpperCase()}` });
  }

  return Response.json({ error: "unknown_action" }, { status: 400 });
}
