// POST /api/sub/renew
// Generates (or returns the existing) renewal invoice for the signed-in
// user's active subscription. Used by the account page and reminder DMs.
import { sessionFromRequest } from "@/lib/session";
import { getActiveSub, createRenewalInvoice } from "@/lib/subs";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const session = sessionFromRequest(req);
  if (!session) return Response.json({ error: "auth_required" }, { status: 401 });

  const sub = await getActiveSub(session.uid);
  if (!sub) return Response.json({ error: "no_active_subscription" }, { status: 404 });

  const res = await createRenewalInvoice(sub.id);
  if (!res.ok) return Response.json({ error: res.error }, { status: 500 });

  return Response.json({ ok: true, invoiceUrl: res.invoiceUrl });
}
