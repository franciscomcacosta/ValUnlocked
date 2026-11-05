// Legacy /account route — redirect to the dashboard's Subscribe tab.
import { redirect } from "next/navigation";

export default function AccountRedirect() {
  redirect("/?tab=subscribe");
}
