/**
 * Per-minute tick. pg_cron posts the vault token here; the database checks it and records a heartbeat, then the
 * accepted token is forwarded to HQ's `POST /api/tick-now` (which must hold the same value as DEXTER_TICK_SECRET).
 * The response carries HQ's answer as `hq` (an HTTP status, "not_configured", or "unreachable"), so the read-only
 * `net._http_response` rows show whether HQ actually ran, not just that the heartbeat landed. No token is logged.
 */
export type TickFetch = (input: string, init?: RequestInit) => Promise<Response>;

export async function handleTick(
  req: Request,
  env: (name: string) => string | undefined,
  fetchImpl: TickFetch,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method", { status: 405 });
  }

  let token = "";
  try {
    const body = (await req.json()) as { token?: unknown } | null;
    token = typeof body?.token === "string" ? body.token : "";
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const url = env("SUPABASE_URL");
  const key = env("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || !token) {
    return new Response("unconfigured", { status: 500 });
  }

  const res = await fetchImpl(`${url}/rest/v1/rpc/spike_accept_tick`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_token: token }),
  });

  const text = await res.text();
  let beat: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) beat = parsed as Record<string, unknown>;
  } catch {
    beat = null;
  }
  // Forward only a token the database accepted (the RPC answers 200 with { ok: false } for a wrong one).
  if (!res.ok || !beat || beat.ok !== true) {
    return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
  }

  const hqUrl = env("DEXTER_HQ_URL")?.trim().replace(/\/+$/, "");
  let hq: number | "not_configured" | "unreachable" = "not_configured";
  if (hqUrl) {
    try {
      const answer = await fetchImpl(`${hqUrl}/api/tick-now`, {
        method: "POST",
        headers: { "x-dexter-tick": token },
      });
      hq = answer.status;
      await answer.body?.cancel();
    } catch {
      hq = "unreachable";
    }
  }

  return Response.json({ ...beat, hq }, { status: res.status });
}
