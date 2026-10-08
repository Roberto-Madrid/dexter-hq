import { describe, expect, it } from "vitest";
import { terminalAgentStatus } from "../../adapters/cursor-cloud.ts";
import { callConnectorTool } from "../../hq/connector.ts";
import { reconcileConnector } from "../../hq/reconcile.ts";
import { BOT, OWNER, capsAuth as auth, capsDeps, launch } from "./caps-fixtures.ts";

describe("U1 terminal run states", () => {
  it("maps Cursor's terminal run states and leaves live ones alone", () => {
    expect(terminalAgentStatus("FINISHED")).toBe("finished");
    expect(terminalAgentStatus("ERROR")).toBe("error");
    expect(terminalAgentStatus("CANCELLED")).toBe("cancelled");
    expect(terminalAgentStatus("EXPIRED")).toBe("expired");
    expect(terminalAgentStatus("finished")).toBe("finished");
    expect(terminalAgentStatus("RUNNING")).toBeNull();
    expect(terminalAgentStatus("CREATING")).toBeNull();
    expect(terminalAgentStatus("unknown")).toBeNull();
  });
});

describe("U1 reconcile in the tick", () => {
  it("flips a finished agent to terminal, frees its repo slot, and a second tick changes nothing", async () => {
    const { deps, store, cursor } = await capsDeps();
    const first = await launch(deps, "r1", "owner/a");
    await launch(deps, "r2", "owner/a");
    expect((await launch(deps, "r3", "owner/a")).structuredContent.reason).toBe("per_repo_cap");
    const agentId = String(first.structuredContent.agentId);
    cursor.states.set(agentId, "FINISHED");

    const once = await reconcileConnector(deps);
    expect(once).toMatchObject({ configured: true, checked: 2, closed: 1, errors: 0 });
    expect((await store.getAgent(agentId))?.status).toBe("finished");
    expect((await launch(deps, "r4", "owner/a")).structuredContent.status).toBe("launched");

    const twice = await reconcileConnector(deps);
    expect(twice.closed).toBe(0);
    const closedEvents = (await store.listEvents()).filter((event) => event.action === "agent_finished");
    expect(closedEvents).toHaveLength(1);
    expect(closedEvents[0]).toMatchObject({ actor: "hq", target: agentId, ownerId: OWNER });
    expect(closedEvents[0]?.result).toMatchObject({ status: "finished", repo: "owner/a", botId: BOT });
  });

  it("maps error, cancelled and expired runs too", async () => {
    const { deps, store, cursor } = await capsDeps();
    const ids: string[] = [];
    for (const repo of ["owner/a", "owner/b", "owner/c"]) {
      ids.push(String((await launch(deps, `m-${repo}`, repo)).structuredContent.agentId));
    }
    cursor.states.set(ids[0] ?? "", "ERROR");
    cursor.states.set(ids[1] ?? "", "CANCELLED");
    cursor.states.set(ids[2] ?? "", "EXPIRED");
    expect((await reconcileConnector(deps)).closed).toBe(3);
    const statuses = await Promise.all(ids.map(async (id) => (await store.getAgent(id))?.status));
    expect(statuses).toEqual(["error", "cancelled", "expired"]);
  });

  it("still reads and closes agents while STOP is on, and launches nothing", async () => {
    const { deps, store, cursor } = await capsDeps();
    const first = await launch(deps, "stop-1", "owner/a");
    const agentId = String(first.structuredContent.agentId);
    await store.setStopped(true);
    cursor.states.set(agentId, "FINISHED");
    const result = await reconcileConnector(deps);
    expect(result.closed).toBe(1);
    expect((await store.getAgent(agentId))?.status).toBe("finished");
    expect((await launch(deps, "stop-2", "owner/a")).structuredContent.status).toBe("stopped");
    expect(cursor.starts).toHaveLength(1);
  });

  it("does not throw when Cursor cannot be read, and keeps the agent counted", async () => {
    const { deps, store, cursor } = await capsDeps();
    const first = await launch(deps, "e-1", "owner/a");
    const agentId = String(first.structuredContent.agentId);
    cursor.status = async () => {
      throw new Error("cursor_down");
    };
    const result = await reconcileConnector(deps);
    expect(result).toMatchObject({ checked: 1, closed: 0, errors: 1 });
    expect((await store.getAgent(agentId))?.status).toBe("launched");
  });

  it("does nothing without a Cursor key", async () => {
    const { deps } = await capsDeps();
    deps.cursorConfigured = false;
    deps.cursor = null;
    expect(await reconcileConnector(deps)).toMatchObject({ configured: false, checked: 0, closed: 0 });
  });

  it("follows the latest run after a follow-up", async () => {
    const { deps, store, cursor } = await capsDeps();
    const first = await launch(deps, "f-1", "owner/a");
    const agentId = String(first.structuredContent.agentId);
    const follow = await callConnectorTool(deps, auth, "followup_agent", { agentId, text: "one more thing" });
    const nextRun = String(follow.structuredContent.agentId);
    cursor.states.set(agentId, "FINISHED");
    expect((await reconcileConnector(deps)).closed).toBe(0);
    expect((await store.getAgent(agentId))?.status).not.toBe("finished");
    cursor.states.set(nextRun, "FINISHED");
    expect((await reconcileConnector(deps)).closed).toBe(1);
    expect((await store.getAgent(agentId))?.status).toBe("finished");
  });

  it("releases a reservation left behind by a crashed launch after 15 minutes", async () => {
    const now = "2026-10-08T08:30:00.000Z";
    const { deps, store } = await capsDeps({ now: () => now });
    await store.saveAgent({
      id: "33333333-3333-4333-8333-333333333333",
      ownerId: OWNER,
      botId: BOT,
      cursorHandle: null,
      repo: "owner/a",
      role: "builder",
      family: "grok",
      status: "reserving",
      idempotencyKey: "crashed",
      result: { requestId: "req-0-0" },
      createdAt: "2026-10-08T08:00:00.000Z",
    });
    await store.saveAgent({
      id: "44444444-4444-4444-8444-444444444444",
      ownerId: OWNER,
      botId: BOT,
      cursorHandle: null,
      repo: "owner/a",
      role: "builder",
      family: "grok",
      status: "reserving",
      idempotencyKey: "fresh",
      result: { requestId: "req-0-0" },
      createdAt: "2026-10-08T08:25:00.000Z",
    });
    const result = await reconcileConnector(deps);
    expect(result.released).toBe(1);
    expect((await store.getAgent("33333333-3333-4333-8333-333333333333"))?.status).toBe("launch_failed");
    expect((await store.getAgent("44444444-4444-4444-8444-444444444444"))?.status).toBe("reserving");
  });
});
