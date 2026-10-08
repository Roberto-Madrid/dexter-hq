import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import { CONNECTOR_TOOLS, callConnectorTool, createDefaultConnectorDeps, loadConnectorSheetText, type CursorGateway } from "../../hq/connector.ts";
import type { ConnectorAuth, ConnectorStore } from "../../hq/connector-store.ts";
import { PINNED_CHECKER_WORKFLOW, type CheckerGateway } from "../../hq/checker.ts";
import { reconcileConnector } from "../../hq/reconcile.ts";
import { databaseUrl, newPool } from "./db.ts";

let pool: pg.Pool;
let store: ConnectorStore;
const owner = randomUUID();
const bot = randomUUID();
const repo = `it/${randomUUID()}`;
const sha = (n: number) => `${"b".repeat(38)}${n.toString(16).padStart(2, "0")}`;

const auth: ConnectorAuth = {
  id: bot,
  ownerId: owner,
  name: "it-police-lead",
  kind: "lead",
  repos: [repo],
  tools: [...CONNECTOR_TOOLS],
  currentTask: null,
  heartbeatAt: null,
  scopes: [...CONNECTOR_TOOLS],
  suspended: false,
};

const failing: CheckerGateway = {
  async dispatch(input) {
    return { dispatched: true, githubRunId: `run-${input.sha.slice(-2)}`, sha: input.sha, nonce: input.nonce, url: null, workflow: PINNED_CHECKER_WORKFLOW, hostRepo: "it/workers", trustedRef: "main" };
  },
  async find() {
    return null;
  },
  async outcome(input) {
    return { state: "completed", conclusion: "failure", githubRunId: input.githubRunId, evidence: ["checker:lint:fail"] };
  },
};

function deps(extra: { cursor?: CursorGateway; usage?: () => Promise<unknown> } = {}) {
  return createDefaultConnectorDeps({
    store,
    sheet: parseRoleSheet(loadConnectorSheetText()),
    cursor: extra.cursor ?? null,
    cursorConfigured: Boolean(extra.cursor),
    checker: failing,
    checkerConfigured: true,
    ownerId: owner,
    usage: extra.usage ?? null,
  });
}

beforeAll(async () => {
  pool = newPool();
  store = createPgConnectorStore(databaseUrl());
  await pool.query("insert into public.bots (id, owner_id, name, kind, repos) values ($1, $2, 'it-police-lead', 'lead', $3)", [bot, owner, [repo]]);
});

afterAll(async () => {
  await pool.query("delete from public.bots where id = $1", [bot]);
  await pool.end();
});

describe("token police on Postgres", () => {
  it("blocks a request on its third failed Checker run, once, and keeps it blocked", async () => {
    const requestId = randomUUID();
    await store.saveRequest({
      id: requestId,
      ownerId: owner,
      goal: "Change one label.",
      status: "running",
      card: { crew: "change" },
      evidence: [],
      assignedBotId: bot,
      repo,
      notices: [],
      pullRequest: "3",
      branch: null,
    });
    const d = deps();
    const check = (n: number) => callConnectorTool(d, auth, "request_checks", { requestId, repo, sha: sha(n), pullRequest: "3" });
    expect((await check(1)).structuredContent).toMatchObject({ status: "failed", gate: { fails: 1 } });
    expect((await check(2)).structuredContent).toMatchObject({ status: "failed", gate: { fails: 2 } });
    expect((await check(3)).structuredContent).toMatchObject({ status: "refused", reason: "gate_blocked", fails: 3 });
    expect((await check(4)).structuredContent).toMatchObject({ status: "refused", reason: "gate_blocked" });
    const events = await pool.query("select actor, result from public.events where action = 'blocked' and target = $1", [requestId]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.actor).toBe("hq");
    expect(String(events.rows[0]?.result?.line)).toMatch(/^BLOCKED: /);
    expect((events.rows[0]?.result?.log as string[]).length).toBeLessThanOrEqual(5);
    expect((await store.getRequest(requestId))?.status).toBe("blocked");
  });

  it("writes one usage receipt per finished run through the tick", async () => {
    const reserved = await store.reserveLaunch({
      agent: {
        id: randomUUID(),
        ownerId: owner,
        botId: bot,
        cursorHandle: null,
        repo,
        role: "builder",
        family: "grok",
        status: "reserving",
        idempotencyKey: `police-${randomUUID()}`,
        result: { requestId: null },
      },
      requestId: null,
      caps: { global: 1000, perRepo: 1000, perRequest: 1000 },
    });
    expect(reserved.ok).toBe(true);
    if (!reserved.ok) return;
    const handle = `bc-${randomUUID()}:run-1`;
    await store.saveAgent({ ...reserved.agent, cursorHandle: handle, status: "launched", result: { requestId: "req-it" } });
    const cursor: CursorGateway = {
      async start() {
        throw new Error("unused");
      },
      async status(run) {
        return { state: run.id === handle ? "FINISHED" : "RUNNING", usage: {} };
      },
      async cancel() {
        return { state: "confirmed" };
      },
      async collect() {
        return [];
      },
    };
    const usage = async () => ({ totalUsage: { inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 0 } });
    const d = deps({ cursor, usage });
    await reconcileConnector(d);
    await reconcileConnector(d);
    const receipts = await pool.query("select actor, result from public.events where action = 'usage_receipt' and target = $1", [handle]);
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]?.result).toMatchObject({ status: "recorded", botId: bot, requestId: "req-it", input_tokens: 16, output_tokens: 4 });
  });
});
