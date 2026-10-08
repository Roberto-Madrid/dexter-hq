import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import { createPgConnectorStore } from "../../hq/connector-pg.ts";
import { CONNECTOR_TOOLS, callConnectorTool, createDefaultConnectorDeps, loadConnectorSheetText } from "../../hq/connector.ts";
import type { ConnectorAuth, ConnectorStore } from "../../hq/connector-store.ts";
import { PINNED_CHECKER_WORKFLOW, type CheckerGateway } from "../../hq/checker.ts";
import { usageCard } from "../../hq/usage-card.ts";
import { databaseUrl, newPool } from "./db.ts";

let pool: pg.Pool;
let store: ConnectorStore;
const owner = randomUUID();
const repo = `it/${randomUUID()}`;
const otherRepo = `it/${randomUUID()}`;
const sha = (n: number) => `${"c".repeat(38)}${n.toString(16).padStart(2, "0")}`;
const ALL = [...CONNECTOR_TOOLS];

function bot(name: string, kind: string, repos: string[]): ConnectorAuth {
  return { id: randomUUID(), ownerId: owner, name, kind, repos, tools: ALL, currentTask: null, heartbeatAt: null, scopes: ALL, suspended: false };
}

const lead = bot(`it-pb-lead-${randomUUID().slice(0, 8)}`, "lead", [repo]);
const reviewer = bot(`it-pb-review-${randomUUID().slice(0, 8)}`, "other", [repo]);
const other = bot(`it-pb-other-${randomUUID().slice(0, 8)}`, "lead", [otherRepo]);
const ceo = bot(`it-pb-ceo-${randomUUID().slice(0, 8)}`, "ceo", []);

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

function deps() {
  return createDefaultConnectorDeps({
    store,
    sheet: parseRoleSheet(loadConnectorSheetText()),
    cursor: null,
    cursorConfigured: false,
    checker: failing,
    checkerConfigured: true,
    ownerId: owner,
    usage: null,
  });
}

const call = async (auth: ConnectorAuth, name: string, args: Record<string, unknown>) =>
  (await callConnectorTool(deps(), auth, name, args)).structuredContent as Record<string, unknown>;

async function newRequest(assignedBotId: string, pullRequest: string | null = null): Promise<string> {
  const id = randomUUID();
  await store.saveRequest({
    id,
    ownerId: owner,
    goal: "Change one label.",
    status: "running",
    card: { crew: "change" },
    evidence: [],
    assignedBotId,
    repo,
    notices: [],
    pullRequest,
    branch: null,
  });
  return id;
}

beforeAll(async () => {
  pool = newPool();
  store = createPgConnectorStore(databaseUrl());
  for (const item of [lead, reviewer, other, ceo]) {
    await pool.query("insert into public.bots (id, owner_id, name, kind, repos) values ($1, $2, $3, $4, $5)", [item.id, owner, item.name, item.kind, item.repos]);
  }
});

afterAll(async () => {
  await pool.query("delete from public.posts where owner_id = $1", [owner]);
  await pool.query("delete from public.bots where owner_id = $1", [owner]);
  await pool.end();
});

describe("token police part B on Postgres", () => {
  it("round-trips a verdict post and enforces own-work and same-author rules", async () => {
    const requestId = await newRequest(lead.id);
    expect(await call(lead, "post", { type: "verdict", verdict: "pass", body: "mine", sha: sha(1), requestId })).toMatchObject({ reason: "own_work" });
    const posted = await call(reviewer, "post", { type: "verdict", verdict: "fail", body: "lint fails on head", sha: sha(1), requestId, approach: "review-head" });
    expect(posted).toMatchObject({ status: "posted", verdict: "fail", noteStatus: "claimed" });
    const row = await pool.query("select type, status, evidence from public.posts where id = $1", [posted.postId]);
    expect(row.rows[0]).toMatchObject({ type: "verdict", status: "claimed" });
    expect(row.rows[0]?.evidence).toMatchObject({ verdict: "fail", sha: sha(1), requestId, subjectBotId: lead.id, approach: "review-head" });
    const back = await store.getPost(String(posted.postId));
    expect(back).toMatchObject({ verdict: "fail", subjectBotId: lead.id, approach: "review-head" });
    expect(await call(reviewer, "verify_post", { postId: posted.postId })).toMatchObject({ reason: "same_author" });
    expect(await call(lead, "verify_post", { postId: posted.postId })).toMatchObject({ reason: "own_work" });
    expect(await call(ceo, "verify_post", { postId: posted.postId })).toMatchObject({ status: "verified", verifiedBy: ceo.name });
  });

  it("writes one BLOCKED board post per block", async () => {
    const requestId = await newRequest(lead.id, "5");
    const check = (n: number) => call(lead, "request_checks", { requestId, repo, sha: sha(n), pullRequest: "5" });
    await check(1);
    await check(2);
    expect(await check(3)).toMatchObject({ reason: "gate_blocked" });
    await check(4);
    const rows = await pool.query(
      "select author, type, evidence from public.posts where owner_id = $1 and type = 'alert' and evidence->>'kind' = 'blocked' and evidence->>'requestId' = $2",
      [owner, requestId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.author).toBe("hq");
    expect(String(rows.rows[0]?.evidence?.body)).toMatch(/^BLOCKED: .+\. Last check run: run-03 on c{12}\. Next step: /);
    const context = await call(lead, "get_context", {});
    expect((context.blocked as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("stores long tool output as a tool_output event and reads it back in pages", async () => {
    const text = `${"line of vitest output\n".repeat(60)}`;
    const posted = await call(lead, "post", { type: "finding", body: "test log", output: text });
    const output = posted.output as Record<string, unknown>;
    expect(output).toMatchObject({ preview: text.slice(0, 200), chars: text.length });
    const events = await pool.query("select actor, result from public.events where action = 'tool_output' and target = $1", [`artifact:${output.artifactId}`]);
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]?.actor).toBe("hq");
    expect(events.rows[0]?.result?.text).toBe(text);
    const found = await store.listRecentEvents("tool_output", { target: `artifact:${output.artifactId}`, limit: 1 });
    expect(found).toHaveLength(1);
    const page = await call(lead, "get_context", { artifactId: output.artifactId });
    expect(page).toMatchObject({ status: "ok", artifact: { chars: text.length, text } });
    expect(await call(other, "get_context", { artifactId: output.artifactId })).toMatchObject({ reason: "unknown_artifact" });
  });

  it("builds the usage card from usage_receipt events", async () => {
    const target = `bc-${randomUUID()}:run-1`;
    await store.appendEvent({
      ownerId: owner,
      actor: "hq",
      action: "usage_receipt",
      target,
      result: { status: "recorded", agentId: target.split(":")[0], runId: "run-1", botId: lead.id, requestId: null, repo, role: "builder", runStatus: "finished", input_tokens: 70, output_tokens: 7, cache_read_tokens: 0, cost_cents: null, charged_cents: null },
      at: new Date().toISOString(),
    });
    const receipts = await store.listRecentEvents("usage_receipt", { limit: 1000 });
    const card = usageCard(receipts, await store.listBots(), new URLSearchParams(`repo=${encodeURIComponent(repo)}`), new Date().toISOString());
    expect(card.status).toBe(200);
    expect(card.body).toMatchObject({ count: 1, recorded: 1, totals: { input_tokens: 70, output_tokens: 7 } });
  });

  it("posts one skill suggestion after three verified successes across two agents", async () => {
    const approach = `pg-approach-${randomUUID().slice(0, 8)}`;
    const ids: string[] = [];
    for (const [auth, body] of [[lead, "one"], [lead, "two"], [reviewer, "three"], [reviewer, "four"]] as const) {
      ids.push(String((await call(auth, "post", { type: "finding", body, approach })).postId));
    }
    for (const id of ids) await call(ceo, "verify_post", { postId: id });
    const rows = await pool.query(
      "select author, evidence from public.posts where owner_id = $1 and type = 'alert' and evidence->>'kind' = 'skill_suggestion' and evidence->>'approach' = $2",
      [owner, approach],
    );
    expect(rows.rows).toHaveLength(1);
    expect(String(rows.rows[0]?.evidence?.body)).toMatch(/^SKILL SUGGESTION: /);
    const events = await pool.query("select 1 from public.events where action = 'skill_suggestion' and target = $1 and owner_id = $2", [approach, owner]);
    expect(events.rows).toHaveLength(1);
  });
});
