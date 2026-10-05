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
    await connector.saveAgent({
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
    });
    const store = new MemoryStore();
    const result = await stopAll(store, hqDeps({ connector, runtimes: { "cursor-cloud": runtime } }));
    expect(cancelled).toEqual(["bc-paid:run-9"]);
    expect(result.reports).toEqual([{ id: "bc-paid:run-9", runtime: "cursor-cloud", state: "stopped" }]);
    expect((await connector.listAgents())[0]?.status).toBe("cancelled");
    expect(await store.stopped()).toBe(true);
    expect(await connector.stopped()).toBe(true);
  });
});
