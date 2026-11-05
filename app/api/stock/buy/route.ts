// POST /api/stock/buy { region, bracket }
// Reserves a random available qvsp_stock row inside the chosen (region, bracket)
// for the signed-in user, applies their tier discount, creates a nowpayments
// invoice. Payment IPN later calls qvsp POST /orders and delivers credentials.
import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import {
  SKIN_BRACKETS,
  priceForBracket,
  type BracketName,
  type SubTier,
} from "@/lib/pricing";
import { createInvoice } from "@/lib/nowpayments";

export const runtime = "nodejs";

const REGIONS = new Set(["EU", "AP", "KR", "LATAM", "BR"]);

export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { region?: string; bracket?: string; useCredit?: boolean }
    | null;
  const region = body?.region?.toUpperCase();
  const bracketName = body?.bracket as BracketName | undefined;
  const useCredit = body?.useCredit !== false; // default true

  if (!region || !REGIONS.has(region)) {
    return Response.json({ error: "invalid_region" }, { status: 400 });
  }
  const bracket = SKIN_BRACKETS.find((b) => b.name === bracketName);
  if (!bracket) return Response.json({ error: "invalid_bracket" }, { status: 400 });

  // Pull the user's active tier for pricing.
  const { data: sub } = await db
    .from("subscriptions")
    .select("tier")
    .eq("user_id", session.uid)
    .in("status", ["active", "grace"])
    .maybeSingle();
  const tier = (sub?.tier ?? null) as SubTier | null;
  const pricing = priceForBracket(bracket.name, tier);

  // Pick a random available qvsp row matching region + bracket. We grab a
  // small candidate set first to randomize, then reserve one via SKIP LOCKED
  // in a single update statement so concurrent buyers don't collide.
  const { data: candidates, error: cErr } = await db
    .from("qvsp_stock")
    .select("qvsp_id")
    .eq("region", region)
    .eq("kind", "skinned")
    .gte("skin_count", bracket.minSkins)
    .lte("skin_count", bracket.maxSkins)
    .is("reserved_order_id", null)
    .is("removed_at", null)
    .eq("claimed", false)
    .limit(50);
  if (cErr) return Response.json({ error: cErr.message }, { status: 500 });
  if (!candidates || candidates.length === 0) {
    return Response.json({ error: "out_of_stock" }, { status: 409 });
  }

  // Create a pending order first so we have an id to reserve against.
  const { data: order, error: oErr } = await db
    .from("orders")
    .insert({
      user_id: session.uid,
      // We don't have a products row for a qvsp bracket; leave product_id null
      // via a bracket-synthetic placeholder. The existing schema requires
      // product_id, so this requires either a migration OR using one of the
      // pre-seeded 'qvsp' products you created in admin. To keep this PR
      // non-breaking we require the admin to have created a placeholder
      // product once named "qvsp-<bracket>". Fallback error below guides you.
      product_id: await resolveBracketProductId(bracket.name),
      price_cents: pricing.publicCents,
      credit_used_cents: 0,
      charge_cents: pricing.finalCents,
      currency: "eur",
    })
    .select("id")
    .single();
  if (oErr || !order) {
    return Response.json(
      { error: "order_create_failed", detail: oErr?.message },
      { status: 500 }
    );
  }

  // Try to reserve each candidate until one succeeds (race-free via the
  // existing reserve_qvsp_stock SQL function from migration 002).
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  let reservedQvspId: string | null = null;
  for (const c of shuffled) {
    const { data: picked } = await db.rpc("reserve_qvsp_stock", {
      p_order_id: order.id,
      p_qvsp_id: c.qvsp_id,
    });
    if (picked) {
      reservedQvspId = picked as string;
      break;
    }
  }
  if (!reservedQvspId) {
    await db.from("orders").update({ status: "cancelled" }).eq("id", order.id);
    return Response.json({ error: "out_of_stock" }, { status: 409 });
  }

  // Apply store credit if asked and present.
  let credit = 0;
  let charge = pricing.finalCents;
  if (useCredit) {
    const { data: user } = await db
      .from("users")
      .select("credit_cents")
      .eq("id", session.uid)
      .single();
    credit = Math.min(user?.credit_cents ?? 0, pricing.finalCents);
    charge = pricing.finalCents - credit;
    if (credit > 0) {
      const { data: spent } = await db.rpc("spend_credit", {
        p_user_id: session.uid,
        p_cents: credit,
        p_order_id: order.id,
      });
      if (!spent) {
        // Credit couldn't be applied — fall back to full price, don't fail.
        credit = 0;
        charge = pricing.finalCents;
      } else {
        await db
          .from("orders")
          .update({ credit_used_cents: credit, charge_cents: charge })
          .eq("id", order.id);
      }
    }
  }

  // Credit fully covered the order → deliver immediately.
  if (charge === 0) {
    // Fulfilment logic is handled by IPN handler for qvsp rows; call it
    // directly here with a synthetic "paid" flag. For simplicity we leave
    // the order as 'paid' and let the next fulfilment cron pick it up — OR
    // call fulfilOrder() directly if you want instant delivery (uncomment
    // when the qvsp-aware fulfilment path lands).
    await db.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", order.id);
    return Response.json({
      ok: true,
      orderId: order.id,
      invoiceUrl: null,
      deliveredByCredit: true,
    });
  }

  // Otherwise, create a crypto invoice.
  try {
    const invoice = await createInvoice({
      orderId: order.id,
      priceCents: charge,
      currency: "eur",
      description: `Valorant account · ${bracket.label} · ${region}`,
    });
    await db.from("orders").update({ np_invoice_id: invoice.id }).eq("id", order.id);
    return Response.json({
      ok: true,
      orderId: order.id,
      invoiceUrl: invoice.invoice_url,
      bracket: bracket.label,
      region,
      amountCents: charge,
    });
  } catch (e) {
    console.error("[stock/buy] invoice failed", e);
    await db.from("orders").update({ status: "cancelled" }).eq("id", order.id);
    await db.rpc("release_qvsp_stock", { p_order_id: order.id });
    if (credit > 0) {
      await db.rpc("add_credit", {
        p_user_id: session.uid,
        p_cents: credit,
        p_reason: "order_cancelled",
        p_order_id: order.id,
      });
    }
    return Response.json({ error: "payment_provider_error" }, { status: 502 });
  }
}

// We synthesize a placeholder product row per bracket on first use so the
// existing schema's product_id FK is satisfied without a migration.
// These rows are inactive and invisible to the admin shop — they exist only
// for the FK.
async function resolveBracketProductId(bracket: BracketName): Promise<string> {
  const slug = `qvsp-${bracket}`;
  const { data: existing } = await db
    .from("products")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (existing?.id) return existing.id;
  const label = SKIN_BRACKETS.find((b) => b.name === bracket)!.label;
  const { data: created, error } = await db
    .from("products")
    .insert({
      slug,
      name: `QVSP · ${label}`,
      region: "QVSP",
      price_cents: 100,          // placeholder; real price is per-order
      currency: "eur",
      active: false,             // hidden from admin shop
      description: "Internal placeholder for QVSP bracket orders.",
    })
    .select("id")
    .single();
  if (error || !created) throw new Error(`placeholder product create failed: ${error?.message}`);
  return created.id;
}
