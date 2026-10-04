import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import {
  callConnectorTool,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  hashBotToken,
} from "../../hq/connector.ts";
import type { HqDeps } from "../../hq/deps.ts";
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
});
