import { describe, expect, it } from "vitest";
import { callConnectorTool } from "../../hq/connector.ts";
import { buildFleetReport, renderFleetReport } from "../../hq/fleet-report.ts";
import type { ConnectorBot, ConnectorEvent } from "../../hq/connector-store.ts";
import { reconcileConnector } from "../../hq/reconcile.ts";
import { USAGE_TIMEOUT_MS, createCursorUsage, parseCursorUsage, type CursorUsageFn } from "../../hq/usage-receipts.ts";
import { BOT, OWNER, capsAuth as auth, capsDeps, launch } from "./caps-fixtures.ts";

const DOC_BODY = {
  totalUsage: { inputTokens: 1200, outputTokens: 300, cacheWriteTokens: 50, cacheReadTokens: 450, totalTokens: 2000 },
  runs: [
    { id: "run-1", usageUuid: "u-1", usage: { inputTokens: 1000, outputTokens: 250, cacheWriteTokens: 40, cacheReadTokens: 400, totalTokens: 1690 } },
    { id: "run-9", usage: { inputTokens: 200, outputTokens: 50, cacheWriteTokens: 10, cacheReadTokens: 50, totalTokens: 310 } },
  ],
};

function usageFn(body: unknown = DOC_BODY): CursorUsageFn & { calls: { agentId: string; runId: string | null }[] } {
  const calls: { agentId: string; runId: string | null }[] = [];
  const fn = (async (input: { agentId: string; runId: string | null }) => {
    calls.push(input);
    if (body instanceof Error) throw body;
    return body;
  }) as CursorUsageFn & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

describe("Cursor usage parser", () => {
  it("reads the documented shape, picks the run, and counts cache tokens as input", () => {
    expect(parseCursorUsage(DOC_BODY, "run-1")).toEqual({
      scope: "run",
      input_tokens: 1440,
      uncached_input_tokens: 1000,
      cache_read_tokens: 400,
      cache_write_tokens: 40,
      output_tokens: 250,
      total_tokens: 1690,
      cost_cents: null,
      charged_cents: null,
    });
    expect(parseCursorUsage(DOC_BODY, null)).toMatchObject({ scope: "agent", input_tokens: 1700, output_tokens: 300 });
    // A runId-scoped answer without a runs entry falls back to totalUsage.
    expect(parseCursorUsage({ totalUsage: DOC_BODY.totalUsage }, "run-1")).toMatchObject({ scope: "run", input_tokens: 1700 });
  });

  it("keeps cost fields when Cursor returns them, and tolerates snake_case and numeric strings", () => {
    expect(
      parseCursorUsage({ total_usage: { input_tokens: "10", output_tokens: 5 }, cost: { rawCostCents: 12.5, chargedCents: 15 } }, null),
    ).toMatchObject({ input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cost_cents: 12.5, charged_cents: 15 });
  });

  it("returns null for shapes it cannot read", () => {
    for (const body of [null, "x", [], {}, { totalUsage: { inputTokens: -1, outputTokens: "lots" } }, { runs: "no" }]) {
      expect(parseCursorUsage(body, "run-1")).toBeNull();
    }
  });
});

describe("Cursor usage client", () => {
  it("calls GET /v1/agents/{id}/usage with the HQ key, the run id, and a timeout", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const usage = createCursorUsage({
      apiKey: "unit-cursor-key",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify(DOC_BODY), { status: 200 });
      }) as typeof fetch,
    });
    expect(await usage({ agentId: "bc-1", runId: "run-1" })).toEqual(DOC_BODY);
    await usage({ agentId: "bc 2", runId: null });
    expect(calls[0]?.url).toBe("https://api.cursor.com/v1/agents/bc-1/usage?runId=run-1");
    expect(calls[1]?.url).toBe("https://api.cursor.com/v1/agents/bc%202/usage");
    expect((calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer unit-cursor-key");
    expect(calls[0]?.init?.method ?? "GET").toBe("GET");
    expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
    expect(USAGE_TIMEOUT_MS).toBe(10_000);
  });

  it("throws on a non-2xx answer and on a hung call", async () => {
    const forbidden = createCursorUsage({
      apiKey: "k",
      fetchImpl: (async () => new Response('{"error":"feature_unavailable"}', { status: 403 })) as unknown as typeof fetch,
    });
    await expect(forbidden({ agentId: "bc-1", runId: "run-1" })).rejects.toThrow("usage_http_403");
    const hung = createCursorUsage({
      apiKey: "k",
      timeoutMs: 20,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof fetch,
    });
    await expect(hung({ agentId: "bc-1", runId: "run-1" })).rejects.toThrow();
  });
});

describe("usage receipts on terminal runs", () => {
  it("records one receipt per finished run in the tick, tagged with bot and request", async () => {
    const { deps, store, cursor } = await capsDeps();
    const usage = usageFn();
    deps.usage = usage;
    const launched = await launch(deps, "rcpt-1", "owner/a", "req-0-1");
    const agentId = String(launched.structuredContent.agentId);
    cursor.states.set(agentId, "FINISHED");

    expect((await reconcileConnector(deps)).closed).toBe(1);
    expect((await reconcileConnector(deps)).closed).toBe(0);
    const receipts = (await store.listEvents()).filter((event) => event.action === "usage_receipt");
    expect(receipts).toHaveLength(1);
    expect(usage.calls).toEqual([{ agentId: "bc-1", runId: "run-1" }]);
    expect(receipts[0]).toMatchObject({ actor: "hq", target: agentId, ownerId: OWNER });
    expect(receipts[0]?.result).toEqual({
      status: "recorded",
      agentId: "bc-1",
      runId: "run-1",
      botId: BOT,
      requestId: "req-0-1",
      repo: "owner/a",
      role: "builder",
      runStatus: "finished",
      scope: "run",
      input_tokens: 1440,
      uncached_input_tokens: 1000,
      cache_read_tokens: 400,
      cache_write_tokens: 40,
      output_tokens: 250,
      total_tokens: 1690,
      cost_cents: null,
      charged_cents: null,
    });
  });

  it("records the receipt from agent_status too, and the tick does not add a second", async () => {
    const { deps, store, cursor } = await capsDeps();
    deps.usage = usageFn();
    const agentId = String((await launch(deps, "rcpt-2", "owner/a", "req-0-2")).structuredContent.agentId);
    cursor.states.set(agentId, "ERROR");
    const status = await callConnectorTool(deps, auth, "agent_status", { agentId });
    expect(status.structuredContent.status).toBe("ERROR");
    await reconcileConnector(deps);
    const receipts = (await store.listEvents()).filter((event) => event.action === "usage_receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.result).toMatchObject({ status: "recorded", runStatus: "error", requestId: "req-0-2" });
  });

  it("fails soft: a usage error never blocks the close, and leaves an unavailable receipt", async () => {
    const { deps, store, cursor } = await capsDeps();
    deps.usage = usageFn(new Error("usage_http_403"));
    const agentId = String((await launch(deps, "rcpt-3", "owner/a")).structuredContent.agentId);
    cursor.states.set(agentId, "FINISHED");
    expect(await reconcileConnector(deps)).toMatchObject({ closed: 1, errors: 0 });
    expect((await store.getAgent(agentId))?.status).toBe("finished");
    const receipts = (await store.listEvents()).filter((event) => event.action === "usage_receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.result).toMatchObject({ status: "unavailable", reason: "usage_http_403", agentId: "bc-1", runId: "run-1", botId: BOT });
  });

  it("marks an unreadable answer unavailable", async () => {
    const { deps, store, cursor } = await capsDeps();
    deps.usage = usageFn({ nope: true });
    const agentId = String((await launch(deps, "rcpt-4", "owner/a")).structuredContent.agentId);
    cursor.states.set(agentId, "FINISHED");
    await reconcileConnector(deps);
    const receipt = (await store.listEvents()).find((event) => event.action === "usage_receipt");
    expect(receipt?.result).toMatchObject({ status: "unavailable", reason: "usage_unparsed" });
  });

  it("gives a follow-up run its own receipt", async () => {
    const { deps, store, cursor } = await capsDeps();
    const usage = usageFn();
    deps.usage = usage;
    const agentId = String((await launch(deps, "rcpt-5", "owner/a")).structuredContent.agentId);
    cursor.states.set(agentId, "FINISHED");
    await reconcileConnector(deps);
    const followed = await callConnectorTool(deps, auth, "followup_agent", { agentId, brief: "One more label." });
    const next = String(followed.structuredContent.agentId);
    cursor.states.set(next, "FINISHED");
    await reconcileConnector(deps);
    const receipts = (await store.listEvents()).filter((event) => event.action === "usage_receipt");
    expect(receipts.map((event) => event.target)).toEqual([agentId, next]);
    expect(usage.calls.map((call) => call.runId)).toEqual(["run-1", next.split(":")[1]]);
  });

  it("writes nothing when HQ has no Cursor usage client", async () => {
    const { deps, store, cursor } = await capsDeps();
    deps.usage = null;
    const agentId = String((await launch(deps, "rcpt-6", "owner/a")).structuredContent.agentId);
    cursor.states.set(agentId, "FINISHED");
    expect((await reconcileConnector(deps)).closed).toBe(1);
    expect((await store.listEvents()).filter((event) => event.action === "usage_receipt")).toHaveLength(0);
  });
});

describe("usage in the fleet report", () => {
  const W40 = { key: "2026-W40", start: "2026-09-28T07:00:00.000Z", end: "2026-10-05T07:00:00.000Z" };
  const bots: ConnectorBot[] = [
    { id: "b-1", ownerId: OWNER, name: "barber-lead", kind: "lead", repos: ["o/b"], tools: [], currentTask: null, heartbeatAt: null },
  ];
  const receipt = (id: string, result: Record<string, unknown>): ConnectorEvent => ({
    id,
    ownerId: OWNER,
    actor: "hq",
    action: "usage_receipt",
    target: `bc-${id}:run-1`,
    result: { botId: "b-1", ...result },
    at: "2026-10-01T12:00:00.000Z",
  });

  it("sums receipts per bot and in total, and drops usage from Not tracked yet", () => {
    const report = buildFleetReport({
      week: W40,
      events: [
        receipt("1", { status: "recorded", input_tokens: 1000, output_tokens: 100, charged_cents: 12 }),
        receipt("2", { status: "recorded", input_tokens: 500, output_tokens: 50, charged_cents: null }),
        receipt("3", { status: "unavailable", reason: "usage_http_403" }),
        { ...receipt("4", { status: "blocked", reason: "gate_failed", requestId: "r-9" }), action: "blocked", target: "r-9" },
      ],
      bots,
      posts: [],
      generatedAt: "2026-10-08T09:00:00.000Z",
    });
    expect(report.totals.usage).toEqual({ receipts: 2, unavailable: 1, inputTokens: 1500, outputTokens: 150, chargedCents: 12 });
    expect(report.bots[0]?.usage).toEqual({ receipts: 2, unavailable: 1, inputTokens: 1500, outputTokens: 150 });
    expect(report.notTracked).not.toContain("Cursor usage per agent");
    // A token police BLOCKED event counts as a blocked request for the bot it names.
    expect(report.totals.requests.blocked).toBe(1);
    expect(report.bots[0]?.requests.blocked).toBe(1);
    const text = renderFleetReport(report);
    expect(text).toContain("Cursor usage: 1500 input tokens (with cache), 150 output tokens over 2 receipts, 1 unavailable. Charged: 12 cents.");
  });
});
