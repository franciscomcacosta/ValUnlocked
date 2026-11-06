export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { createCheckout } from "@/lib/checkout";
import { getSessionUserId } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const userId = await getSessionUserId(req);
  if (!userId) return Response.json({ error: "login_required" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { product?: string; useCredit?: boolean };
  if (!body.product) return Response.json({ error: "product_required" }, { status: 400 });

  const result = await createCheckout(userId, body.product, body.useCredit ?? true);
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : result.error === "out_of_stock" ? 409 : 400;
    return Response.json({ error: result.error }, { status });
  }
  return Response.json({ orderId: result.orderId, invoiceUrl: result.invoiceUrl });
}
