import { db } from "./supabase";
import { notifyDiscordUser } from "./discord";

// Marks the reserved account as sold and the order as fulfilled.
// Safe to call twice: claim_order_for_fulfilment only returns the id once.
export async function fulfilOrder(orderId: string): Promise<boolean> {
  const { data: claimed } = await db.rpc("claim_order_for_fulfilment", { p_order_id: orderId });
  if (!claimed) return false; // already handled by an earlier call

  const { data: order } = await db
    .from("orders")
    .select("id, inventory_id, users(discord_id), products(name)")
    .eq("id", orderId)
    .single();
  if (!order?.inventory_id) {
    // Should not happen (stock is reserved at checkout) – leave as 'paid' for manual handling.
    console.error(`Order ${orderId} paid but has no reserved inventory`);
    return false;
  }

  await db.from("inventory").update({ status: "sold" }).eq("id", order.inventory_id);
  await db.from("orders").update({ status: "fulfilled", fulfilled_at: new Date().toISOString() }).eq("id", orderId);

  const user = order.users as unknown as { discord_id: string } | null;
  const product = order.products as unknown as { name: string } | null;
  if (user?.discord_id) {
    // Don't put credentials in the DM – link to the order page behind Discord login.
    await notifyDiscordUser(
      user.discord_id,
      `✅ Your order for **${product?.name ?? "your account"}** is ready.\n` +
        `View your login details: ${process.env.PUBLIC_BASE_URL}/orders/${orderId}\n` +
        `Change the account and email passwords as soon as you log in.`
    ).catch((e) => console.error("Discord DM failed", e));
  }
  return true;
}
