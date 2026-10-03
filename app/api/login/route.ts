import { NextResponse } from "next/server";
import { login } from "../../generated/hq.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const form = await request.formData();
  const email = String(form.get("email") ?? "");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const secure = request.headers.get("x-forwarded-proto") === "https";
  const origin = `${secure ? "https" : "http"}://${host}`;
  const result = login(email, secure);
  if (!result.ok) return NextResponse.redirect(new URL("/login?error=1", origin), { status: 303 });
  const response = NextResponse.redirect(new URL("/", origin), { status: 303 });
  response.cookies.set("dexter_session", result.token, {
    httpOnly: true,
    path: "/",
    sameSite: "lax",
    secure,
    maxAge: 604800,
  });
  return response;
}
