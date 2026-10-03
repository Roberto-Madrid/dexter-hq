import { postCallback } from "../../generated/hq.js";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const raw = await request.text();
  const result = await postCallback(raw, request.headers.get("x-dexter-signature"));
  return new Response(result.duplicate ? "duplicate" : result.status === 200 ? "ok" : "rejected", { status: result.status });
}
