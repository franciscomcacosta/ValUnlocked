// Email-grabber page — RETIRED. The extractor is now server-side and gated to
// Premium+ subscribers; no bookmarklet is exposed to users. Redirects home.
import { redirect } from "next/navigation";
export default function EmailGrabberGone() {
  redirect("/");
}
