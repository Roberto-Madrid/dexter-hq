import { describe, expect, it } from "vitest";
import { createCursorCloud } from "../../adapters/cursor-cloud.ts";
import { callConnectorTool } from "../../hq/connector.ts";
import { isActiveAgent } from "../../hq/connector-store.ts";
import { reconcileConnector } from "../../hq/reconcile.ts";
import { BOT, OWNER, capsAuth as auth, capsDeps, fakeCursor, launch } from "./caps-fixtures.ts";

type Deps = Awaited<ReturnType<typeof capsDeps>>;

async function activeCount(store: Deps["store"]): Promise<number> {
  return (await store.listAgents()).filter((agent) => isActiveAgent(agent.status)).length;
}

async function finish(ctx: Deps, agentId: string): Promise<void> {
  ctx.cursor.states.set(agentId, "FINISHED");
  await reconcileConnector(ctx.deps);
  expect((await ctx.store.getAgent(agentId))?.status).toBe("finished");
}

function followup(ctx: Deps, agentId: string) {
  return callConnectorTool(ctx.deps, auth, "followup_agent", { agentId, text: "one more thing" });
}

describe("U1 follow-ups respect the caps", () => {
  it("refuses a follow-up on a finished agent when the global cap is full", async () => {
    const ctx = await capsDeps();
    const ids: string[] = [];
    for (const repo of ["owner/a", "owner/b", "owner/c"]) ids.push(String((await launch(ctx.deps, `g-${repo}`, repo)).structuredContent.agentId));
    await finish(ctx, ids[0] ?? "");
    expect((await launch(ctx.deps, "g-d", "owner/d")).structuredContent.status).toBe("launched");
    expect(await activeCount(ctx.store)).toBe(3);
    const result = await followup(ctx, ids[0] ?? "");
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "refused", reason: "agent_cap", cap: 3 });
    expect(ctx.cursor.followups).toHaveLength(0);
    expect(await activeCount(ctx.store)).toBe(3);
    expect((await ctx.store.getAgent(ids[0] ?? ""))?.status).toBe("finished");
  });

  it("refuses a follow-up on a finished agent when its repo is full", async () => {
    const ctx = await capsDeps();
    const first = String((await launch(ctx.deps, "r1", "owner/a")).structuredContent.agentId);
    await launch(ctx.deps, "r2", "owner/a");
    await finish(ctx, first);
    expect((await launch(ctx.deps, "r3", "owner/a")).structuredContent.status).toBe("launched");
    const result = await followup(ctx, first);
    expect(result.structuredContent).toMatchObject({ status: "refused", reason: "per_repo_cap", cap: 2 });
    expect(ctx.cursor.followups).toHaveLength(0);
    expect((await ctx.store.getAgent(first))?.status).toBe("finished");
  });

  it("reopens a finished agent when there is room, and it counts against the caps again", async () => {
    const ctx = await capsDeps();
    const first = String((await launch(ctx.deps, "o1", "owner/a")).structuredContent.agentId);
    await finish(ctx, first);
    const result = await followup(ctx, first);
    expect(result.structuredContent.status).toBe("followed_up");
    const row = await ctx.store.getAgent(first);
    expect(row?.status).toBe("running");
    expect(row?.result?.latestRunHandle).toBe(result.structuredContent.agentId);
    expect(row?.result?.followupFrom).toBeUndefined();
    expect(await activeCount(ctx.store)).toBe(1);
  });

  it("refuses a follow-up on a cancelled agent and leaves it cancelled", async () => {
    const ctx = await capsDeps();
    const first = String((await launch(ctx.deps, "c1", "owner/a")).structuredContent.agentId);
    await callConnectorTool(ctx.deps, auth, "cancel_agent", { agentId: first });
    const result = await followup(ctx, first);
    expect(result.structuredContent).toMatchObject({ status: "refused", reason: "agent_not_active" });
    expect(ctx.cursor.followups).toHaveLength(0);
    expect((await ctx.store.getAgent(first))?.status).toBe("cancelled");
  });

  it("refuses every follow-up while STOP is on", async () => {
    const ctx = await capsDeps();
    const first = String((await launch(ctx.deps, "s1", "owner/a")).structuredContent.agentId);
    await ctx.store.setStopped(true);
    const result = await followup(ctx, first);
    expect(result.structuredContent.status).toBe("stopped");
    expect(ctx.cursor.followups).toHaveLength(0);
  });

  it("puts a finished agent back when Cursor refuses the follow-up", async () => {
    const ctx = await capsDeps({ cursor: fakeCursor({ failFollowup: true }) });
    const first = String((await launch(ctx.deps, "f1", "owner/a")).structuredContent.agentId);
    await finish(ctx, first);
    const result = await followup(ctx, first);
    expect(result.structuredContent).toMatchObject({ status: "error", reason: "followup_agent_failed" });
    const row = await ctx.store.getAgent(first);
    expect(row?.status).toBe("finished");
    expect(row?.result?.followupFrom).toBeUndefined();
    expect(await activeCount(ctx.store)).toBe(0);
  });

  it("lets only one of a follow-up and a launch take the last slot", async () => {
    const ctx = await capsDeps({ cursor: fakeCursor({ delayMs: 5 }) });
    const first = String((await launch(ctx.deps, "l1", "owner/a")).structuredContent.agentId);
    await launch(ctx.deps, "l2", "owner/b");
    await launch(ctx.deps, "l3", "owner/c");
    await finish(ctx, first);
    const [follow, next] = await Promise.all([followup(ctx, first), launch(ctx.deps, "l4", "owner/d")]);
    const won = [follow.structuredContent.status === "followed_up", next.structuredContent.status === "launched"];
    expect(won.filter(Boolean)).toHaveLength(1);
    expect(await activeCount(ctx.store)).toBe(3);
  });

  it("runs one follow-up when two arrive for the same agent at once", async () => {
    const ctx = await capsDeps({ cursor: fakeCursor({ delayMs: 5 }) });
    const first = String((await launch(ctx.deps, "d1", "owner/a")).structuredContent.agentId);
    const both = await Promise.all([followup(ctx, first), followup(ctx, first)]);
    expect(ctx.cursor.followups).toHaveLength(1);
    expect(both.map((item) => item.structuredContent.reason ?? item.structuredContent.status).sort()).toEqual([
      "followed_up",
      "followup_in_progress",
    ]);
  });
});

describe("U1 tick and agent_status do not close a run that a follow-up replaced", () => {
  it("the tick keeps the agent open when a follow-up lands while it reads the old run", async () => {
    const ctx = await capsDeps();
    const first = String((await launch(ctx.deps, "t1", "owner/a")).structuredContent.agentId);
    const read = ctx.cursor.status.bind(ctx.cursor);
    let raced = false;
    ctx.cursor.status = async (handle) => {
      if (handle.id === first && !raced) {
        raced = true;
        ctx.cursor.states.set(first, "FINISHED");
        await followup(ctx, first);
      }
      return read(handle);
    };
    const result = await reconcileConnector(ctx.deps);
    expect(result.closed).toBe(0);
    expect((await ctx.store.getAgent(first))?.status).toBe("running");
  });

  it("agent_status keeps the agent open when a follow-up lands while it reads the old run", async () => {
    const ctx = await capsDeps();
    const first = String((await launch(ctx.deps, "t2", "owner/a")).structuredContent.agentId);
    const read = ctx.cursor.status.bind(ctx.cursor);
    let raced = false;
    ctx.cursor.status = async (handle) => {
      if (handle.id === first && !raced) {
        raced = true;
        ctx.cursor.states.set(first, "FINISHED");
        await followup(ctx, first);
      }
      return read(handle);
    };
    await callConnectorTool(ctx.deps, auth, "agent_status", { agentId: first });
    expect((await ctx.store.getAgent(first))?.status).toBe("running");
  });

  it("releases a follow-up reservation left by a crash back to the agent's old status", async () => {
    const now = "2026-10-08T08:30:00.000Z";
    const ctx = await capsDeps({ now: () => now });
    await ctx.store.saveAgent({
      id: "55555555-5555-4555-8555-555555555555",
      ownerId: OWNER,
      botId: BOT,
      cursorHandle: "bc-9:run-9",
      repo: "owner/a",
      role: "builder",
      family: "grok",
      status: "reserving",
      idempotencyKey: "crashed-followup",
      result: { requestId: "req-0-0", followupFrom: "finished", reservedAt: "2026-10-08T08:00:00.000Z" },
      createdAt: "2026-10-07T08:00:00.000Z",
    });
    const result = await reconcileConnector(ctx.deps);
    expect(result.released).toBe(1);
    const row = await ctx.store.getAgent("55555555-5555-4555-8555-555555555555");
    expect(row?.status).toBe("finished");
    expect(row?.result?.followupFrom).toBeUndefined();
  });

  it("does not release a follow-up reservation that is still fresh", async () => {
    const now = "2026-10-08T08:30:00.000Z";
    const ctx = await capsDeps({ now: () => now });
    await ctx.store.saveAgent({
      id: "66666666-6666-4666-8666-666666666666",
      ownerId: OWNER,
      botId: BOT,
      cursorHandle: "bc-8:run-8",
      repo: "owner/a",
      role: "builder",
      family: "grok",
      status: "reserving",
      idempotencyKey: "fresh-followup",
      result: { followupFrom: "finished", reservedAt: "2026-10-08T08:29:00.000Z" },
      createdAt: "2026-10-07T08:00:00.000Z",
    });
    expect((await reconcileConnector(ctx.deps)).released).toBe(0);
    expect((await ctx.store.getAgent("66666666-6666-4666-8666-666666666666"))?.status).toBe("reserving");
  });
});

describe("U1 Cursor start checks the HTTP status", () => {
  for (const status of [400, 403, 429, 500, 503]) {
    it(`throws on ${status}, so the launch reservation is released`, async () => {
      const cursor = createCursorCloud({
        apiKey: "unit-key",
        base: "https://example.test",
        fetchImpl: (async () => new Response(JSON.stringify({ error: "nope" }), { status })) as typeof fetch,
      });
      await expect(cursor.start({ idempotencyKey: "k", taskId: "k", brief: "b" })).rejects.toThrow(`start_failed_${status}`);
    });
  }

  it("a launch through a failing Cursor start leaves the row launch_failed, not launched", async () => {
    const real = createCursorCloud({
      apiKey: "unit-key",
      base: "https://example.test",
      fetchImpl: (async () => new Response("{}", { status: 500 })) as typeof fetch,
    });
    const ctx = await capsDeps();
    ctx.deps.cursor = real;
    const result = await launch(ctx.deps, "http-500", "owner/a");
    expect(result.structuredContent).toMatchObject({ status: "error", reason: "launch_failed" });
    expect((await ctx.store.listAgents()).map((row) => row.status)).toEqual(["launch_failed"]);
  });
});
