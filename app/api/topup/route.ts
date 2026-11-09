// GET  /api/topup            → { tiers, bonusPct }
// GET  /api/topup?id=<uuid>  → status of one of the caller's top-ups
// POST /api/topup { tier }   → creates a NowPayments invoice, returns invoiceUrl
//
// Credit is only added by the IPN handler (apply_topup), never here.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import { createInvoice } from "@/lib/nowpayments";
import { TOPUP_TIERS, TOPUP_BONUS_PCT, topupTier } from "@/lib/pricing";

const isMissingTable = (msg?: string) => !!msg && /topup_invoices/.test(msg) && /exist|schema cache|relation/i.test(msg);

export async function GET(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id");
  if (!id) {
    return Response.json({ ok: true, bonusPct: TOPUP_BONUS_PCT, tiers: TOPUP_TIERS });
  }

  const { data, error } = await db
    .from("topup_invoices")
    .select("id, pay_cents, bonus_cents, np_status, credited_at")
    .eq("id", id)
    .eq("user_id", session.uid)
    .maybeSingle();
  if (error) return Response.json({ error: "lookup_failed" }, { status: 500 });
  if (!data) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({
    ok: true,
    id: data.id,
    payCents: data.pay_cents,
    bonusCents: data.bonus_cents,
    status: data.credited_at ? "credited" : data.np_status ?? "waiting",
  }, { headers: { "cache-control": "no-store" } });
}

export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  let body: { tier?: unknown };
  try { body = await req.json(); }
  catch { return Response.json({ error: "invalid_json" }, { status: 400 }); }

  const tier = topupTier(String(body.tier ?? ""));
  if (!tier) return Response.json({ error: "invalid_tier" }, { status: 400 });

  const { data: row, error } = await db
    .from("topup_invoices")
    .insert({
      user_id: session.uid,
      tier: tier.id,
      pay_cents: tier.payCents,
      bonus_cents: tier.bonusCents,
      currency: "eur",
    })
    .select("id")
    .single();
  if (error || !row) {
    console.error("[topup] insert failed:", error?.message);
    return Response.json(
      { error: isMissingTable(error?.message) ? "topup_unavailable" : "topup_failed" },
      { status: 503 }
    );
  }

  try {
    const invoice = await createInvoice({
      orderId: `topup_${row.id}`,
      priceCents: tier.payCents,
      currency: "eur",
      description: `Val Unlocked credit €${(tier.payCents / 100).toFixed(2)} + €${(tier.bonusCents / 100).toFixed(2)} bonus`,
      successPath: `/?topup=${row.id}`,
    });
    await db.from("topup_invoices").update({ np_invoice_id: invoice.id }).eq("id", row.id);
    return Response.json({ ok: true, id: row.id, invoiceUrl: invoice.invoice_url });
  } catch (e) {
    console.error("[topup] invoice failed:", e);
    await db.from("topup_invoices").update({ np_status: "invoice_failed" }).eq("id", row.id);
    return Response.json({ error: "payment_error" }, { status: 502 });
  }
}
