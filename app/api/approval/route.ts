import { emailFromCookie, postApproval } from "../../generated/hq.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!emailFromCookie(request.headers.get("cookie"))) return new Response("unauthorized", { status: 401 });
  return Response.json(await postApproval(await request.text()));
}
