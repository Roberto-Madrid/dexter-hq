import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { holdVersionChanges } from "../_shared/kernel.js";

type Pin = { family: string; version: string };

function sameToken(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  if (a.length === 0 || a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= (a[index] ?? 0) ^ (b[index] ?? 0);
  return diff === 0;
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("method", { status: 405 });
  const expected = Deno.env.get("DEXTER_TICK_SECRET") ?? "";
  const header = req.headers.get("x-dexter-tick") ?? "";
  if (!sameToken(header, expected)) return new Response("unauthorized", { status: 401 });
  let body: { current?: Pin[]; incoming?: Pin[] } = {};
  try {
    body = await req.json();
  } catch {
    return new Response("bad json", { status: 400 });
  }
  const held = holdVersionChanges(body.current ?? [], body.incoming ?? []);
  return Response.json({ held });
});
