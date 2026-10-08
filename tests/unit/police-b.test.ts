import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { handleChat } from "../../hq/chat.ts";
import { classifyQuestion } from "../../hq/classify.ts";
import { PINNED_CHECKER_WORKFLOW, type CheckerGateway } from "../../hq/checker.ts";
import {
  CONNECTOR_TOOLS,
  callConnectorTool,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  loadConnectorSheetText,
} from "../../hq/connector.ts";
import type { ConnectorAuth, ConnectorPost, ConnectorStore } from "../../hq/connector-store.ts";
import { SHIPPED_CREWS } from "../../hq/crews.ts";
import type { HqDeps } from "../../hq/deps.ts";
import { MemoryStore } from "../../hq/memory.ts";
import { REUSE_MIN_AGENTS, REUSE_MIN_SUCCESSES, SKILL_SUGGESTION_KIND } from "../../hq/reuse-scan.ts";
import { createScriptedCeo } from "../../hq/scripted-ceo.ts";
import { getArtifactView, getBoardNotes, getUsageView, login } from "../../hq/server.ts";
import { BLOCKED_NEXT_STEP, recordGateBlocked } from "../../hq/token-police.ts";
import { TOOL_OUTPUT_ACTION, TOOL_OUTPUT_INLINE_CHARS, TOOL_OUTPUT_MAX_CHARS } from "../../hq/tool-artifacts.ts";
import { POST_TYPES, VERIFIABLE_POST_TYPES } from "../../kernel/board.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OWNER_EMAIL = "owner@example.com";
const NOW = "2026-10-08T09:00:00.000Z";
const SHA = "abcdef1234567abcdef1234567abcdef12345678";
const ALPHA = "acme/alpha";
const BETA = "acme/beta";
const ALL = [...CONNECTOR_TOOLS];
const sha = (n: number) => `${"a".repeat(38)}${n.toString(16).padStart(2, "0")}`;

type Body = Record<string, unknown>;

function bot(id: string, name: string, kind: string, repos: string[]): ConnectorAuth {
  return { id, ownerId: OWNER, name, kind, repos, tools: ALL, currentTask: null, heartbeatAt: null, scopes: ALL, suspended: false };
}

const leadA = bot("aaaaaaaa-0000-4000-8000-000000000001", "alpha-lead", "lead", [ALPHA]);
const devA = bot("aaaaaaaa-0000-4000-8000-000000000002", "alpha-dev", "other", [ALPHA]);
const leadB = bot("bbbbbbbb-0000-4000-8000-000000000001", "beta-lead", "lead", [BETA]);
const ceo = bot("cccccccc-0000-4000-8000-000000000001", "dexter", "ceo", []);

beforeAll(() => {
  // Never touch a real database from unit tests.
  process.env.SUPABASE_DB_URL = "";
  process.env.DEXTER_STORE = "memory";
  process.env.DEXTER_CEO = "off";
  process.env.DEXTER_CALLBACK_SECRET = "unit-test-session-secret-0123456789";
  process.env.DEXTER_OWNER_EMAIL = OWNER_EMAIL;
});

function ownerCookie(): string {
  const session = login(OWNER_EMAIL, false);
  if (!session.ok) throw new Error("login failed");
  return session.cookie.split(";")[0] ?? "";
}

/** Each dispatched sha gets the next conclusion. */
function fakeChecker(conclusions: ("success" | "failure")[]): CheckerGateway & { dispatches: string[] } {
  const queue = [...conclusions];
  const bySha = new Map<string, "success" | "failure">();
  const dispatches: string[] = [];
  return {
    dispatches,
    async dispatch(input) {
      dispatches.push(input.sha);
      bySha.set(input.sha, queue.shift() ?? "success");
      return {
        dispatched: true,
        githubRunId: `run-${dispatches.length}`,
        sha: input.sha,
        nonce: input.nonce,
        url: null,
        workflow: PINNED_CHECKER_WORKFLOW,
        hostRepo: "acme/workers",
        trustedRef: "main",
      };
    },
    async find() {
      return null;
    },
    async outcome(input) {
      const conclusion = bySha.get(input.sha) ?? "success";
      return {
        state: "completed",
        conclusion,
        githubRunId: input.githubRunId,
        evidence:
          conclusion === "success"
            ? ["checker:build:pass", "checker:lint:pass", "checker:playwright:pass"]
            : ["checker:build:pass", "checker:lint:fail", "checker:playwright:fail", `checker:url:https://example.test/${input.githubRunId}`],
      };
    },
  };
}

function setup(checker: CheckerGateway | null = null) {
  const store = createMemoryConnectorStore({ bots: [leadA, devA, leadB, ceo] });
  let clock = NOW;
  const deps = createDefaultConnectorDeps({
    store,
    sheet: parseRoleSheet(loadConnectorSheetText()),
    cursor: null,
    cursorConfigured: false,
    checker,
    checkerConfigured: Boolean(checker),
    ownerId: OWNER,
    now: () => clock,
  });
  return {
    store,
    deps,
    at(next: string) {
      clock = next;
    },
    async call(auth: ConnectorAuth, name: string, args: Record<string, unknown>) {
      const result = await callConnectorTool(deps, auth, name, args);
      return { body: result.structuredContent as Body, isError: result.isError, text: result.content[0]?.text ?? "" };
    },
  };
}

async function request(
  store: ConnectorStore,
  id: string,
  repo: string,
  assignedBotId: string,
  run: { sha: string; passed: boolean } | null = null,
  pullRequest: string | null = null,
) {
  await store.saveRequest({
    id,
    ownerId: OWNER,
    goal: "Change one label.",
    status: "running",
    card: { crew: "change", newScreen: false, requiresDesignApproval: false },
    evidence: [],
    assignedBotId,
    repo,
    notices: [],
    checkRun: run
      ? { nonce: `nonce-${id}`, githubRunId: `gh-${id}`, sha: run.sha, repo, hostRepo: "acme/workers", dispatchedAt: NOW, passed: run.passed }
      : null,
    pullRequest,
    branch: null,
  });
}

const alerts = async (store: ConnectorStore, kind: string): Promise<ConnectorPost[]> =>
  (await store.listPosts()).filter((post) => post.type === "alert" && post.kind === kind);

describe("verdict board post type", () => {
  it("is a kernel post type that starts claimed and can be verified", () => {
    expect(POST_TYPES).toContain("verdict");
    expect(VERIFIABLE_POST_TYPES).toContain("verdict");
  });

  it("needs pass or fail, the sha it judges, and a run or request", async () => {
    const { call, store } = setup();
    await request(store, "req-a", ALPHA, leadA.id);
    expect((await call(devA, "post", { type: "verdict", body: "looks fine", sha: SHA, requestId: "req-a" })).body).toMatchObject({
      status: "refused",
      reason: "invalid_verdict",
    });
    expect((await call(devA, "post", { type: "verdict", verdict: "maybe", body: "x", sha: SHA, requestId: "req-a" })).body).toMatchObject({
      reason: "invalid_verdict",
      allowed: ["pass", "fail"],
    });
    expect((await call(devA, "post", { type: "verdict", verdict: "pass", body: "x", requestId: "req-a" })).body).toMatchObject({
      reason: "verdict_needs_sha",
    });
    expect((await call(devA, "post", { type: "verdict", verdict: "pass", body: "x", sha: SHA })).body).toMatchObject({
      reason: "verdict_needs_run",
    });
    const ok = await call(devA, "post", { type: "verdict", verdict: "pass", body: "build and lint pass on the PR head", sha: SHA, requestId: "req-a" });
    expect(ok.isError).toBe(false);
    expect(ok.body).toMatchObject({ status: "posted", type: "verdict", verdict: "pass", noteStatus: "claimed", sha: SHA, requestId: "req-a" });
    const byRun = await call(devA, "post", { type: "verdict", verdict: "fail", body: "agent run broke the build", sha: SHA.slice(0, 12), runId: "bc-9:run-2" });
    expect(byRun.body).toMatchObject({ status: "posted", verdict: "fail", runId: "bc-9:run-2" });
  });

  it("refuses a verdict on the poster's own work", async () => {
    const { call, store } = setup();
    await request(store, "req-a", ALPHA, leadA.id);
    expect((await call(leadA, "post", { type: "verdict", verdict: "pass", body: "mine is fine", sha: SHA, requestId: "req-a" })).body).toMatchObject({
      status: "refused",
      reason: "own_work",
    });
    await store.saveAgent({
      id: "agent-row-1",
      ownerId: OWNER,
      botId: leadA.id,
      cursorHandle: "bc-1",
      repo: ALPHA,
      role: "builder",
      family: "grok",
      status: "finished",
      idempotencyKey: "k1",
      result: null,
    });
    expect((await call(leadA, "post", { type: "verdict", verdict: "pass", body: "my agent is fine", sha: SHA, runId: "bc-1:run-1", agentId: "bc-1" })).body).toMatchObject({
      reason: "own_work",
    });
  });

  it("follows the verify rules: never the author or the judged bot, yes a different bot or a matching Checker run", async () => {
    const { call, store } = setup();
    await request(store, "req-a", ALPHA, leadA.id, { sha: SHA, passed: true });
    const pass = String((await call(devA, "post", { type: "verdict", verdict: "pass", body: "pass on head", sha: SHA, requestId: "req-a" })).body.postId);
    expect((await call(devA, "verify_post", { postId: pass })).body).toMatchObject({ status: "refused", reason: "same_author" });
    expect((await call(leadA, "verify_post", { postId: pass })).body).toMatchObject({ status: "refused", reason: "own_work" });
    expect((await call(ceo, "verify_post", { postId: pass })).body).toMatchObject({ status: "verified", verifiedBy: "dexter" });

    // Deterministic: the author may cite the Checker when the run on the same sha agrees with the verdict.
    const viaChecker = String((await call(devA, "post", { type: "verdict", verdict: "pass", body: "pass again", sha: SHA, requestId: "req-a" })).body.postId);
    expect((await call(devA, "verify_post", { postId: viaChecker, checkRequestId: "req-a" })).body).toMatchObject({
      status: "verified",
      verifiedBy: "checker",
    });

    await request(store, "req-b", ALPHA, leadA.id, { sha: sha(2), passed: false });
    const wrong = String((await call(devA, "post", { type: "verdict", verdict: "pass", body: "claims pass", sha: sha(2), requestId: "req-b" })).body.postId);
    expect((await call(devA, "verify_post", { postId: wrong, checkRequestId: "req-b" })).body).toMatchObject({ reason: "check_not_passed" });
    const fail = String((await call(devA, "post", { type: "verdict", verdict: "fail", body: "claims fail", sha: sha(2), requestId: "req-b" })).body.postId);
    // No completed failed Checker run on that sha yet: the Checker cannot confirm a fail.
    expect((await call(devA, "verify_post", { postId: fail, checkRequestId: "req-b" })).body).toMatchObject({ reason: "check_not_failed" });
    await store.appendEvent({
      ownerId: OWNER,
      actor: "alpha-lead",
      action: "request_checks",
      target: "req-b",
      result: { status: "failed", sha: sha(2), nonce: "nonce-req-b", requestId: "req-b" },
      at: NOW,
    });
    expect((await call(devA, "verify_post", { postId: fail, checkRequestId: "req-b" })).body).toMatchObject({ status: "verified", verifiedBy: "checker" });
  });

  it("comes back under verdicts in get_context and in the owner view, not as findings", async () => {
    const { call, store } = setup();
    await request(store, "req-a", ALPHA, leadA.id);
    const id = String((await call(devA, "post", { type: "verdict", verdict: "fail", body: "lint fails", sha: SHA, requestId: "req-a" })).body.postId);
    const context = (await call(leadA, "get_context", {})).body;
    expect(context.findings).toEqual([]);
    expect(context.claimed).toEqual([]);
    expect(context.verdicts).toEqual([expect.objectContaining({ id, type: "verdict", verdict: "fail", status: "claimed", sha: SHA.slice(0, 12) })]);
    expect(context.unverified).toContain(id);
    expect(((await call(leadA, "get_context", { type: "verdict" })).body.verdicts as unknown[]).length).toBe(1);
    expect((await call(leadB, "get_context", {})).body.verdicts).toEqual([]);
    const view = await getBoardNotes(ownerCookie(), "view=notes&type=verdict", store, NOW);
    expect(view.status).toBe(200);
    expect((view.body as { notes: Body[] }).notes).toEqual([expect.objectContaining({ id, type: "verdict", verdict: "fail" })]);
  });
});

describe("BLOCKED board post", () => {
  async function blockedSetup() {
    const checker = fakeChecker(["failure", "failure", "failure"]);
    const env = setup(checker);
    await request(env.store, "req-1", ALPHA, leadA.id, null, "7");
    const check = (n: number) => env.call(leadA, "request_checks", { requestId: "req-1", repo: ALPHA, sha: sha(n), pullRequest: "7" });
    return { ...env, checker, check };
  }

  it("writes one board post with the fixed BLOCKED template when the gate blocks", async () => {
    const { store, check } = await blockedSetup();
    await check(1);
    await check(2);
    expect(await alerts(store, "blocked")).toHaveLength(0);
    expect((await check(3)).body).toMatchObject({ status: "refused", reason: "gate_blocked" });
    const posts = await alerts(store, "blocked");
    expect(posts).toHaveLength(1);
    const post = posts[0] as ConnectorPost;
    expect(post).toMatchObject({ author: "hq", scope: "mission", requestId: "req-1", repo: ALPHA, sha: sha(3), runId: "run-3" });
    expect(post.body).toMatch(/^BLOCKED: .+\. Last check run: .+\. Next step: .+$/);
    expect(post.body).toContain("lint");
    expect(post.body).toContain("playwright");
    expect(post.body).toContain("run-3");
    expect(post.body).toContain(sha(3).slice(0, 12));
    expect(post.body).toContain(BLOCKED_NEXT_STEP);
    expect(post.link).toBe("https://example.test/run-3");
  });

  it("is idempotent: further refusals and a repeated record write no second post, and a missing post is restored", async () => {
    const { store, deps, check } = await blockedSetup();
    await check(1);
    await check(2);
    await check(3);
    await check(4);
    const request1 = await store.getRequest("req-1");
    if (!request1) throw new Error("missing request");
    await recordGateBlocked(deps, leadA, request1, { sha: sha(3), evidence: ["checker:lint:fail"], githubRunId: "run-3", nonce: "n" });
    expect(await alerts(store, "blocked")).toHaveLength(1);
    expect((await store.listEvents()).filter((event) => event.action === "blocked")).toHaveLength(1);
  });

  it("restores the post when the blocked event exists but the post write was lost", async () => {
    const { store, deps } = setup();
    await request(store, "req-9", ALPHA, leadA.id);
    await store.appendEvent({ ownerId: OWNER, actor: "hq", action: "blocked", target: "req-9", result: { status: "blocked" }, at: NOW });
    const row = await store.getRequest("req-9");
    if (!row) throw new Error("missing request");
    await recordGateBlocked(deps, leadA, row, { sha: sha(5), evidence: ["checker:build:fail"], githubRunId: "run-5", nonce: "n5" });
    await recordGateBlocked(deps, leadA, row, { sha: sha(5), evidence: ["checker:build:fail"], githubRunId: "run-5", nonce: "n5" });
    expect(await alerts(store, "blocked")).toHaveLength(1);
    expect((await store.listEvents()).filter((event) => event.action === "blocked")).toHaveLength(1);
  });

  it("reaches the assigned lead and the CEO through get_context, never another venture", async () => {
    const { call, check } = await blockedSetup();
    await check(1);
    await check(2);
    await check(3);
    const lead = (await call(leadA, "get_context", {})).body.blocked as Body[];
    expect(lead).toHaveLength(1);
    expect(String(lead[0]?.body)).toMatch(/^BLOCKED: /);
    expect(((await call(ceo, "get_context", {})).body.blocked as Body[]).length).toBe(1);
    expect((await call(leadB, "get_context", {})).body.blocked).toEqual([]);
  });
});

describe("tool output over 200 chars goes to an artifact", () => {
  const long = (n: number) => Array.from({ length: n }, (_, i) => String.fromCharCode(97 + (i % 26))).join("");

  it("keeps short output inline and writes no artifact", async () => {
    const { call, store } = setup();
    const out = await call(leadA, "post", { type: "finding", body: "tests pass", output: "12 passed" });
    expect(out.body.output).toEqual({ text: "12 passed", chars: 9 });
    expect((await store.listEvents()).filter((event) => event.action === TOOL_OUTPUT_ACTION)).toHaveLength(0);
  });

  it("stores long output in full and replies with a pointer plus the first 200 chars", async () => {
    expect(TOOL_OUTPUT_INLINE_CHARS).toBe(200);
    const { call, store } = setup();
    const text = long(1000);
    const out = await call(leadA, "post", { type: "finding", body: "vitest output attached", output: text });
    const output = out.body.output as Body;
    expect(output).toMatchObject({ preview: text.slice(0, 200), chars: 1000, truncated: false });
    expect(String(output.artifactId)).toMatch(/^[0-9a-f-]{36}$/);
    expect(out.text.length).toBeLessThan(800);
    const events = (await store.listEvents()).filter((event) => event.action === TOOL_OUTPUT_ACTION);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "hq", target: `artifact:${output.artifactId}` });
    expect(events[0]?.result?.text).toBe(text);
    const post = await store.getPost(String(out.body.postId));
    expect(post?.output).toBe(text.slice(0, 200));
    expect(post?.artifactId).toBe(output.artifactId);

    const context = (await call(leadA, "get_context", {})).body.claimed as Body[];
    expect(context[0]).toMatchObject({ output: text.slice(0, 200), artifactId: output.artifactId, outputChars: "1000" });

    const page = await call(leadA, "get_context", { artifactId: output.artifactId });
    expect(page.body).toMatchObject({ status: "ok", artifact: { id: output.artifactId, chars: 1000, offset: 0, text, nextOffset: null } });
  });

  it("scrubs secrets, pages long artifacts, caps the stored size, and keeps the post's read scope", async () => {
    const { call, store } = setup();
    const secret = `token=${"z".repeat(30)} ${long(9000)}`;
    const out = await call(leadA, "post", { type: "finding", body: "log", output: secret });
    const id = String((out.body.output as Body).artifactId);
    const stored = (await store.listEvents()).find((event) => event.action === TOOL_OUTPUT_ACTION);
    expect(String(stored?.result?.text)).not.toContain("z".repeat(30));
    const first = (await call(leadA, "get_context", { artifactId: id })).body.artifact as Body;
    expect(String(first.text).length).toBeLessThan(9000);
    expect(JSON.stringify(first).length).toBeLessThanOrEqual(6000);
    const second = (await call(leadA, "get_context", { artifactId: id, offset: first.nextOffset })).body.artifact as Body;
    expect(second.offset).toBe(first.nextOffset);
    expect((await call(leadB, "get_context", { artifactId: id })).body).toMatchObject({ status: "refused", reason: "unknown_artifact" });
    expect((await call(ceo, "get_context", { artifactId: id })).body.status).toBe("ok");

    const huge = await call(leadA, "post", { type: "finding", body: "huge", output: long(TOOL_OUTPUT_MAX_CHARS + 500) });
    expect(huge.body.output).toMatchObject({ chars: TOOL_OUTPUT_MAX_CHARS + 500, truncated: true });
    expect(TOOL_OUTPUT_MAX_CHARS).toBe(20000);
  });

  it("an idempotent replay writes no second artifact", async () => {
    const { call, store } = setup();
    const args = { type: "finding", body: "same", output: long(500), idempotencyKey: "k-1" };
    const one = await call(leadA, "post", args);
    const two = await call(leadA, "post", args);
    expect(two.body).toMatchObject({ idempotent: true, postId: one.body.postId });
    expect((two.body.output as Body).artifactId).toBe((one.body.output as Body).artifactId);
    expect((await store.listEvents()).filter((event) => event.action === TOOL_OUTPUT_ACTION)).toHaveLength(1);
  });

  it("lets the owner read the full artifact over GET /api/board?view=artifact", async () => {
    const { call, store } = setup();
    const text = long(700);
    const id = String(((await call(leadA, "post", { type: "finding", body: "x", output: text })).body.output as Body).artifactId);
    expect((await getArtifactView(null, id, store)).status).toBe(401);
    const view = await getArtifactView(ownerCookie(), id, store);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ id, chars: 700, text, by: "alpha-lead" });
    expect((await getArtifactView(ownerCookie(), "00000000-0000-4000-8000-000000000000", store)).status).toBe(404);
  });
});

describe("usage receipt card (owner read path, no screen)", () => {
  async function receipts(store: ConnectorStore) {
    const add = (at: string, result: Record<string, unknown>) =>
      store.appendEvent({ ownerId: OWNER, actor: "hq", action: "usage_receipt", target: `${result.agentId}:${result.runId}`, result, at });
    await add("2026-10-07T10:00:00.000Z", {
      status: "recorded", agentId: "bc-1", runId: "run-1", botId: leadA.id, requestId: "req-a", repo: ALPHA, role: "builder", runStatus: "finished",
      scope: "run", input_tokens: 1000, uncached_input_tokens: 600, cache_read_tokens: 400, cache_write_tokens: 0, output_tokens: 200, total_tokens: 1200, cost_cents: 30, charged_cents: 25,
    });
    await add("2026-10-07T11:00:00.000Z", {
      status: "recorded", agentId: "bc-2", runId: "run-1", botId: leadB.id, requestId: "req-b", repo: BETA, role: "builder", runStatus: "finished",
      scope: "run", input_tokens: 500, uncached_input_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, output_tokens: 50, total_tokens: null, cost_cents: null, charged_cents: null,
    });
    await add("2026-10-07T12:00:00.000Z", {
      status: "unavailable", reason: "usage_http_403", agentId: "bc-3", runId: "run-1", botId: leadA.id, requestId: null, repo: ALPHA, role: "builder", runStatus: "error",
    });
    await store.appendEvent({ ownerId: OWNER, actor: "alpha-lead", action: "heartbeat", target: leadA.id, result: { status: "ok" }, at: NOW });
  }

  it("is owner-only and totals recorded receipts, keeping unknown cost unknown", async () => {
    const store = createMemoryConnectorStore({ bots: [leadA, leadB, ceo] });
    await receipts(store);
    expect((await getUsageView(null, "view=usage", store, NOW)).status).toBe(401);
    const view = await getUsageView(ownerCookie(), "view=usage", store, NOW);
    expect(view.status).toBe(200);
    const body = view.body as Body;
    expect(body).toMatchObject({
      count: 3,
      recorded: 2,
      unavailable: 1,
      totals: { input_tokens: 1500, output_tokens: 250, cache_read_tokens: 400, cost_cents: null, charged_cents: null },
    });
    const list = body.receipts as Body[];
    expect(list.map((item) => item.agentId)).toEqual(["bc-3", "bc-2", "bc-1"]);
    expect(list[0]).toMatchObject({ status: "unavailable", reason: "usage_http_403", bot: "alpha-lead" });
    expect(body.byRepo).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repo: ALPHA, runs: 2, recorded: 1, input_tokens: 1000, output_tokens: 200, charged_cents: 25 }),
        expect.objectContaining({ repo: BETA, runs: 1, recorded: 1, input_tokens: 500, charged_cents: null }),
      ]),
    );
  });

  it("filters by repo, request and status and caps the list", async () => {
    const store = createMemoryConnectorStore({ bots: [leadA, leadB, ceo] });
    await receipts(store);
    const cookie = ownerCookie();
    const get = async (query: string) => (await getUsageView(cookie, `view=usage&${query}`, store, NOW)).body as Body;
    expect((await get(`repo=${ALPHA}`)).count).toBe(2);
    expect((await get("requestId=req-b")).totals).toMatchObject({ input_tokens: 500, charged_cents: null });
    expect((await get("status=recorded")).count).toBe(2);
    expect((await get("limit=1")).receipts as unknown[]).toHaveLength(1);
    expect((await get("limit=1")).count).toBe(3);
    const bad = await getUsageView(cookie, "view=usage&status=lost", store, NOW);
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ reason: "invalid_filter", filter: "status" });
  });

  it("answers 'usage' in HQ chat from the receipts with no model call; cost asks stay cost", async () => {
    for (const text of ["usage", "Usage", "usage receipts", "show usage", "token usage", "what's the usage?"]) {
      expect(classifyQuestion(text), text).toBe("usage");
    }
    expect(classifyQuestion("cost")).toBe("cost");
    expect(classifyQuestion("how much have we spent")).toBe("cost");
    const store = createMemoryConnectorStore({ bots: [leadA, leadB, ceo] });
    await receipts(store);
    const sheet = parseRoleSheet(readFileSync("gateway/role-sheet.yaml", "utf8"));
    const deps: HqDeps = {
      ceo: createScriptedCeo(sheet),
      ceoEnabled: true,
      sheet,
      catalog: [],
      shippedCrews: SHIPPED_CREWS,
      exhaustedPools: [],
      knownHosts: ["example.com"],
      slotCap: 3,
      runtimes: {},
      controlReachable: true,
      connector: store,
    };
    const result = await handleChat(new MemoryStore(() => new Date(NOW)), deps, "usage");
    expect(result.modelCalls).toBe(0);
    expect(deps.ceo.calls).toBe(0);
    expect(result.kind).toBe("cost");
    expect(result.text.split("\n")[0]).toMatch(/^Usage receipts: 3 runs \(2 recorded, 1 unavailable\)\./);
    expect(result.text).toContain("1500 input");
    expect(result.text).toContain("250 output");
    expect(result.text).toContain("Charged: unknown");
    const none = await handleChat(new MemoryStore(() => new Date(NOW)), { ...deps, connector: createMemoryConnectorStore() }, "usage");
    expect(none.text).toMatch(/^No usage receipts yet\./);
  });
});

describe("reuse scan: skill suggestion to the CEO", () => {
  it("uses agent-brake's thresholds", () => {
    expect(REUSE_MIN_SUCCESSES).toBe(3);
    expect(REUSE_MIN_AGENTS).toBe(2);
  });

  it("refuses an approach that is not a lowercase slug", async () => {
    const { call } = setup();
    expect((await call(leadA, "post", { type: "finding", body: "x", approach: "Diff Stat!" })).body).toMatchObject({
      status: "refused",
      reason: "invalid_approach",
    });
  });

  it("suggests once after 3 verified successes across 2 agents, and only the CEO sees it", async () => {
    const { call, store } = setup();
    const note = async (auth: ConnectorAuth, body: string, type = "finding") =>
      String((await call(auth, "post", { type, body, approach: "diffstat-first", scope: "shared" })).body.postId);
    const a1 = await note(leadA, "diffstat before reading patches saved a big read");
    const a2 = await note(leadA, "diffstat first again on another PR");
    const b1 = await note(leadB, "diffstat first in beta too", "shortcut");
    const verify = (id: string) => call(ceo, "verify_post", { postId: id });
    await verify(a1);
    await verify(a2);
    expect(await alerts(store, SKILL_SUGGESTION_KIND)).toHaveLength(0);
    const third = await verify(b1);
    expect(third.body).toMatchObject({ status: "verified", skillSuggestion: expect.any(String) });
    const posts = await alerts(store, SKILL_SUGGESTION_KIND);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ author: "hq", approach: "diffstat-first" });
    expect(posts[0]?.body).toMatch(/^SKILL SUGGESTION: /);
    expect(posts[0]?.body).toContain("diffstat-first");
    expect(posts[0]?.body).toContain("3 successes across 2 agents");
    expect(posts[0]?.body).toContain("Nothing was written");
    expect((await store.listEvents()).filter((event) => event.action === "skill_suggestion")).toHaveLength(1);

    expect(((await call(ceo, "get_context", {})).body.suggestions as Body[]).map((item) => item.id)).toEqual([posts[0]?.id]);
    expect((await call(leadA, "get_context", {})).body.suggestions).toBeUndefined();
    expect(JSON.stringify((await call(leadA, "get_context", {})).body)).not.toContain("SKILL SUGGESTION");

    const a3 = await note(leadA, "and once more");
    await verify(a3);
    expect(await alerts(store, SKILL_SUGGESTION_KIND)).toHaveLength(1);
    expect((await store.listEvents()).filter((event) => event.action === "skill_suggestion")).toHaveLength(1);
  });

  it("does not count claimed notes, or three successes by one agent", async () => {
    const { call, store } = setup();
    for (const body of ["one", "two", "three"]) await call(leadA, "post", { type: "finding", body, approach: "solo-trick" });
    for (const body of ["four", "five"]) await call(leadB, "post", { type: "finding", body, approach: "solo-trick" });
    const ids = (await store.listPosts()).filter((post) => post.author === "alpha-lead").map((post) => post.id);
    for (const id of ids) await call(ceo, "verify_post", { postId: id });
    expect(await alerts(store, SKILL_SUGGESTION_KIND)).toHaveLength(0);
  });

  it("counts Checker passes with an approach, one per run, crediting validated agents", async () => {
    const checker = fakeChecker(["success", "success", "success", "success"]);
    const { call, store } = setup(checker);
    await request(store, "req-1", ALPHA, leadA.id, null, "7");
    for (const [id, handle] of [["row-1", "bc-1"], ["row-2", "bc-2"]] as const) {
      await store.saveAgent({ id, ownerId: OWNER, botId: leadA.id, cursorHandle: handle, repo: ALPHA, role: "builder", family: "grok", status: "finished", idempotencyKey: id, result: null });
    }
    const check = (n: number, agentId: string) =>
      call(leadA, "request_checks", { requestId: "req-1", repo: ALPHA, sha: sha(n), pullRequest: "7", approach: "lint-before-build", agentId });
    expect((await check(1, "bc-1")).body).toMatchObject({ status: "ready", approach: "lint-before-build" });
    // Re-polling the same passed run counts once.
    await check(1, "bc-1");
    await check(2, "bc-1");
    expect(await alerts(store, SKILL_SUGGESTION_KIND)).toHaveLength(0);
    const third = await check(3, "bc-2");
    expect(third.body.skillSuggestion).toEqual(expect.any(String));
    expect(await alerts(store, SKILL_SUGGESTION_KIND)).toHaveLength(1);
  });

  it("does not credit made-up agent ids as distinct agents", async () => {
    const checker = fakeChecker(["success", "success", "success"]);
    const { call, store } = setup(checker);
    await request(store, "req-1", ALPHA, leadA.id, null, "7");
    for (const n of [1, 2, 3]) {
      await call(leadA, "request_checks", { requestId: "req-1", repo: ALPHA, sha: sha(n), pullRequest: "7", approach: "fake-agents", agentId: `ghost-${n}` });
    }
    expect(await alerts(store, SKILL_SUGGESTION_KIND)).toHaveLength(0);
  });
});
