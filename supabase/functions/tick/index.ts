import "jsr:@supabase/functions-js/edge-runtime.d.ts";

/**
 * Spike tick. Custom auth: the body token is checked inside the database
 * against the vault secret. No token is logged.
 */
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("method", { status: 405 });
  }

  let token = "";
  try {
    const body = await req.json();
    token = typeof body?.token === "string" ? body.token : "";
  } catch {
    return new Response("bad json", { status: 400 });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || !token) {
    return new Response("unconfigured", { status: 500 });
  }

  const res = await fetch(`${url}/rest/v1/rpc/spike_accept_tick`, {
    method: "POST",
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_token: token }),
  });

  const text = await res.text();
  const hq = Deno.env.get("DEXTER_HQ_URL");
  if (res.ok && hq) {
    await fetch(`${hq}/api/tick-now`, {
      method: "POST",
      headers: { "x-dexter-tick": token },
    }).catch(() => undefined);
  }

  return new Response(text, {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
});
