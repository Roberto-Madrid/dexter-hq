import { describe, expect, it } from "vitest";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import {
  callConnectorTool,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  hashBotToken,
  loadConnectorSheetText,
  type ConnectorStore,
} from "../../hq/connector.ts";
import { handleMcpHttp } from "../../hq/mcp.ts";
import { issueSession, readSession, sessionToken } from "../../hq/session.ts";
import { MemoryStore } from "../../hq/memory.ts";
import { resumeAll, stopAll } from "../../hq/stop.ts";
import { createScriptedCeo } from "../../hq/scripted-ceo.ts";
import { SHIPPED_CREWS } from "../../hq/crews.ts";
import type { HqDeps } from "../../hq/deps.ts";
import {
  LEAD_SCOPES,
  createGhRepoCheck,
  handleVenturesHttp,
  heartbeatStatus,
  type RepoCheck,
  type VenturesDeps,
} from "../../hq/ventures.ts";

const sheet = parseRoleSheet(loadConnectorSheetText());
const OWNER = "11111111-1111-4111-8111-111111111111";
const CEO = "33333333-3333-4333-8333-333333333333";
const BARBER = "44444444-4444-4444-8444-444444444444";
const CEO_TOKEN = "unit-ceo-token";
const BARBER_TOKEN = "unit-barber-token";
const SECRET = "unit-session-secret";
const OWNER_EMAIL = "owner@example.com";
const T0 = Date.parse("2026-10-08T09:00:00.000Z");
const ENDPOINT = "http://127.0.0.1/api/board?view=ventures";

function ownerCookie(): string {
  return `dexter_session=${issueSession(OWNER_EMAIL, SECRET, T0 + 3_600_000)}`;
}

function ownerFromCookie(header: string | null): string | null {
  const token = sessionToken(header);
  return token ? (readSession(token, SECRET, T0)?.email ?? null) : null;
}

function seedStore(options?: { stopped?: boolean }): ConnectorStore {
  return createMemoryConnectorStore({
    stopped: options?.stopped ?? false,
    bots: [
      {
        id: CEO,
        ownerId: OWNER,
        name: "Dexter",
        kind: "ceo",
        repos: [],
        tools: ["whoami", "get_context", "assign", "heartbeat"],
        currentTask: null,
        heartbeatAt: null,
      },
      {
        id: BARBER,
        ownerId: OWNER,
        name: "barber-lead",
        kind: "lead",
        repos: ["Roberto-Madrid/dexter-barber"],
        tools: [...LEAD_SCOPES],
        currentTask: null,
        heartbeatAt: new Date(T0 - 10_000).toISOString(),
      },
    ],
    tokens: [
      { tokenHash: hashBotToken(CEO_TOKEN), botId: CEO, scopes: ["whoami", "get_context", "assign", "heartbeat"] },
      { tokenHash: hashBotToken(BARBER_TOKEN), botId: BARBER, scopes: [...LEAD_SCOPES] },
    ],
  });
}

function reachable(calls: string[] = []): RepoCheck {
  return async (repo) => {
    calls.push(repo);
    return "reachable";
  };
}

function deps(store: ConnectorStore, extra?: Partial<VenturesDeps>): VenturesDeps {
  return {
    store,
    repoCheck: reachable(),
    ownerFromCookie,
    now: () => new Date(T0),
    ...extra,
  };
}

function connectorDeps(store: ConnectorStore, nowMs = T0) {
  return createDefaultConnectorDeps({
    store,
    sheet,
    cursor: null,
    cursorConfigured: false,
    ownerId: OWNER,
    now: () => new Date(nowMs).toISOString(),
  });
}

async function call(
  d: VenturesDeps,
  method: "GET" | "POST",
  body?: unknown,
  headers: Record<string, string> = { cookie: ownerCookie() },
): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
  const response = await handleVenturesHttp(
    new Request(ENDPOINT, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    d,
  );
  const text = await response.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = { raw: text };
  }
  return { status: response.status, json, headers: response.headers };
}

const TICKETS = {
  action: "add_venture",
  name: "Tickets",
  repo: "Roberto-Madrid/dexter-tickets",
  leadName: "tickets-lead",
  brief: "Event ticketing for small venues.",
};

async function mcp(token: string, name: string, args: Record<string, unknown>, store: ConnectorStore) {
  return handleMcpHttp(
    new Request("http://127.0.0.1/api/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    }),
    connectorDeps(store),
  );
}

function hqDeps(connector: ConnectorStore): HqDeps {
  return {
    ceo: createScriptedCeo(sheet),
    ceoEnabled: true,
    sheet,
    catalog: [],
    shippedCrews: SHIPPED_CREWS,
    exhaustedPools: [],
    knownHosts: [],
    slotCap: 3,
    runtimes: {},
    controlReachable: true,
    connector,
  };
}

describe("ventures: owner-only", () => {
  it("refuses a request with no owner session", async () => {
    const store = seedStore();
    expect((await call(deps(store), "GET", undefined, {})).status).toBe(401);
    expect((await call(deps(store), "POST", TICKETS, {})).status).toBe(401);
    expect((await store.listBots()).length).toBe(2);
  });

  it("refuses a bot token, as a bearer header or as a cookie", async () => {
    const store = seedStore();
    const bearer = await call(deps(store), "POST", TICKETS, { authorization: `Bearer ${CEO_TOKEN}` });
    expect(bearer.status).toBe(401);
    const cookie = await call(deps(store), "POST", TICKETS, { cookie: `dexter_session=${CEO_TOKEN}` });
    expect(cookie.status).toBe(401);
    const list = await call(deps(store), "GET", undefined, { authorization: `Bearer ${BARBER_TOKEN}` });
    expect(list.status).toBe(401);
    expect((await store.listBots()).length).toBe(2);
  });

  it("refuses a session signed with another secret", async () => {
    const store = seedStore();
    const forged = `dexter_session=${issueSession(OWNER_EMAIL, "other-secret", T0 + 3_600_000)}`;
    expect((await call(deps(store), "POST", TICKETS, { cookie: forged })).status).toBe(401);
  });
});

describe("ventures: create", () => {
  it("creates a lead with the venture repo and lead scopes, and returns the token once", async () => {
    const store = seedStore();
    const created = await call(deps(store), "POST", TICKETS);
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const token = String(created.json.token);
    expect(token).toMatch(/^dxt_[A-Za-z0-9_-]{43}$/);
    const venture = created.json.venture as Record<string, unknown>;
    expect(venture).toMatchObject({
      name: "Tickets",
      repo: "Roberto-Madrid/dexter-tickets",
      leadName: "tickets-lead",
      brief: "Event ticketing for small venues.",
      status: "never_seen",
      heartbeatAgeSeconds: null,
    });

    const auth = await store.authenticate(hashBotToken(token));
    expect(auth).toMatchObject({ kind: "lead", name: "tickets-lead", repos: ["Roberto-Madrid/dexter-tickets"], ownerId: OWNER });
    expect(auth?.scopes).toEqual([...LEAD_SCOPES]);
    expect(auth?.id).toBe(venture.botId);

    const events = await store.listEvents();
    const add = events.filter((event) => event.action === "add_venture");
    expect(add).toHaveLength(1);
    expect(add[0]?.target).toBe(venture.botId);
    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(await store.listRoster())).not.toContain(token);
  });

  it("lets the new token reach /api/mcp with lead scopes and refuses other repos", async () => {
    const store = seedStore();
    const token = String((await call(deps(store), "POST", TICKETS)).json.token);
    const whoami = await mcp(token, "whoami", {}, store);
    expect(whoami.status).toBe(200);
    const body = (await whoami.json()) as { result: { structuredContent: Record<string, unknown> } };
    expect(body.result.structuredContent).toMatchObject({ kind: "lead", name: "tickets-lead" });

    const auth = await store.authenticate(hashBotToken(token));
    const launch = await callConnectorTool(connectorDeps(store), auth, "launch_agent", {
      repo: "Roberto-Madrid/dexter-barber",
      role: "builder",
      brief: "Change one label.",
      idempotencyKey: "other-repo-1",
    });
    expect(launch.structuredContent).toMatchObject({ status: "refused", reason: "repo_out_of_scope" });
  });

  it("refuses a duplicate venture name, repo, or lead name inline", async () => {
    const store = seedStore();
    expect((await call(deps(store), "POST", TICKETS)).status).toBe(201);
    const name = await call(deps(store), "POST", { ...TICKETS, name: "tickets", repo: "Roberto-Madrid/x", leadName: "x-lead" });
    expect(name.status).toBe(409);
    expect(name.json).toMatchObject({ status: "refused", reason: "name_taken", field: "name" });
    const repo = await call(deps(store), "POST", { ...TICKETS, name: "Other", leadName: "other-lead" });
    expect(repo.json).toMatchObject({ status: "refused", reason: "repo_taken", field: "repo" });
    const lead = await call(deps(store), "POST", { ...TICKETS, name: "Other", repo: "Roberto-Madrid/other" });
    expect(lead.json).toMatchObject({ status: "refused", reason: "lead_name_taken", field: "leadName" });
    // A lead made by hand (no add_venture event) is named after its repo.
    const barber = await call(deps(store), "POST", { ...TICKETS, name: "Dexter-Barber", repo: "Roberto-Madrid/b2", leadName: "b2" });
    expect(barber.json).toMatchObject({ reason: "name_taken", field: "name" });
    expect((await store.listBots()).filter((bot) => bot.kind === "lead")).toHaveLength(2);
  });

  it("refuses an unreachable repo and a failed lookup differently, and creates nothing", async () => {
    const store = seedStore();
    const missing = await call(deps(store, { repoCheck: async () => "not_reachable" }), "POST", TICKETS);
    expect(missing.status).toBe(422);
    expect(missing.json).toMatchObject({ status: "refused", reason: "repo_not_reachable", field: "repo" });
    const down = await call(deps(store, { repoCheck: async () => "unavailable" }), "POST", TICKETS);
    expect(down.status).toBe(503);
    expect(down.json).toMatchObject({ status: "refused", reason: "repo_check_unavailable", field: "repo" });
    const thrown = await call(
      deps(store, {
        repoCheck: async () => {
          throw new Error("boom");
        },
      }),
      "POST",
      TICKETS,
    );
    expect(thrown.json).toMatchObject({ reason: "repo_check_unavailable" });
    expect((await store.listBots()).length).toBe(2);
  });

  it("refuses while STOP ALL is on without checking the repo", async () => {
    const store = seedStore({ stopped: true });
    const calls: string[] = [];
    const stopped = await call(deps(store, { repoCheck: reachable(calls) }), "POST", TICKETS);
    expect(stopped.status).toBe(409);
    expect(stopped.json).toMatchObject({ status: "refused", reason: "stopped" });
    expect(calls).toEqual([]);
    expect((await store.listBots()).length).toBe(2);
  });

  it("validates the fields", async () => {
    const store = seedStore();
    const repo = await call(deps(store), "POST", { ...TICKETS, repo: "not a repo" });
    expect(repo.status).toBe(400);
    expect(repo.json).toMatchObject({ reason: "invalid_input", field: "repo" });
    const name = await call(deps(store), "POST", { ...TICKETS, name: "  " });
    expect(name.json).toMatchObject({ reason: "invalid_input", field: "name" });
    const lead = await call(deps(store), "POST", { ...TICKETS, leadName: "" });
    expect(lead.json).toMatchObject({ reason: "invalid_input", field: "leadName" });
    const brief = await call(deps(store), "POST", { ...TICKETS, brief: "x".repeat(2001) });
    expect(brief.json).toMatchObject({ reason: "invalid_input", field: "brief" });
    const action = await call(deps(store), "POST", { ...TICKETS, action: "nope" });
    expect(action.json).toMatchObject({ reason: "invalid_input", field: "action" });
  });
});

describe("ventures: token shown once and idempotent create", () => {
  it("never returns the token from the list or from a retried create", async () => {
    const store = seedStore();
    const first = await call(deps(store), "POST", { ...TICKETS, idempotencyKey: "form-1" });
    const token = String(first.json.token);
    const list = await call(deps(store), "GET");
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain(token);
    expect(JSON.stringify(list.json)).not.toContain(hashBotToken(token));

    const retry = await call(deps(store), "POST", { ...TICKETS, idempotencyKey: "form-1" });
    expect(retry.status).toBe(200);
    expect(retry.json).toMatchObject({ status: "already_created", token: null });
    expect((retry.json.venture as Record<string, unknown>).botId).toBe((first.json.venture as Record<string, unknown>).botId);
    expect(JSON.stringify(retry.json)).not.toContain(token);

    const plain = await call(deps(store), "POST", TICKETS);
    expect(plain.json).toMatchObject({ reason: "name_taken" });
    expect((await store.listBots()).filter((bot) => bot.name === "tickets-lead")).toHaveLength(1);
    expect((await store.listEvents()).filter((event) => event.action === "add_venture")).toHaveLength(1);
    // The original token still works: a retry mints nothing and revokes nothing.
    expect(await store.authenticate(hashBotToken(token))).not.toBeNull();
  });

  it("mints exactly one lead when two creates race", async () => {
    const store = seedStore();
    const results = await Promise.all([
      call(deps(store), "POST", { ...TICKETS, idempotencyKey: "a" }),
      call(deps(store), "POST", { ...TICKETS, idempotencyKey: "b" }),
    ]);
    expect(results.map((item) => item.status).sort()).toEqual([201, 409]);
    expect((await store.listBots()).filter((bot) => bot.name === "tickets-lead")).toHaveLength(1);
  });
});

describe("ventures: rotate token", () => {
  it("invalidates the old token at once and returns the new one once", async () => {
    const store = seedStore();
    const created = await call(deps(store), "POST", TICKETS);
    const oldToken = String(created.json.token);
    const botId = String((created.json.venture as Record<string, unknown>).botId);

    const rotated = await call(deps(store), "POST", { action: "rotate_token", botId });
    expect(rotated.status).toBe(200);
    expect(rotated.headers.get("cache-control")).toBe("no-store");
    const newToken = String(rotated.json.token);
    expect(newToken).toMatch(/^dxt_[A-Za-z0-9_-]{43}$/);
    expect(newToken).not.toBe(oldToken);
    expect(rotated.json).toMatchObject({ status: "rotated" });

    expect(await store.authenticate(hashBotToken(oldToken))).toBeNull();
    const refused = await mcp(oldToken, "whoami", {}, store);
    expect(refused.status).toBe(401);
    const ok = await mcp(newToken, "heartbeat", { task: "idle" }, store);
    expect(ok.status).toBe(200);
    expect(((await store.authenticate(hashBotToken(newToken))) ?? { scopes: [] }).scopes).toEqual([...LEAD_SCOPES]);

    const events = await store.listEvents();
    expect(events.some((event) => event.action === "rotate_token" && event.target === botId)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(newToken);
    expect(JSON.stringify(events)).not.toContain(oldToken);
    expect(JSON.stringify((await call(deps(store), "GET")).json)).not.toContain(newToken);
  });

  it("rotates a lead made by hand and refuses an unknown or non-lead bot", async () => {
    const store = seedStore();
    const rotated = await call(deps(store), "POST", { action: "rotate_token", botId: BARBER });
    expect(rotated.status).toBe(200);
    expect(await store.authenticate(hashBotToken(BARBER_TOKEN))).toBeNull();
    const unknown = await call(deps(store), "POST", { action: "rotate_token", botId: "55555555-5555-4555-8555-555555555555" });
    expect(unknown.status).toBe(404);
    expect(unknown.json).toMatchObject({ reason: "unknown_venture" });
    const ceo = await call(deps(store), "POST", { action: "rotate_token", botId: CEO });
    expect(ceo.status).toBe(404);
    expect(await store.authenticate(hashBotToken(CEO_TOKEN))).not.toBeNull();
  });

  it("refuses rotation from a bot token", async () => {
    const store = seedStore();
    const refused = await call(deps(store), "POST", { action: "rotate_token", botId: BARBER }, { authorization: `Bearer ${BARBER_TOKEN}` });
    expect(refused.status).toBe(401);
    expect(await store.authenticate(hashBotToken(BARBER_TOKEN))).not.toBeNull();
  });

  it("keeps a token rotated during STOP ALL suspended until Resume", async () => {
    const store = seedStore();
    const hq = new MemoryStore();
    await stopAll(hq, hqDeps(store));
    const rotated = await call(deps(store), "POST", { action: "rotate_token", botId: BARBER });
    expect(rotated.status).toBe(200);
    const token = String(rotated.json.token);
    expect((await store.authenticate(hashBotToken(token)))?.suspended).toBe(true);
    await resumeAll(hq, hqDeps(store));
    expect((await store.authenticate(hashBotToken(token)))?.suspended).toBe(false);
  });
});

describe("ventures: STOP ALL covers new leads", () => {
  it("suspends a new lead's token and Resume restores it", async () => {
    const store = seedStore();
    const token = String((await call(deps(store), "POST", TICKETS)).json.token);
    const hq = new MemoryStore();
    await stopAll(hq, hqDeps(store));
    expect((await store.authenticate(hashBotToken(token)))?.suspended).toBe(true);
    await resumeAll(hq, hqDeps(store));
    expect((await store.authenticate(hashBotToken(token)))?.suspended).toBe(false);
  });
});

describe("ventures: status", () => {
  const issued = new Date(T0 - 3_600_000).toISOString();

  it("applies the Live / Wait / Never seen thresholds", () => {
    const now = new Date(T0);
    expect(heartbeatStatus({ heartbeatAt: null, tokenIssuedAt: issued }, now)).toEqual({ status: "never_seen", heartbeatAgeSeconds: null });
    expect(heartbeatStatus({ heartbeatAt: new Date(T0 - 7_200_000).toISOString(), tokenIssuedAt: issued }, now)).toEqual({
      status: "never_seen",
      heartbeatAgeSeconds: null,
    });
    expect(heartbeatStatus({ heartbeatAt: new Date(T0 - 6_000).toISOString(), tokenIssuedAt: issued }, now)).toEqual({ status: "live", heartbeatAgeSeconds: 6 });
    expect(heartbeatStatus({ heartbeatAt: new Date(T0 - 60_000).toISOString(), tokenIssuedAt: issued }, now)).toEqual({ status: "live", heartbeatAgeSeconds: 60 });
    expect(heartbeatStatus({ heartbeatAt: new Date(T0 - 61_000).toISOString(), tokenIssuedAt: issued }, now)).toEqual({ status: "wait", heartbeatAgeSeconds: 61 });
    expect(heartbeatStatus({ heartbeatAt: new Date(T0 - 840_000).toISOString(), tokenIssuedAt: null }, now)).toEqual({ status: "wait", heartbeatAgeSeconds: 840 });
  });

  it("lists every venture with its lead status, heartbeat age, and repo", async () => {
    const store = seedStore();
    const created = await call(deps(store, { now: () => new Date(T0 - 120_000) }), "POST", TICKETS);
    const token = String(created.json.token);
    const list = await call(deps(store), "GET");
    expect(list.json.stopped).toBe(false);
    const ventures = list.json.ventures as Record<string, unknown>[];
    expect(ventures.map((item) => [item.name, item.repo, item.leadName, item.status, item.heartbeatAgeSeconds])).toEqual([
      ["dexter-barber", "Roberto-Madrid/dexter-barber", "barber-lead", "live", 10],
      ["Tickets", "Roberto-Madrid/dexter-tickets", "tickets-lead", "never_seen", null],
    ]);
    const auth = await store.authenticate(hashBotToken(token));
    await callConnectorTool(connectorDeps(store, T0 - 90_000), auth, "heartbeat", { task: "idle" });
    const after = (await call(deps(store), "GET")).json.ventures as Record<string, unknown>[];
    expect(after[1]).toMatchObject({ status: "wait", heartbeatAgeSeconds: 90 });
  });
});

describe("ventures: Dexter's roster", () => {
  it("gives the CEO every bot with kind, repos and status, and no token material", async () => {
    const store = seedStore();
    const token = String((await call(deps(store), "POST", TICKETS)).json.token);
    const ceo = await store.authenticate(hashBotToken(CEO_TOKEN));
    const context = await callConnectorTool(connectorDeps(store), ceo, "get_context", {});
    const bots = context.structuredContent.bots as Record<string, unknown>[];
    expect(bots.map((bot) => [bot.name, bot.kind, bot.repos, bot.status])).toEqual([
      ["Dexter", "ceo", [], "never_seen"],
      ["barber-lead", "lead", ["Roberto-Madrid/dexter-barber"], "live"],
      ["tickets-lead", "lead", ["Roberto-Madrid/dexter-tickets"], "never_seen"],
    ]);
    expect(bots[2]).toMatchObject({ venture: "Tickets" });
    expect(typeof bots[2]?.id).toBe("string");
    const text = JSON.stringify(context);
    expect(text).not.toContain(token);
    expect(text).not.toContain(hashBotToken(token));
    expect(text).not.toContain(hashBotToken(BARBER_TOKEN));
  });

  it("gives a lead no roster and no other venture's repo", async () => {
    const store = seedStore();
    const token = String((await call(deps(store), "POST", TICKETS)).json.token);
    const lead = await store.authenticate(hashBotToken(token));
    const context = await callConnectorTool(connectorDeps(store), lead, "get_context", {});
    expect(context.isError).toBe(false);
    expect(context.structuredContent).not.toHaveProperty("bots");
    const text = JSON.stringify(context);
    expect(text).not.toContain("dexter-barber");
    expect(text).not.toContain("barber-lead");

    const barber = await store.authenticate(hashBotToken(BARBER_TOKEN));
    const other = JSON.stringify(await callConnectorTool(connectorDeps(store), barber, "get_context", {}));
    expect(other).not.toContain("dexter-tickets");
  });
});

describe("GitHub repo check", () => {
  function fakeFetch(status: number, seen: { url: string; auth: string | null }[] = []): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify({ full_name: "Roberto-Madrid/dexter-tickets" }), { status });
    }) as typeof fetch;
  }

  it("calls the GitHub repo endpoint with the HQ token", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const check = createGhRepoCheck({ token: "unit-gh", fetchImpl: fakeFetch(200, seen) });
    expect(await check("Roberto-Madrid/dexter-tickets")).toBe("reachable");
    expect(seen).toEqual([{ url: "https://api.github.com/repos/Roberto-Madrid/dexter-tickets", auth: "Bearer unit-gh" }]);
  });

  it("maps 404 to not reachable and every other failure to unavailable", async () => {
    expect(await createGhRepoCheck({ token: "t", fetchImpl: fakeFetch(404) })("a/b")).toBe("not_reachable");
    for (const status of [401, 403, 429, 500, 502]) {
      expect(await createGhRepoCheck({ token: "t", fetchImpl: fakeFetch(status) })("a/b")).toBe("unavailable");
    }
    const thrown = createGhRepoCheck({
      token: "t",
      fetchImpl: (async () => {
        throw new TypeError("fetch failed");
      }) as typeof fetch,
    });
    expect(await thrown("a/b")).toBe("unavailable");
  });

  it("fails closed with no token and on a timeout", async () => {
    const seen: { url: string; auth: string | null }[] = [];
    expect(await createGhRepoCheck({ token: undefined, fetchImpl: fakeFetch(200, seen) })("a/b")).toBe("unavailable");
    expect(seen).toEqual([]);
    const hung = createGhRepoCheck({
      token: "t",
      timeoutMs: 20,
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        })) as typeof fetch,
    });
    expect(await hung("a/b")).toBe("unavailable");
  });
});

describe("/api/mcp with a revoked token", () => {
  it("answers 401 for an unknown bearer token and still serves the anonymous stub", async () => {
    const store = seedStore();
    const unknown = await mcp("dxt_not_a_live_token", "whoami", {}, store);
    expect(unknown.status).toBe(401);
    const anonymous = await handleMcpHttp(
      new Request("http://127.0.0.1/api/mcp", {
        method: "POST",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }),
      }),
      connectorDeps(store),
    );
    expect(anonymous.status).toBe(200);
  });
});
