import { describe, expect, it } from "vitest";
import type { RunSpec } from "../../kernel/types.ts";
import {
  AGENT_SURGE_CAP,
  COUNCIL_WEEKLY_SEAT_CAP,
  PER_REPO_CAP,
  PER_REQUEST_LAUNCH_CAP,
  callConnectorTool,
} from "../../hq/connector.ts";
import { SANDBOX_SLOT_CAP } from "../../kernel/police.ts";
import { handleChat } from "../../hq/chat.ts";
import type { HqDeps, ListedRuntime } from "../../hq/deps.ts";
import { MemoryStore } from "../../hq/memory.ts";
import { createScriptedCeo } from "../../hq/scripted-ceo.ts";
import { SHIPPED_CREWS } from "../../hq/crews.ts";
import { OWNER, REPOS, capsAuth as auth, capsDeps, fakeCursor, launch, sheet } from "./caps-fixtures.ts";

describe("U1 one dispatch path", () => {
  it("a chat plan with a wired runtime starts nothing", async () => {
    const starts: RunSpec[] = [];
    const runtime: ListedRuntime = {
      async start(spec) {
        starts.push(spec);
        return { id: `run-${starts.length}`, runtime: "cursor-cloud" };
      },
      async status() {
        return { state: "running", usage: {} };
      },
      async cancel() {
        return { state: "confirmed" };
      },
      async collect() {
        return [];
      },
      async listInProgress() {
        return [];
      },
    };
    const deps: HqDeps = {
      ceo: createScriptedCeo(sheet),
      ceoEnabled: true,
      sheet,
      catalog: [
        {
          id: "grok-4.7",
          family: "grok",
          pool: "cursor",
          version: "4.7",
          variant: "standard",
          pricePerToken: 1,
          trainsOnPrompts: false,
          available: true,
          releasedAt: "2026-06-01T00:00:00.000Z",
        },
      ],
      shippedCrews: SHIPPED_CREWS,
      exhaustedPools: [],
      knownHosts: ["example.com"],
      slotCap: 3,
      runtimes: { "cursor-cloud": runtime, "gh-runner": runtime },
      controlReachable: true,
    };
    const store = new MemoryStore();
    const result = await handleChat(store, deps, "Fix the stale lease check in the repo");
    expect(result.kind).toBe("plan");
    expect(starts).toHaveLength(0);
    expect(await store.listRuns()).toHaveLength(0);
    expect((await store.listTasks()).length).toBeGreaterThan(0);
    expect((await store.listTasks()).every((task) => task.state === "queued")).toBe(true);
  });
});

describe("U1 caps", () => {
  it("uses the owner defaults", () => {
    expect(SANDBOX_SLOT_CAP).toBe(3);
    expect(AGENT_SURGE_CAP).toBe(6);
    expect(PER_REPO_CAP).toBe(2);
    expect(PER_REQUEST_LAUNCH_CAP).toBe(5);
    expect(COUNCIL_WEEKLY_SEAT_CAP).toBe(40);
  });

  it("refuses a 3rd launch on repo A while repo B is allowed", async () => {
    const { deps } = await capsDeps();
    expect((await launch(deps, "a1", "owner/a")).structuredContent.status).toBe("launched");
    expect((await launch(deps, "a2", "owner/a")).structuredContent.status).toBe("launched");
    const third = await launch(deps, "a3", "owner/a");
    expect(third.structuredContent).toMatchObject({ status: "refused", reason: "per_repo_cap", cap: 2 });
    expect((await launch(deps, "b1", "owner/b")).structuredContent.status).toBe("launched");
    const fourth = await launch(deps, "c1", "owner/c");
    expect(fourth.structuredContent).toMatchObject({ status: "refused", reason: "agent_cap", cap: 3 });
  });

  it("lets exactly 2 of 3 simultaneous launches on one repo through", async () => {
    const { deps, store, cursor } = await capsDeps({ cursor: fakeCursor({ delayMs: 5 }) });
    const results = await Promise.all([
      launch(deps, "race-1", "owner/a"),
      launch(deps, "race-2", "owner/a"),
      launch(deps, "race-3", "owner/a"),
    ]);
    const statuses = results.map((item) => item.structuredContent.status);
    expect(statuses.filter((status) => status === "launched")).toHaveLength(2);
    expect(results.filter((item) => item.structuredContent.reason === "per_repo_cap")).toHaveLength(1);
    expect(cursor.starts).toHaveLength(2);
    expect((await store.listAgents()).filter((agent) => agent.status === "launched")).toHaveLength(2);
  });

  it("lets exactly 3 of 4 simultaneous launches on four repos through", async () => {
    const { deps, cursor } = await capsDeps({ cursor: fakeCursor({ delayMs: 5 }) });
    const results = await Promise.all(REPOS.map((repo, index) => launch(deps, `global-${index}`, repo)));
    expect(results.filter((item) => item.structuredContent.status === "launched")).toHaveLength(3);
    expect(results.filter((item) => item.structuredContent.reason === "agent_cap")).toHaveLength(1);
    expect(cursor.starts).toHaveLength(3);
  });

  it("starts once when the same idempotency key arrives twice at the same time", async () => {
    const { deps, cursor } = await capsDeps({ cursor: fakeCursor({ delayMs: 5 }) });
    const both = await Promise.all([launch(deps, "same", "owner/a", "req-0-1"), launch(deps, "same", "owner/a", "req-0-1")]);
    expect(cursor.starts).toHaveLength(1);
    expect(both.map((item) => item.structuredContent.reason ?? item.structuredContent.status).sort()).toEqual([
      "launch_in_progress",
      "launched",
    ]);
    const again = await launch(deps, "same", "owner/a", "req-0-1");
    expect(again.structuredContent.agentId).toBe(both.find((item) => item.structuredContent.status === "launched")?.structuredContent.agentId);
    expect(cursor.starts).toHaveLength(1);
  });

  it("frees the slot when Cursor refuses the start, and the same key can retry", async () => {
    const failing = await capsDeps({ cursor: fakeCursor({ failStart: true }) });
    const first = await launch(failing.deps, "fail-1", "owner/a");
    expect(first.structuredContent).toMatchObject({ status: "error", reason: "launch_failed" });
    const rows = await failing.store.listAgents();
    expect(rows.map((row) => row.status)).toEqual(["launch_failed"]);
    const whoami = await callConnectorTool(failing.deps, auth, "whoami", {});
    expect(whoami.structuredContent.capsLeft).toMatchObject({ agents: 3 });
    failing.deps.cursor = fakeCursor();
    const retry = await launch(failing.deps, "fail-1", "owner/a");
    expect(retry.structuredContent.status).toBe("launched");
    expect(await failing.store.listAgents()).toHaveLength(1);
  });

  it("caps one request at 5 launches", async () => {
    const { deps, cursor } = await capsDeps();
    for (let n = 1; n <= PER_REQUEST_LAUNCH_CAP; n += 1) {
      const result = await launch(deps, `req-cap-${n}`, "owner/a", "req-0-0");
      expect(result.structuredContent.status).toBe("launched");
      for (const id of cursor.states.keys()) cursor.states.set(id, "FINISHED");
      await callConnectorTool(deps, auth, "agent_status", { agentId: result.structuredContent.agentId });
    }
    const sixth = await launch(deps, "req-cap-6", "owner/a", "req-0-0");
    expect(sixth.structuredContent).toMatchObject({ status: "refused", reason: "request_cap", cap: 5 });
    expect((await launch(deps, "other-request", "owner/a", "req-0-2")).structuredContent.status).toBe("launched");
  });

  it("agent_status saves a finished run and frees the repo slot", async () => {
    const { deps, store, cursor } = await capsDeps();
    const first = await launch(deps, "s1", "owner/a");
    await launch(deps, "s2", "owner/a");
    const agentId = String(first.structuredContent.agentId);
    cursor.states.set(agentId, "FINISHED");
    const status = await callConnectorTool(deps, auth, "agent_status", { agentId });
    expect(status.structuredContent.status).toBe("FINISHED");
    expect((await store.getAgent(agentId))?.status).toBe("finished");
    expect((await launch(deps, "s3", "owner/a")).structuredContent.status).toBe("launched");
  });

  it("caps Council seat runs at 40 per 7 days", async () => {
    const now = "2026-10-08T08:00:00.000Z";
    let seats = 0;
    const { deps, store } = await capsDeps({
      now: () => now,
      runCouncilSeat: async () => {
        seats += 1;
        return { result: "pass", actions: [] };
      },
    });
    for (let n = 0; n < COUNCIL_WEEKLY_SEAT_CAP - 1; n += 1) {
      await store.appendEvent({ ownerId: OWNER, actor: "unit-lead", action: "council_seat", target: "old", result: null, at: now });
    }
    await store.appendEvent({
      ownerId: OWNER,
      actor: "unit-lead",
      action: "council_seat",
      target: "older-than-a-week",
      result: null,
      at: "2026-09-30T08:00:00.000Z",
    });
    const fortieth = await callConnectorTool(deps, auth, "request_council", { requestId: "req-0-0", packet: "Diff: x" });
    expect(fortieth.structuredContent.status).toBe("verdict");
    const over = await callConnectorTool(deps, auth, "request_council", { requestId: "req-0-0", packet: "Diff: x" });
    expect(over.structuredContent).toMatchObject({ status: "refused", reason: "council_weekly_cap", cap: 40 });
    expect(seats).toBe(1);
  });
});
