import { postTick } from "../../generated/hq.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const result = await postTick(request.headers.get("x-dexter-tick"));
  return Response.json(result.body ?? { ok: false }, { status: result.status });
}
