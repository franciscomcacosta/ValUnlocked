import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.redirect(`${process.env.PUBLIC_BASE_URL}/`, { status: 303 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
