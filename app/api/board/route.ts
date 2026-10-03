import { emailFromCookie, getBoard } from "../../generated/hq.js";

export const runtime = "nodejs";

export async function GET(request: Request) {
  if (!emailFromCookie(request.headers.get("cookie"))) return new Response("unauthorized", { status: 401 });
  return Response.json(await getBoard());
}
