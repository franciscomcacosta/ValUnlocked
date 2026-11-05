// Legacy /pricing route — redirect to the dashboard's Subscribe tab.
import { redirect } from "next/navigation";

export default function PricingRedirect() {
  redirect("/?tab=subscribe");
}
