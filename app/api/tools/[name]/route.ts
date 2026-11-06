// Tools endpoint — RETIRED. The one tool (email_grabber) has been replaced
// by the server-side extractor worker, available only to Premium+ orders
// and invisible to end users.
export const runtime = "nodejs";
export async function GET() {
  return Response.json({ error: "gone", detail: "Tools endpoint retired." }, { status: 410 });
}
