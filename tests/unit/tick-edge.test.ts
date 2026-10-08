import { describe, expect, it } from "vitest";
import { handleTick } from "../../supabase/functions/tick/handler.ts";

const TOKEN = "unit-tick-token";
const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: "https://db.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "unit-service-key",
  DEXTER_HQ_URL: "https://hq.example.test/",
};

type Call = { url: string; init?: RequestInit };

function fakeFetch(rpc: { ok: boolean; id?: number }, hq: number | "throw" = 200) {
  const calls: Call[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/rest/v1/rpc/spike_accept_tick")) return Response.json(rpc);
    if (hq === "throw") throw new Error("network down");
    return new Response(hq === 200 ? JSON.stringify({ ok: true }) : null, { status: hq });
  };
  return { calls, impl };
}

function post(body: unknown = { token: TOKEN }): Request {
  return new Request("https://fn.example.test/tick", { method: "POST", body: JSON.stringify(body) });
}

function env(overrides: Record<string, string | undefined> = {}) {
  const merged: Record<string, string | undefined> = { ...BASE_ENV, ...overrides };
  return (name: string) => merged[name];
}

describe("tick edge function", () => {
  it("forwards an accepted beat to HQ with the token and reports HQ's status", async () => {
    const fetch = fakeFetch({ ok: true, id: 7 }, 200);
    const res = await handleTick(post(), env(), fetch.impl);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 7, hq: 200 });
    const hqCall = fetch.calls.find((call) => call.url === "https://hq.example.test/api/tick-now");
    expect(hqCall?.init?.method).toBe("POST");
    expect(new Headers(hqCall?.init?.headers).get("x-dexter-tick")).toBe(TOKEN);
  });

  it("reports a refused HQ tick (wrong secret) instead of hiding it", async () => {
    const fetch = fakeFetch({ ok: true, id: 8 }, 401);
    const res = await handleTick(post(), env(), fetch.impl);
    expect(await res.json()).toEqual({ ok: true, id: 8, hq: 401 });
  });

  it("reports an unreachable HQ without failing the beat", async () => {
    const fetch = fakeFetch({ ok: true, id: 9 }, "throw");
    const res = await handleTick(post(), env(), fetch.impl);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, id: 9, hq: "unreachable" });
  });

  it("says so when DEXTER_HQ_URL is missing, so the beat alone never looks like a tick", async () => {
    const fetch = fakeFetch({ ok: true, id: 10 });
    const res = await handleTick(post(), env({ DEXTER_HQ_URL: undefined }), fetch.impl);
    expect(await res.json()).toEqual({ ok: true, id: 10, hq: "not_configured" });
    expect(fetch.calls).toHaveLength(1);
  });

  it("never forwards a token the database rejected", async () => {
    const fetch = fakeFetch({ ok: false });
    const res = await handleTick(post({ token: "wrong" }), env(), fetch.impl);
    expect(await res.json()).toEqual({ ok: false });
    expect(fetch.calls.some((call) => call.url.includes("/api/tick-now"))).toBe(false);
  });

  it("keeps the method, body and config guards", async () => {
    const fetch = fakeFetch({ ok: true, id: 1 });
    expect((await handleTick(new Request("https://fn.example.test/tick"), env(), fetch.impl)).status).toBe(405);
    const bad = new Request("https://fn.example.test/tick", { method: "POST", body: "{" });
    expect((await handleTick(bad, env(), fetch.impl)).status).toBe(400);
    expect((await handleTick(post(), env({ SUPABASE_URL: undefined }), fetch.impl)).status).toBe(500);
    expect((await handleTick(post({}), env(), fetch.impl)).status).toBe(500);
    expect(fetch.calls).toHaveLength(0);
  });
});
