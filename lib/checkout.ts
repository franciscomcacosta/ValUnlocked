import { db } from "./supabase";
import { createInvoice } from "./nowpayments";
import { fulfilOrder } from "./fulfil";

export type CheckoutResult =
  | { ok: true; orderId: string; invoiceUrl: string | null } // null = paid fully with credit
  | { ok: false; error: "not_found" | "out_of_stock" | "credit_failed" | "payment_error" };

// Shared by the website API route and the Discord bot.
export async function createCheckout(userId: string, productSlug: string, useCredit: boolean): Promise<CheckoutResult> {
  const { data: product } = await db
    .from("products")
    .select("id, name, price_cents, currency")
    .eq("slug", productSlug)
    .eq("active", true)
    .single();
  if (!product) return { ok: false, error: "not_found" };

  const { data: user } = await db.from("users").select("credit_cents").eq("id", userId).single();
  const creditUsed = useCredit ? Math.min(user?.credit_cents ?? 0, product.price_cents) : 0;
  const charge = product.price_cents - creditUsed;

  const { data: order, error } = await db
    .from("orders")
    .insert({
      user_id: userId,
      product_id: product.id,
      price_cents: product.price_cents,
      credit_used_cents: creditUsed,
      charge_cents: charge,
      currency: product.currency,
    })
    .select("id")
    .single();
  if (error || !order) return { ok: false, error: "payment_error" };

  // Reserve stock first so we never take money for an account we don't have.
  const { data: invId } = await db.rpc("reserve_inventory", { p_order_id: order.id, p_product_id: product.id });
  if (!invId) {
    await db.from("orders").update({ status: "cancelled" }).eq("id", order.id);
    return { ok: false, error: "out_of_stock" };
  }

  if (creditUsed > 0) {
    const { data: spent } = await db.rpc("spend_credit", {
      p_user_id: userId,
      p_cents: creditUsed,
      p_order_id: order.id,
    });
    if (!spent) {
      await db.rpc("release_inventory", { p_order_id: order.id });
      await db.from("orders").update({ status: "cancelled" }).eq("id", order.id);
      return { ok: false, error: "credit_failed" };
    }
  }

  // Fully covered by credit: deliver straight away.
  if (charge === 0) {
    await fulfilOrder(order.id);
    return { ok: true, orderId: order.id, invoiceUrl: null };
  }

  try {
    const invoice = await createInvoice({
      orderId: order.id,
      priceCents: charge,
      currency: product.currency,
      description: product.name,
    });
    await db.from("orders").update({ np_invoice_id: invoice.id }).eq("id", order.id);
    return { ok: true, orderId: order.id, invoiceUrl: invoice.invoice_url };
  } catch (e) {
    console.error(e);
    await cancelOrder(order.id, userId, creditUsed, "cancelled");
    return { ok: false, error: "payment_error" };
  }
}

// Undo an unpaid order: release stock and return any credit it used.
export async function cancelOrder(orderId: string, userId: string, creditUsed: number, status: "cancelled" | "expired" | "failed") {
  await db.from("orders").update({ status }).eq("id", orderId);
  await db.rpc("release_inventory", { p_order_id: orderId });
  // qvsp-reserved orders hold a qvsp_stock row instead — put it back on sale.
  await db.rpc("release_qvsp_stock", { p_order_id: orderId });
  if (creditUsed > 0) {
    await db.rpc("add_credit", { p_user_id: userId, p_cents: creditUsed, p_reason: `order_${status}`, p_order_id: orderId });
  }
}
