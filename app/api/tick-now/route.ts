import { getTickHealth, postTick } from "../../generated/hq.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const result = await postTick(request.headers.get("x-dexter-tick"));
  return Response.json(result.body ?? { ok: false }, { status: result.status });
}

// Watchdog health: DEXTER_WATCHDOG_SECRET in `x-dexter-watchdog`; 401 with no body otherwise.
export async function GET(request: Request) {
  const result = await getTickHealth(request.headers.get("x-dexter-watchdog"));
  if (!result.body) return new Response(null, { status: result.status, headers: { "cache-control": "no-store" } });
  return Response.json(result.body, { status: result.status, headers: { "cache-control": "no-store" } });
}
