// POST /api/stock/buy
//   { region, bracket, useCredit? }           — random pick in skin-range bracket
//   { region, skin: "<label>", useCredit? }   — cheapest qvsp account with that skin
//
// Both paths: reserve a qvsp_stock row, apply tier discount, create a
// nowpayments invoice. IPN handler calls qvsp POST /orders at payment-final.
import { sessionFromRequest } from "@/lib/session";
import { db } from "@/lib/supabase";
import {
  SKIN_BRACKETS,
  priceForBracket,
  FEATURED_SKINS,
  featuredPriceForUser,
  xrayPriceForUltra,
  type BracketName,
  type SubTier,
  type FeaturedSkin,
} from "@/lib/pricing";
import { createInvoice } from "@/lib/nowpayments";

export const runtime = "nodejs";

const REGIONS = new Set(["EU", "AP", "KR", "LATAM", "BR"]);

export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as
    | { region?: string; bracket?: string; skin?: string; account_id?: string; useCredit?: boolean }
    | null;
  const region = body?.region?.toUpperCase();
  if (!region || !REGIONS.has(region)) {
    return Response.json({ error: "invalid_region" }, { status: 400 });
  }

  // Get the user's tier once.
  const { data: sub } = await db
    .from("subscriptions")
    .select("tier")
    .eq("user_id", session.uid)
    .in("status", ["active", "grace"])
    .maybeSingle();
  const tier = (sub?.tier ?? null) as SubTier | null;

  // Branch: X-RAY specific-account (ultra only) > featured skin > bracket
  if (body?.account_id) {
    if (tier !== "ultra") return Response.json({ error: "ultra_required" }, { status: 403 });
    return handleXrayBuy({ region, accountId: body.account_id, useCredit: body.useCredit !== false, userId: session.uid });
  }
  if (body?.skin) {
    return handleFeaturedSkinBuy({ region, skinLabel: body.skin, useCredit: body.useCredit !== false, userId: session.uid, tier });
  }
  if (body?.bracket) {
    return handleBracketBuy({ region, bracketName: body.bracket as BracketName, useCredit: body.useCredit !== false, userId: session.uid, tier });
  }
  return Response.json({ error: "bracket_or_skin_or_account_required" }, { status: 400 });
}

// ─── X-RAY (Ultra-only specific-account purchase) ─────────────

async function handleXrayBuy(opts: { region: string; accountId: string; useCredit: boolean; userId: string }): Promise<Response> {
  // Fetch the specific account to confirm it exists, matches region, and is
  // available. Reserve it and invoice.
  const { data: acc, error: aErr } = await db
    .from("qvsp_stock")
    .select("qvsp_id, region, qvsp_price_cents, skin_count")
    .eq("qvsp_id", opts.accountId)
    .eq("region", opts.region)
    .is("reserved_order_id", null)
    .is("removed_at", null)
    .eq("claimed", false)
    .maybeSingle();
  if (aErr) return Response.json({ error: aErr.message }, { status: 500 });
  if (!acc) return Response.json({ error: "account_unavailable" }, { status: 409 });

  const pricing = xrayPriceForUltra(acc.qvsp_price_cents);
  const productId = await resolveXrayProductId();

  return reserveAndInvoice({
    userId: opts.userId,
    productId,
    region: opts.region,
    candidates: [acc.qvsp_id],
    publicCents: pricing.publicCents,
    finalCents: pricing.finalCents,
    useCredit: opts.useCredit,
    description: `Valorant account · X-RAY pick · ${opts.region} · ${acc.skin_count} skins`,
  });
}

// ─── Bracket (random in range) ─────────────────────────────────

async function handleBracketBuy(opts: { region: string; bracketName: BracketName; useCredit: boolean; userId: string; tier: SubTier | null }): Promise<Response> {
  const bracket = SKIN_BRACKETS.find((b) => b.name === opts.bracketName);
  if (!bracket) return Response.json({ error: "invalid_bracket" }, { status: 400 });
  const pricing = priceForBracket(bracket.name, opts.tier);

  const { data: candidates, error: cErr } = await db
    .from("qvsp_stock")
    .select("qvsp_id")
    .eq("region", opts.region)
    .eq("kind", "skinned")
    .gte("skin_count", bracket.minSkins)
    .lte("skin_count", bracket.maxSkins)
    // Exclude accounts too expensive for the bracket price to leave a safe
    // margin at Ultra's max discount. They stay in qvsp_stock and can still
    // sell via the Guaranteed Skin path (dynamic pricing).
    .lte("qvsp_price_cents", bracket.maxAcceptableCostCents)
    .is("reserved_order_id", null)
    .is("removed_at", null)
    .eq("claimed", false)
    .limit(50);
  if (cErr) return Response.json({ error: cErr.message }, { status: 500 });
  if (!candidates?.length) return Response.json({ error: "out_of_stock" }, { status: 409 });

  const productId = await resolveBracketProductId(bracket.name);
  const shuffled = [...candidates].sort(() => Math.random() - 0.5);
  return reserveAndInvoice({
    userId: opts.userId,
    productId,
    region: opts.region,
    candidates: shuffled.map((c) => c.qvsp_id),
    publicCents: pricing.publicCents,
    finalCents: pricing.finalCents,
    useCredit: opts.useCredit,
    description: `Valorant account · ${bracket.label} · ${opts.region}`,
  });
}

// ─── Featured skin (cheapest with that skin) ───────────────────

async function handleFeaturedSkinBuy(opts: { region: string; skinLabel: string; useCredit: boolean; userId: string; tier: SubTier | null }): Promise<Response> {
  const skin = FEATURED_SKINS.find((s) => s.label === opts.skinLabel) as FeaturedSkin | undefined;
  if (!skin) return Response.json({ error: "invalid_skin" }, { status: 400 });

  // Grab the CHEAPEST available qvsp rows that contain this skin. Reserve
  // in cheapest-first order so we always lock the one the display price
  // was based on.
  const { data: candidates, error: cErr } = await db
    .from("qvsp_stock")
    .select("qvsp_id, qvsp_price_cents")
    .eq("region", opts.region)
    .eq("kind", "skinned")
    .overlaps("skins", skin.matchAny)
    .is("reserved_order_id", null)
    .is("removed_at", null)
    .eq("claimed", false)
    .order("qvsp_price_cents", { ascending: true })
    .limit(10);
  if (cErr) return Response.json({ error: cErr.message }, { status: 500 });
  if (!candidates?.length) return Response.json({ error: "skin_unavailable" }, { status: 409 });

  const cheapest = candidates[0].qvsp_price_cents as number;
  const pricing = featuredPriceForUser(cheapest, skin.minPriceCents, opts.tier);
  const productId = await resolveFeaturedSkinProductId(skin.label);

  return reserveAndInvoice({
    userId: opts.userId,
    productId,
    region: opts.region,
    candidates: candidates.map((c) => c.qvsp_id),
    publicCents: pricing.publicCents,
    finalCents: pricing.finalCents,
    useCredit: opts.useCredit,
    description: `Valorant account · guaranteed ${skin.label} · ${opts.region}`,
  });
}

// ─── Shared reserve + invoice flow ─────────────────────────────

interface ReserveArgs {
  userId: string;
  productId: string;
  region: string;
  candidates: string[];
  publicCents: number;
  finalCents: number;
  useCredit: boolean;
  description: string;
}

async function reserveAndInvoice(args: ReserveArgs): Promise<Response> {
  const { data: order, error: oErr } = await db
    .from("orders")
    .insert({
      user_id: args.userId,
      product_id: args.productId,
      price_cents: args.publicCents,
      credit_used_cents: 0,
      charge_cents: args.finalCents,
      currency: "eur",
    })
    .select("id")
    .single();
  if (oErr || !order) {
    return Response.json({ error: "order_create_failed", detail: oErr?.message }, { status: 500 });
  }

  let reservedQvspId: string | null = null;
  for (const id of args.candidates) {
    const { data: picked } = await db.rpc("reserve_qvsp_stock", {
      p_order_id: order.id,
      p_qvsp_id: id,
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

  // Apply store credit.
  let credit = 0;
  let charge = args.finalCents;
  if (args.useCredit) {
    const { data: user } = await db.from("users").select("credit_cents").eq("id", args.userId).single();
    credit = Math.min(user?.credit_cents ?? 0, args.finalCents);
    charge = args.finalCents - credit;
    if (credit > 0) {
      const { data: spent } = await db.rpc("spend_credit", {
        p_user_id: args.userId,
        p_cents: credit,
        p_order_id: order.id,
      });
      if (!spent) {
        credit = 0;
        charge = args.finalCents;
      } else {
        await db
          .from("orders")
          .update({ credit_used_cents: credit, charge_cents: charge })
          .eq("id", order.id);
      }
    }
  }

  if (charge === 0) {
    await db.from("orders").update({ status: "paid", paid_at: new Date().toISOString() }).eq("id", order.id);
    return Response.json({ ok: true, orderId: order.id, invoiceUrl: null, deliveredByCredit: true });
  }

  try {
    const invoice = await createInvoice({
      orderId: order.id,
      priceCents: charge,
      currency: "eur",
      description: args.description,
    });
    await db.from("orders").update({ np_invoice_id: invoice.id }).eq("id", order.id);
    return Response.json({
      ok: true,
      orderId: order.id,
      invoiceUrl: invoice.invoice_url,
      region: args.region,
      amountCents: charge,
    });
  } catch (e) {
    console.error("[stock/buy] invoice failed", e);
    await db.from("orders").update({ status: "cancelled" }).eq("id", order.id);
    await db.rpc("release_qvsp_stock", { p_order_id: order.id });
    if (credit > 0) {
      await db.rpc("add_credit", {
        p_user_id: args.userId,
        p_cents: credit,
        p_reason: "order_cancelled",
        p_order_id: order.id,
      });
    }
    return Response.json({ error: "payment_provider_error" }, { status: 502 });
  }
}

// ─── Placeholder product rows (satisfies the products.id FK) ───

// Product-row names are what the buyer sees in My Purchases + /orders/[id].
// They MUST NOT mention qvsp — knowing the upstream supplier lets customers
// cut us out. Use clean, user-facing copy (bracket label, skin name, "Specific
// account"). Slugs stay internal (DB only) so legacy rows resolve unchanged.
//
// Historical rows already have "QVSP · ..." names — they're rewritten by the
// migration helper in this file's SQL fix-up script (run once), but the code
// below is what prevents NEW rows from leaking the supplier name.

async function resolveBracketProductId(bracket: BracketName): Promise<string> {
  const slug = `qvsp-${bracket}`;       // internal slug stays as-is for lookup
  const { data: existing } = await db.from("products").select("id").eq("slug", slug).maybeSingle();
  if (existing?.id) return existing.id;
  const label = SKIN_BRACKETS.find((b) => b.name === bracket)!.label;
  const { data: created, error } = await db
    .from("products")
    .insert({
      slug,
      name: `${label} skins`,                // ← user-facing: "26-50 skins"
      region: "—",
      price_cents: 100,
      currency: "eur",
      active: false,
      description: "Random account from the chosen skin bracket.",
    })
    .select("id")
    .single();
  if (error || !created) throw new Error(`placeholder product create failed: ${error?.message}`);
  return created.id;
}

async function resolveXrayProductId(): Promise<string> {
  const slug = "qvsp-xray";
  const { data: existing } = await db.from("products").select("id").eq("slug", slug).maybeSingle();
  if (existing?.id) return existing.id;
  const { data: created, error } = await db
    .from("products")
    .insert({
      slug,
      name: "Specific account",              // ← user-facing
      region: "—",
      price_cents: 100,
      currency: "eur",
      active: false,
      description: "Ultra-member specific-account pick via X-RAY.",
    })
    .select("id")
    .single();
  if (error || !created) throw new Error(`placeholder product create failed: ${error?.message}`);
  return created.id;
}

async function resolveFeaturedSkinProductId(skinLabel: string): Promise<string> {
  const slug = `qvsp-skin-${skinLabel.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const { data: existing } = await db.from("products").select("id").eq("slug", slug).maybeSingle();
  if (existing?.id) return existing.id;
  const { data: created, error } = await db
    .from("products")
    .insert({
      slug,
      name: skinLabel,                       // ← user-facing: "Prime Vandal"
      region: "—",
      price_cents: 100,
      currency: "eur",
      active: false,
      description: `Guaranteed account containing ${skinLabel}.`,
    })
    .select("id")
    .single();
  if (error || !created) throw new Error(`placeholder product create failed: ${error?.message}`);
  return created.id;
}
