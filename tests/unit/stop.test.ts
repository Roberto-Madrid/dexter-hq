import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import {
  callConnectorTool,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  hashBotToken,
} from "../../hq/connector.ts";
import { createCursorCloud } from "../../adapters/cursor-cloud.ts";
import type { HqDeps, ListedRuntime } from "../../hq/deps.ts";
import type { RunHandle } from "../../kernel/types.ts";
import { MemoryStore } from "../../hq/memory.ts";
import { resumeAll, stopAll } from "../../hq/stop.ts";
import { createScriptedCeo } from "../../hq/scripted-ceo.ts";
import { SHIPPED_CREWS } from "../../hq/crews.ts";
import type { RunRow } from "../../hq/model.ts";

const sheet = parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8"));
const OWNER = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const TOKEN = "unit-stop-token";

function hqDeps(extra?: Partial<HqDeps>): HqDeps {
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
    ...extra,
  };
}

function connectorSeed(suspended = false) {
  return createMemoryConnectorStore({
    bots: [
      {
        id: BOT,
        ownerId: OWNER,
        name: "unit-lead",
        kind: "lead",
        repos: ["owner/demo"],
        tools: ["whoami", "launch_agent", "heartbeat", "approval_status"],
        currentTask: null,
        heartbeatAt: null,
      },
    ],
    tokens: [
      {
        tokenHash: hashBotToken(TOKEN),
        botId: BOT,
        scopes: ["whoami", "launch_agent", "heartbeat", "approval_status"],
        suspended,
      },
    ],
  });
}

function launchedAgent() {
  return {
    id: "agent-1",
    ownerId: OWNER,
    botId: BOT,
    cursorHandle: "bc-paid:run-9",
    repo: "owner/demo",
    role: "builder",
    family: "composer",
    status: "launched",
    idempotencyKey: "paid-1",
    result: { status: "launched" },
  };
}

function cursorCancelStatus(status: number): ListedRuntime {
  return createCursorCloud({
    apiKey: "test-key",
    base: "https://example.com",
    fetchImpl: async (input, init) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "POST" && url.includes("/cancel")) {
        return new Response(null, { status });
      }
      return new Response(JSON.stringify({ agents: [] }), { status: 200 });
    },
  });
}

function runningCursorRun(id: string): RunRow {
  return {
    id,
    taskId: "t1",
    runtime: "cursor-cloud",
    model: null,
    version: null,
    pool: "cursor",
    routingReason: "role-sheet",
    leaseGeneration: 1,
    status: "running",
    usage: {},
    checkpoint: null,
    idempotencyKey: "k1",
    escalation: null,
  };
}

describe("STOP ALL", () => {
  it("sets the stop flag so a mutating connector tool answers stopped", async () => {
    const connector = connectorSeed();
    const store = new MemoryStore();
    await stopAll(store, hqDeps({ connector }));
    expect(await store.stopped()).toBe(true);
    expect(await connector.stopped()).toBe(true);

    const deps = createDefaultConnectorDeps({
      store: connector,
      sheet,
      cursor: null,
      cursorConfigured: false,
      ownerId: OWNER,
    });
    const auth = await connector.authenticate(hashBotToken(TOKEN));
    const launch = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "builder",
      brief: "Change one label.",
      idempotencyKey: "stop-flag-1",
    });
    expect(launch.structuredContent.status).toBe("stopped");
    expect(launch.isError).toBe(true);

    const heartbeat = await callConnectorTool(deps, auth, "heartbeat", { task: "waiting" });
    expect(heartbeat.structuredContent.status).toBe("ok");
  });

  it("does not claim success when cancelling Cursor runs with no key", async () => {
    const store = new MemoryStore();
    await store.saveRun(runningCursorRun("bc-live:run-1"));
    const result = await stopAll(store, hqDeps({ runtimes: {} }));
    expect(result.reports).toEqual([{ id: "bc-live:run-1", runtime: "cursor-cloud", state: "unconfirmed" }]);
    expect(result.reports.some((report) => report.state === "stopped")).toBe(false);
  });

  it("suspends tokens until resume and does not delete them", async () => {
    const connector = connectorSeed();
    const store = new MemoryStore();
    const wired = hqDeps({ connector, runtimes: {} });
    await stopAll(store, wired);

    const hash = hashBotToken(TOKEN);
    const paused = await connector.authenticate(hash);
    expect(paused).not.toBeNull();
    expect(paused?.suspended).toBe(true);

    const deps = createDefaultConnectorDeps({
      store: connector,
      sheet,
      cursor: null,
      cursorConfigured: false,
      ownerId: OWNER,
    });
    await connector.setStopped(false);
    const blocked = await callConnectorTool(deps, paused, "launch_agent", {
      repo: "owner/demo",
      role: "builder",
      brief: "Change one label.",
      idempotencyKey: "suspend-1",
    });
    expect(blocked.structuredContent.status).toBe("stopped");
    expect(blocked.structuredContent.reason).toBe("suspended");

    const resumed = await resumeAll(store, wired);
    expect(resumed.resumed).toBe(true);
    expect(await connector.stopped()).toBe(false);
    const active = await connector.authenticate(hash);
    expect(active?.suspended).toBe(false);

    const after = await callConnectorTool(deps, active, "launch_agent", {
      repo: "owner/demo",
      role: "builder",
      brief: "Change one label.",
      idempotencyKey: "resume-1",
    });
    expect(after.structuredContent.status).toBe("not-configured");
    expect(after.structuredContent.status).not.toBe("stopped");
  });

  it("cancels connector queued requests the tower shows, not only HQ snapshot rows", async () => {
    const connector = connectorSeed();
    const store = new MemoryStore();
    await store.saveRequest({
      id: "hq-queued",
      goal: "HQ snapshot row",
      crew: "research",
      tier: "T1",
      planVersion: 1,
      definitionOfDone: "cancelled",
      status: "queued",
      notices: [],
      card: null,
      createdAt: store.now(),
      updatedAt: store.now(),
    });
    await connector.saveRequest({
      id: "proof-queued",
      ownerId: OWNER,
      goal: "Proof request still queued on the tower",
      status: "queued",
      card: null,
      evidence: [],
      assignedBotId: null,
      repo: "Roberto-Madrid/dexter-hq",
      notices: [],
    });
    await stopAll(store, hqDeps({ connector, runtimes: {} }));
    expect((await store.listRequests())[0]?.status).toBe("cancelled");
    expect((await connector.listRequests())[0]?.status).toBe("cancelled");
  });

  it("treats lowercase Cursor agent statuses as in progress", async () => {
    const cursor = createCursorCloud({
      apiKey: "test-key",
      base: "https://example.com",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            agents: [
              { id: "bc-a", runId: "r1", status: "running" },
              { id: "bc-b", runId: "r2", status: "CREATING" },
              { id: "bc-c", runId: "r3", status: "Creating" },
              { id: "bc-d", runId: "r4", status: "queued" },
              { id: "bc-e", runId: "r5", status: "FINISHED" },
              { id: "bc-f", runId: "r6", status: "finished" },
            ],
          }),
          { status: 200 },
        ),
    });
    expect((await cursor.listInProgress()).map((item) => item.id).sort()).toEqual([
      "bc-a:r1",
      "bc-b:r2",
      "bc-c:r3",
      "bc-d:r4",
    ]);
  });

  it("cancels a launched connector agent when listInProgress is empty", async () => {
    const cancelled: string[] = [];
    const runtime: ListedRuntime = {
      async start() {
        return { id: "unused", runtime: "cursor-cloud" };
      },
      async status() {
        return { state: "running", usage: {} };
      },
      async cancel(handle: RunHandle) {
        cancelled.push(handle.id);
        return { state: "confirmed" };
      },
      async collect() {
        return [];
      },
      async listInProgress() {
        return [];
      },
    };
    const connector = connectorSeed();
    await connector.saveAgent(launchedAgent());
    const store = new MemoryStore();
    const result = await stopAll(store, hqDeps({ connector, runtimes: { "cursor-cloud": runtime } }));
    expect(cancelled).toEqual(["bc-paid:run-9"]);
    expect(result.reports).toEqual([{ id: "bc-paid:run-9", runtime: "cursor-cloud", state: "stopped" }]);
    expect((await connector.listAgents())[0]?.status).toBe("cancelled");
    expect(await store.stopped()).toBe(true);
    expect(await connector.stopped()).toBe(true);
  });

  it("leaves a launched row live when Cursor cancel is not confirmed", async () => {
    const cases: { status: number; report: "unconfirmed" | "stopping" }[] = [
      { status: 401, report: "unconfirmed" },
      { status: 404, report: "unconfirmed" },
      { status: 500, report: "stopping" },
    ];
    for (const item of cases) {
      const connector = connectorSeed();
      await connector.saveAgent(launchedAgent());
      const result = await stopAll(
        new MemoryStore(),
        hqDeps({ connector, runtimes: { "cursor-cloud": cursorCancelStatus(item.status) } }),
      );
      expect(result.reports).toEqual([
        { id: "bc-paid:run-9", runtime: "cursor-cloud", state: item.report, httpStatus: item.status },
      ]);
      expect((await connector.listAgents())[0]?.status).toBe("launched");
    }
  });

  it("lists ACTIVE Cloud agents by latestRunId and skips IDLE and ARCHIVED", async () => {
    const cursor = createCursorCloud({
      apiKey: "test-key",
      base: "https://example.com",
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            items: [
              { id: "bc-active", status: "ACTIVE", latestRunId: "run-live" },
              { id: "bc-idle", status: "IDLE", latestRunId: "run-old" },
              { id: "bc-archived", status: "ARCHIVED", latestRunId: "run-done" },
              { id: "bc-missing", status: "ACTIVE" },
            ],
          }),
          { status: 200 },
        ),
    });
    expect(await cursor.listInProgress()).toEqual([{ id: "bc-active:run-live", runtime: "cursor-cloud" }]);
  });

  it("refreshes latestRunId after a stale cancel and confirms only on 2xx", async () => {
    const calls: string[] = [];
    const cursor = createCursorCloud({
      apiKey: "test-key",
      base: "https://example.com",
      fetchImpl: async (input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        calls.push(`${method} ${url}`);
        if (method === "POST" && url.includes("/runs/run-9/cancel")) {
          return new Response(JSON.stringify({ code: "run_not_cancellable" }), { status: 409 });
        }
        if (method === "POST" && url.includes("/runs/run-live/cancel")) {
          return new Response(JSON.stringify({ id: "run-live" }), { status: 200 });
        }
        if (method === "GET" && url.endsWith("/v1/agents/bc-paid")) {
          return new Response(JSON.stringify({ id: "bc-paid", status: "ACTIVE", latestRunId: "run-live" }), { status: 200 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
    });
    expect(await cursor.cancel({ id: "bc-paid:run-9", runtime: "cursor-cloud" })).toEqual({
      state: "confirmed",
      httpStatus: 200,
    });
    expect(calls.some((line) => line.includes("/runs/run-9/cancel"))).toBe(true);
    expect(calls.some((line) => line.endsWith("/v1/agents/bc-paid"))).toBe(true);
    expect(calls.some((line) => line.includes("/runs/run-live/cancel"))).toBe(true);

    const connector = connectorSeed();
    await connector.saveAgent(launchedAgent());
    const result = await stopAll(new MemoryStore(), hqDeps({ connector, runtimes: { "cursor-cloud": cursor } }));
    expect(result.reports).toEqual([
      { id: "bc-paid:run-9", runtime: "cursor-cloud", state: "stopped", httpStatus: 200 },
    ]);
    expect((await connector.listAgents())[0]?.status).toBe("cancelled");
  });

  it("stores STOP ALL reports and asOf on the stop_all event", async () => {
    const connector = connectorSeed();
    await connector.saveAgent(launchedAgent());
    const result = await stopAll(
      new MemoryStore(),
      hqDeps({ connector, runtimes: { "cursor-cloud": cursorCancelStatus(200) } }),
    );
    const event = (await connector.listEvents()).find((item) => item.action === "stop_all");
    expect(result.reports).toEqual([
      { id: "bc-paid:run-9", runtime: "cursor-cloud", state: "stopped", httpStatus: 200 },
    ]);
    expect(event?.result).toEqual({
      status: "stopped",
      tokens: "suspended",
      reports: result.reports,
      asOf: result.asOf,
    });
    expect((await connector.listAgents())[0]?.status).toBe("cancelled");
  });

  it("does not invent a :followup run id when the follow-up body is unexpected", async () => {
    const cursor = createCursorCloud({
      apiKey: "test-key",
      base: "https://example.com",
      fetchImpl: async () => new Response(JSON.stringify({ status: "ok" }), { status: 200 }),
    });
    await expect(cursor.followup({ id: "bc-paid:run-9", runtime: "cursor-cloud" }, "ping")).rejects.toThrow(
      "followup_parse_failed",
    );
  });

  it("confirms Cursor cancel only on 2xx", async () => {
    const cursor401 = cursorCancelStatus(401);
    const cursor404 = cursorCancelStatus(404);
    const cursor500 = cursorCancelStatus(500);
    const cursor200 = cursorCancelStatus(200);
    const handle = { id: "bc-paid:run-9", runtime: "cursor-cloud" as const };
    expect(await cursor401.cancel(handle)).toEqual({ state: "unconfirmed", httpStatus: 401 });
    expect(await cursor404.cancel(handle)).toEqual({ state: "unsupported", httpStatus: 404 });
    expect(await cursor500.cancel(handle)).toEqual({ state: "requested", httpStatus: 500 });
    expect(await cursor200.cancel(handle)).toEqual({ state: "confirmed", httpStatus: 200 });
  });

  it("cancels without a JSON content-type or body and records HTTP diagnostics", async () => {
    const cancels: { headers?: unknown; body?: unknown }[] = [];
    const cursor = createCursorCloud({
      apiKey: "test-key",
      base: "https://example.com",
      fetchImpl: async (input, init) => {
        const url = String(input);
        if ((init?.method ?? "GET") === "POST" && url.includes("/cancel")) {
          cancels.push({ headers: init?.headers, body: init?.body });
          return new Response(JSON.stringify({ code: "invalid_json", message: "secret-token-value" }), { status: 400 });
        }
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      },
    });
    const handle = { id: "bc-paid:run-9", runtime: "cursor-cloud" as const };
    expect(await cursor.cancel(handle)).toEqual({
      state: "unconfirmed",
      httpStatus: 400,
      errorCode: "invalid_json",
    });
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.body).toBeUndefined();
    const raw = cancels[0]?.headers;
    const names = raw instanceof Headers ? [...raw.keys()] : Object.keys(raw ?? {});
    expect(names.some((name) => name.toLowerCase() === "content-type")).toBe(false);

    const connector = connectorSeed();
    await connector.saveAgent(launchedAgent());
    const result = await stopAll(new MemoryStore(), hqDeps({ connector, runtimes: { "cursor-cloud": cursor } }));
    expect(result.reports).toEqual([
      { id: "bc-paid:run-9", runtime: "cursor-cloud", state: "unconfirmed", httpStatus: 400, errorCode: "invalid_json" },
    ]);
    expect(JSON.stringify(result.reports)).not.toContain("secret-token-value");
    expect((await connector.listAgents())[0]?.status).toBe("launched");
  });
});
