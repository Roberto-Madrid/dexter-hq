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

  return new Response(await res.text(), {
    status: res.status,
    headers: { "content-type": "application/json" },
  });
});
