import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assembleTower } from "../../app/(hq)/tower-model.ts";
import { decideApproval } from "../../hq/approval.ts";
import {
  PINNED_CHECKER_PATH,
  PINNED_CHECKER_WORKFLOW,
  applyCheckEvidence,
  bindingFromArgs,
  checkerPassedCurrentSha,
  checkerRunName,
  checksMoveRequestReady,
  HEAD_LOOKUP_TIMEOUT_MS,
  createGhChecker,
  evidenceFromOutcome,
  findDispatchedCheckerRun,
  matchPinnedCheckerRun,
  type CheckerGateway,
} from "../../hq/checker.ts";
import {
  callConnectorTool,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  hashBotToken,
  loadConnectorSheetText,
} from "../../hq/connector.ts";
import { decisionTrail } from "../../hq/decision-trail.ts";
import { DESIGN_SKETCH_ROLES } from "../../hq/design-gate.ts";
import { composeLaunchBrief } from "../../hq/personas.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import type { PlanCard } from "../../kernel/types.ts";
import { pinRows } from "./pin-fixtures.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const CEO = "44444444-4444-4444-8444-444444444444";
const TOKEN = "unit-quality-token";
const OTHER_TOKEN = "unit-other-token";
const CEO_TOKEN = "unit-ceo-token";
const NOW = "2026-10-06T05:00:00.000Z";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const SCOPES = [
  "whoami",
  "open_request",
  "update_request",
  "assign",
  "launch_agent",
  "request_checks",
  "get_context",
  "request_approval",
  "heartbeat",
];

function card(partial: Partial<PlanCard> = {}): PlanCard {
  return {
    crew: "change",
    personas: ["builder"],
    councilMode: "quick",
    tier: "T2",
    definitionOfDone: "checked",
    outOfScope: "none",
    needsOwner: [],
    newScreen: false,
    outwardAction: false,
    requiresDesignApproval: false,
    requiresApproval: false,
    ...partial,
  };
}

function fakeCursor(briefs: string[] = []) {
  return {
    async start(spec: { brief?: string }) {
      briefs.push(spec.brief ?? "");
      return { id: `agent-${briefs.length}`, runtime: "cursor-cloud" as const };
    },
    async status() {
      return { state: "running", usage: {} };
    },
    async cancel() {
      return { state: "confirmed" as const };
    },
    async collect() {
      return [];
    },
  };
}

function storeForLead() {
  return createMemoryConnectorStore({
    modelResolutions: pinRows(OWNER),
    bots: [
      {
        id: BOT,
        ownerId: OWNER,
        name: "unit-lead",
        kind: "lead",
        repos: ["owner/demo"],
        tools: SCOPES,
        currentTask: null,
        heartbeatAt: null,
      },
      {
        id: OTHER,
        ownerId: OWNER,
        name: "other-lead",
        kind: "lead",
        repos: ["owner/demo"],
        tools: SCOPES,
        currentTask: null,
        heartbeatAt: null,
      },
      {
        id: CEO,
        ownerId: OWNER,
        name: "unit-ceo",
        kind: "ceo",
        repos: ["owner/demo"],
        tools: SCOPES,
        currentTask: null,
        heartbeatAt: null,
      },
    ],
    tokens: [
      { tokenHash: hashBotToken(TOKEN), botId: BOT, scopes: SCOPES },
      { tokenHash: hashBotToken(OTHER_TOKEN), botId: OTHER, scopes: SCOPES },
      { tokenHash: hashBotToken(CEO_TOKEN), botId: CEO, scopes: SCOPES },
    ],
  });
}

function depsFor(
  store: ReturnType<typeof storeForLead>,
  extra?: Partial<Parameters<typeof createDefaultConnectorDeps>[0]>,
) {
  return createDefaultConnectorDeps({
    store,
    sheet: parseRoleSheet(loadConnectorSheetText()),
    cursor: extra?.cursor ?? null,
    cursorConfigured: extra?.cursorConfigured ?? false,
    checker: extra?.checker ?? null,
    checkerConfigured: extra?.checkerConfigured ?? Boolean(extra?.checker),
    ownerId: OWNER,
    now: () => NOW,
    ...extra,
  });
}

function passingChecker(): CheckerGateway {
  return {
    async dispatch(input) {
      return {
        dispatched: true,
        githubRunId: "1001",
        sha: input.sha,
        nonce: input.nonce,
        url: "https://example.test/1001",
        workflow: PINNED_CHECKER_WORKFLOW,
        hostRepo: "owner/workers",
        trustedRef: "main",
      };
    },
    async find() {
      return "1001";
    },
    async outcome(input) {
      return {
        state: "completed",
        conclusion: "success",
        githubRunId: input.githubRunId,
        evidence: ["checker:build:pass", "checker:lint:pass", "checker:playwright:pass"],
      };
    },
  };
}

function queuedChecker(): CheckerGateway {
  return {
    async dispatch(input) {
      return {
        dispatched: true,
        githubRunId: "1002",
        sha: input.sha,
        nonce: input.nonce,
        url: "https://example.test/1002",
        workflow: PINNED_CHECKER_WORKFLOW,
        hostRepo: "owner/workers",
        trustedRef: "main",
      };
    },
    async find() {
      return "1002";
    },
    async outcome(input) {
      return {
        state: "in_progress",
        conclusion: null,
        githubRunId: input.githubRunId,
        evidence: [],
      };
    },
  };
}

function headChecker(head: string | Error | null, calls: Record<string, unknown>[] = []): CheckerGateway {
  return {
    ...passingChecker(),
    async head(input) {
      calls.push({ ...input });
      if (head instanceof Error) throw head;
      return head;
    },
    async bindingState() {
      return { exists: true, open: true, head: typeof head === "string" ? head : null };
    },
  };
}

const HEAD_SHA = "cccccccccccccccccccccccccccccccccccccccc";

describe("Stage 2 quality loop", () => {
  it("runs pinned checks and moves the request to ready_for_review with evidence", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(SHA), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Ship the checker",
      repo: "owner/demo",
      pullRequest: "27",
      card: card(),
    });
    const requestId = String(opened.structuredContent.requestId);
    const checks = await callConnectorTool(deps, auth, "request_checks", {
      requestId,
      repo: "owner/demo",
      sha: SHA,
      runId: "e",
    });
    expect(checks.isError).toBe(false);
    expect(checks.structuredContent).toMatchObject({
      status: "ready",
      ready: true,
      workflow: "checker.yml",
      githubRunId: "1001",
      requestStatus: "ready_for_review",
    });
    expect(JSON.stringify(checks.structuredContent.evidence)).toContain(`checker:sha:${SHA}`);
    expect(JSON.stringify(checks.structuredContent.evidence)).toContain("playwright");
    const request = await store.getRequest(requestId);
    expect(request?.status).toBe("ready_for_review");
    expect(request?.evidence.some((item) => item.includes("checker.yml"))).toBe(true);
  });

  it("returns in_progress until GitHub has a conclusion", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: queuedChecker(), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Wait for checks",
      repo: "owner/demo",
      card: card(),
    });
    const checks = await callConnectorTool(deps, auth, "request_checks", {
      requestId: opened.structuredContent.requestId,
      repo: "owner/demo",
      sha: SHA,
    });
    expect(checks.structuredContent.status).toBe("in_progress");
    expect(checks.structuredContent.ready).toBe(false);
    expect(checks.isError).toBe(false);
  });

  it("returns not-configured when GH_HQ_TOKEN is missing", async () => {
    const previousToken = process.env.GH_HQ_TOKEN;
    const previousRepo = process.env.GH_WORKERS_REPO;
    delete process.env.GH_HQ_TOKEN;
    process.env.GH_WORKERS_REPO = "owner/workers";
    try {
      const store = storeForLead();
      const deps = createDefaultConnectorDeps({
        store,
        sheet: parseRoleSheet(loadConnectorSheetText()),
        cursor: null,
        cursorConfigured: false,
        ownerId: OWNER,
        now: () => NOW,
      });
      expect(deps.checker).toBeNull();
      expect(deps.checkerConfigured).toBe(false);
      const auth = await store.authenticate(hashBotToken(TOKEN));
      const opened = await callConnectorTool(deps, auth, "open_request", {
        goal: "Ship the checker",
        repo: "owner/demo",
        card: card(),
      });
      const checks = await callConnectorTool(deps, auth, "request_checks", {
        requestId: opened.structuredContent.requestId,
        repo: "owner/demo",
        sha: SHA,
      });
      expect(checks.structuredContent.status).toBe("not-configured");
      expect(checks.structuredContent.ready).toBe(false);
      expect(checks.isError).toBe(true);
    } finally {
      if (previousToken === undefined) delete process.env.GH_HQ_TOKEN;
      else process.env.GH_HQ_TOKEN = previousToken;
      if (previousRepo === undefined) delete process.env.GH_WORKERS_REPO;
      else process.env.GH_WORKERS_REPO = previousRepo;
    }
  });

  it("looks up the exact GitHub run id for checker.yml and the commit, not a name substring", async () => {
    const nonce = "nonce-hq-1";
    const name = checkerRunName({ repo: "owner/demo", sha: SHA, nonce });
    const calls: { url: string; body: string }[] = [];
    let listed = 0;
    const checker = createGhChecker({
      token: "unit-token",
      hostRepo: "owner/workers",
      apiBase: "https://example.test",
      findAttempts: 1,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, body: String(init?.body ?? "") });
        if (url.endsWith("/dispatches")) return new Response(null, { status: 204 });
        if (url.includes(`/workflows/${PINNED_CHECKER_WORKFLOW}/runs`)) {
          listed += 1;
          const visible = listed > 1;
          return Response.json({
            workflow_runs: [
              {
                id: 1,
                name: "deploy prod",
                path: "evil/.github/workflows/checker.yml",
                event: "push",
                head_branch: "evil",
                status: "completed",
                conclusion: "success",
                created_at: "2026-10-06T05:00:00.000Z",
              },
              ...(visible
                ? [
                    {
                      id: 99,
                      name,
                      path: PINNED_CHECKER_PATH,
                      event: "workflow_dispatch",
                      head_branch: "main",
                      status: "in_progress",
                      conclusion: null,
                      created_at: "2026-10-06T05:00:01.000Z",
                    },
                  ]
                : []),
            ],
          });
        }
        if (url.endsWith("/actions/runs/99")) {
          return Response.json({
            id: 99,
            name,
            path: PINNED_CHECKER_PATH,
            event: "workflow_dispatch",
            head_branch: "main",
            status: "in_progress",
            conclusion: null,
            html_url: "https://example.test/99",
          });
        }
        return new Response("missing", { status: 404 });
      },
    });
    const dispatched = await checker.dispatch({ repo: "owner/demo", sha: SHA, nonce });
    const post = calls.find((call) => call.url.endsWith("/dispatches"));
    expect(post?.url).toBe(
      `https://example.test/repos/owner/workers/actions/workflows/${PINNED_CHECKER_WORKFLOW}/dispatches`,
    );
    const dispatchedBody = JSON.parse(post?.body || "{}") as { ref: string; inputs: Record<string, string> };
    expect(dispatchedBody.ref).toBe("main");
    expect(dispatchedBody.inputs).toEqual({ target_repo: "owner/demo", target_sha: SHA, nonce });
    expect(dispatched.githubRunId).toBe("99");
    const outcome = await checker.outcome({ githubRunId: "99", sha: SHA, repo: "owner/demo", nonce });
    expect(outcome.state).toBe("in_progress");
    expect(checksMoveRequestReady(outcome)).toBe(false);

    const expected = { repo: "owner/demo", sha: SHA, nonce, githubRunId: "99" };
    expect(
      matchPinnedCheckerRun(
        { id: 1, name: "deploy prod", path: "evil/.github/workflows/checker.yml", event: "push", head_branch: "evil" },
        expected,
      ),
    ).toBe(false);
    expect(
      matchPinnedCheckerRun(
        { id: 99, name, path: PINNED_CHECKER_PATH, event: "push", head_branch: "main" },
        expected,
      ),
    ).toBe(false);
    expect(
      matchPinnedCheckerRun(
        { id: 99, name, path: PINNED_CHECKER_PATH, event: "workflow_dispatch", head_branch: "evil" },
        expected,
      ),
    ).toBe(false);
    expect(findDispatchedCheckerRun([{ id: 1, name: "deploy prod", path: PINNED_CHECKER_PATH, event: "push", head_branch: "main" }], expected)).toBeNull();
  });

  it("refuses request_checks for another bot's request and for an out-of-scope repo", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: passingChecker(), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const other = await store.authenticate(hashBotToken(OTHER_TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Owned by unit-lead",
      repo: "owner/demo",
      card: card(),
    });
    const requestId = String(opened.structuredContent.requestId);
    const row = await store.getRequest(requestId);
    expect(row).not.toBeNull();
    row!.assignedBotId = BOT;
    await store.saveRequest(row!);

    const stolen = await callConnectorTool(deps, other, "request_checks", {
      requestId,
      repo: "owner/demo",
      sha: SHA,
    });
    expect(stolen.structuredContent).toMatchObject({ status: "refused", reason: "not_own_request", ready: false });
    expect((await store.getRequest(requestId))?.status).not.toBe("ready_for_review");

    const scoped = await callConnectorTool(deps, auth, "request_checks", {
      requestId,
      repo: "owner/other",
      sha: SHA,
    });
    expect(scoped.structuredContent).toMatchObject({ status: "refused", reason: "repo_out_of_scope", ready: false });
  });

  it("refuses launch_agent until design approval, then allows it", async () => {
    const store = storeForLead();
    const briefs: string[] = [];
    const deps = depsFor(store, { cursorConfigured: true, cursor: fakeCursor(briefs) });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "New settings screen",
      repo: "owner/demo",
      card: card({ newScreen: true, personas: ["designer", "builder"] }),
    });
    expect(opened.structuredContent.requestStatus).toBe("needs_you");
    const requestId = String(opened.structuredContent.requestId);
    const designApprovalId = String(opened.structuredContent.designApprovalId);
    const blocked = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "builder",
      brief: "Build the settings screen.",
      idempotencyKey: "design-1",
      requestId,
    });
    expect(blocked.structuredContent).toMatchObject({
      status: "refused",
      reason: "design_approval_required",
    });

    const sketch = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "designer",
      brief: "Sketch the settings screen.",
      idempotencyKey: "design-sketch",
      requestId,
    });
    expect(sketch.structuredContent.status).toBe("launched");

    await decideApproval(store, { approvalId: designApprovalId, decision: "approved", now: () => NOW, env: {} });
    const after = await store.getRequest(requestId);
    expect(after?.status).toBe("queued");

    const launched = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "builder",
      brief: "Build the settings screen.",
      idempotencyKey: "design-2",
      requestId,
    });
    expect(launched.structuredContent.status).toBe("launched");
    expect(launched.structuredContent.persona).toBe("builder");
    expect(briefs.some((brief) => brief.includes("Persona contract (builder):") && brief.includes("Brief:"))).toBe(
      true,
    );
  });

  it("refuses builder launches without a real requestId", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { cursorConfigured: true, cursor: fakeCursor() });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const missing = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "builder",
      brief: "Build a label.",
      idempotencyKey: "no-request",
    });
    expect(missing.structuredContent).toMatchObject({ status: "refused", reason: "request_required" });
    const unknown = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "builder",
      brief: "Build a label.",
      idempotencyKey: "bad-request",
      requestId: "44444444-4444-4444-8444-444444444444",
    });
    expect(unknown.structuredContent).toMatchObject({ status: "refused", reason: "unknown_request" });
  });

  it("refuses a design approval from another request, and pending or denied approvals", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { cursorConfigured: true, cursor: fakeCursor() });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const first = await callConnectorTool(deps, auth, "open_request", {
      goal: "Screen A",
      repo: "owner/demo",
      card: card({ newScreen: true }),
    });
    const second = await callConnectorTool(deps, auth, "open_request", {
      goal: "Screen B",
      repo: "owner/demo",
      card: card({ newScreen: true }),
    });
    const requestA = String(first.structuredContent.requestId);
    const requestB = String(second.structuredContent.requestId);
    const approvalA = String(first.structuredContent.designApprovalId);
    const approvalB = String(second.structuredContent.designApprovalId);

    const pending = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "builder",
      brief: "Build B.",
      idempotencyKey: "pending-b",
      requestId: requestB,
    });
    expect(pending.structuredContent.reason).toBe("design_approval_required");

    await decideApproval(store, { approvalId: approvalB, decision: "denied", now: () => NOW, env: {} });
    const denied = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "builder",
      brief: "Build B.",
      idempotencyKey: "denied-b",
      requestId: requestB,
    });
    expect(denied.structuredContent.reason).toBe("design_approval_required");

    await decideApproval(store, { approvalId: approvalA, decision: "approved", now: () => NOW, env: {} });
    const crossed = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "builder",
      brief: "Build B.",
      idempotencyKey: "cross-b",
      requestId: requestB,
      approvalId: approvalA,
    });
    expect(crossed.structuredContent.reason).toBe("design_approval_required");

    const titled = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "Designer",
      brief: "Sketch B.",
      idempotencyKey: "capital-designer",
      requestId: requestB,
      approvalId: approvalA,
    });
    expect(titled.structuredContent.status).toBe("refused");
    expect(titled.structuredContent.reason).not.toBeUndefined();
    expect(DESIGN_SKETCH_ROLES.has("Designer")).toBe(false);
    expect(requestA).toBeTruthy();
  });

  it("injects the matching persona into the launched brief", async () => {
    const store = storeForLead();
    const briefs: string[] = [];
    const deps = depsFor(store, { cursorConfigured: true, cursor: fakeCursor(briefs) });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Check the work",
      repo: "owner/demo",
      card: card(),
    });
    const result = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "qa_visual",
      brief: "Run the definition of done.",
      idempotencyKey: "persona-1",
      requestId: opened.structuredContent.requestId,
    });
    expect(result.structuredContent.persona).toBe("qa");
    expect(briefs[0]?.startsWith("Persona contract (qa):")).toBe(true);
    expect(briefs[0]).toContain("Brief:\nRun the definition of done.");
    expect(composeLaunchBrief("builder", "Change one label.").persona).toBe("builder");
  });

  it("exposes a why trail on get_context and the tower request card", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: passingChecker(), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Trail this request",
      repo: "owner/demo",
      card: card(),
    });
    const requestId = String(opened.structuredContent.requestId);
    await callConnectorTool(deps, auth, "request_checks", {
      requestId,
      repo: "owner/demo",
      sha: SHA,
    });
    const context = await callConnectorTool(deps, auth, "get_context", { requestId, repo: "owner/demo" });
    const why = context.structuredContent.why as { action: string; summary: string }[];
    expect(why.some((entry) => entry.action === "open_request")).toBe(true);
    expect(why.some((entry) => entry.action === "request_checks")).toBe(true);

    const events = await store.listEvents();
    expect(decisionTrail(events, requestId).length).toBeGreaterThan(1);
    const snapshot = assembleTower({
      nowMs: Date.parse(NOW),
      connector: {
        bots: [
          {
            id: BOT,
            ownerId: OWNER,
            name: "unit-lead",
            kind: "lead",
            repos: ["owner/demo"],
            tools: SCOPES,
            currentTask: null,
            heartbeatAt: NOW,
          },
        ],
        requests: [(await store.getRequest(requestId))!],
        events,
        approvals: [],
        agents: [],
      },
    });
    expect(snapshot.requests.items[0]?.trail.some((entry) => entry.action === "request_checks")).toBe(true);
  });

  it("keeps failed checks from marking the request ready", () => {
    const outcome = {
      state: "completed" as const,
      conclusion: "failure" as const,
      githubRunId: "9",
      evidence: ["checker:build:fail"],
    };
    expect(checksMoveRequestReady(outcome)).toBe(false);
    const next = applyCheckEvidence(
      {
        id: "r1",
        ownerId: OWNER,
        goal: "g",
        status: "running",
        card: null,
        evidence: [],
        assignedBotId: null,
        repo: "owner/demo",
        notices: [],
      },
      evidenceFromOutcome({
        workflow: PINNED_CHECKER_WORKFLOW,
        sha: SHA,
        repo: "owner/demo",
        hostRepo: "owner/workers",
        nonce: "n1",
        githubRunId: "9",
        outcome,
      }),
      false,
      { sha: SHA, repo: "owner/demo", head: SHA },
    );
    expect(next.status).toBe("verifying");
  });

  it("builds and tests subject/ at the target sha, not the judge sample", () => {
    const workflow = readFileSync("workers/.github/workflows/checker.yml", "utf8");
    expect(workflow).toContain("working-directory: subject");
    expect(workflow).not.toContain("judge/checker-sample");
    expect(workflow).toContain("ref: ${{ inputs.target_sha }}");
    expect(workflow).toContain("path: subject");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("nonce:");
  });

  it("does not dispatch again while a check is still appearing", async () => {
    let dispatches = 0;
    const checker: CheckerGateway = {
      async dispatch(input) {
        dispatches += 1;
        return {
          dispatched: true,
          githubRunId: null,
          sha: input.sha,
          nonce: input.nonce,
          url: null,
          workflow: PINNED_CHECKER_WORKFLOW,
          hostRepo: "owner/workers",
          trustedRef: "main",
        };
      },
      async find() {
        return null;
      },
      async outcome() {
        return { state: "queued", conclusion: null, githubRunId: null, evidence: [] };
      },
    };
    const store = storeForLead();
    const deps = depsFor(store, { checker, checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Once",
      repo: "owner/demo",
      card: card(),
    });
    const requestId = String(opened.structuredContent.requestId);
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    expect(dispatches).toBe(1);
    const nonce = (await store.getRequest(requestId))?.checkRun?.nonce;
    expect(nonce).toBeTruthy();
  });

  it("ignores a planted github run id and refuses ready_for_review from update_request", async () => {
    const seen: string[] = [];
    const checker: CheckerGateway = {
      async dispatch(input) {
        return {
          dispatched: true,
          githubRunId: "1001",
          sha: input.sha,
          nonce: input.nonce,
          url: "https://example.test/1001",
          workflow: PINNED_CHECKER_WORKFLOW,
          hostRepo: "owner/workers",
          trustedRef: "main",
        };
      },
      async find() {
        return "1001";
      },
      async outcome(input) {
        seen.push(input.githubRunId);
        return {
          state: "completed",
          conclusion: "success",
          githubRunId: input.githubRunId,
          evidence: ["checker:build:pass", "checker:lint:pass", "checker:playwright:pass"],
        };
      },
    };
    const store = storeForLead();
    const deps = depsFor(store, { checker, checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const other = await store.authenticate(hashBotToken(OTHER_TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Do not forge",
      repo: "owner/demo",
      card: card(),
    });
    const requestId = String(opened.structuredContent.requestId);
    const planted = await callConnectorTool(deps, other, "update_request", {
      requestId,
      evidence: ["checker:github_run:4242"],
      status: "ready_for_review",
    });
    expect(planted.structuredContent.reason).toBe("not_own_request");
    await callConnectorTool(deps, auth, "update_request", {
      requestId,
      evidence: ["checker:github_run:4242", "note"],
    });
    expect((await store.getRequest(requestId))?.evidence).toEqual(["note"]);
    expect((await store.getRequest(requestId))?.checkRun).toBeFalsy();
    const checks = await callConnectorTool(deps, auth, "request_checks", {
      requestId,
      repo: "owner/demo",
      sha: SHA,
    });
    expect(seen).toEqual(["1001"]);
    expect(checks.structuredContent.githubRunId).toBe("1001");
    expect(checks.structuredContent.githubRunId).not.toBe("4242");
  });

  it("clears ready_for_review when the commit under check changes", async () => {
    const checker: CheckerGateway = {
      async dispatch(input) {
        return {
          dispatched: true,
          githubRunId: input.sha === SHA ? "1001" : "2002",
          sha: input.sha,
          nonce: input.nonce,
          url: "https://example.test/run",
          workflow: PINNED_CHECKER_WORKFLOW,
          hostRepo: "owner/workers",
          trustedRef: "main",
        };
      },
      async find(input) {
        return input.sha === SHA ? "1001" : "2002";
      },
      async outcome(input) {
        if (input.sha === SHA) {
          return {
            state: "completed",
            conclusion: "success",
            githubRunId: input.githubRunId,
            evidence: ["checker:build:pass", "checker:lint:pass", "checker:playwright:pass"],
          };
        }
        return { state: "in_progress", conclusion: null, githubRunId: input.githubRunId, evidence: [] };
      },
      async head() {
        return SHA;
      },
    };
    const store = storeForLead();
    const deps = depsFor(store, { checker, checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "New sha",
      repo: "owner/demo",
      pullRequest: "31",
      card: card(),
    });
    const requestId = String(opened.structuredContent.requestId);
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    expect((await store.getRequest(requestId))?.status).toBe("ready_for_review");
    const firstNonce = (await store.getRequest(requestId))?.checkRun?.nonce;
    const nextSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const again = await callConnectorTool(deps, auth, "request_checks", {
      requestId,
      repo: "owner/demo",
      sha: nextSha,
    });
    expect(again.structuredContent.ready).toBe(false);
    expect((await store.getRequest(requestId))?.status).toBe("verifying");
    expect((await store.getRequest(requestId))?.checkRun?.sha).toBe(nextSha);
    expect((await store.getRequest(requestId))?.checkRun?.githubRunId).toBe("2002");
    expect((await store.getRequest(requestId))?.checkRun?.nonce).not.toBe(firstNonce);
  });

  it("refuses another bot setting done, and fake evidence cannot skip the checker", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: passingChecker(), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const other = await store.authenticate(hashBotToken(OTHER_TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Finish it",
      repo: "owner/demo",
      card: card(),
    });
    const requestId = String(opened.structuredContent.requestId);
    const stolen = await callConnectorTool(deps, other, "update_request", {
      requestId,
      status: "done",
      evidence: ["x"],
    });
    expect(stolen.structuredContent).toMatchObject({ status: "refused", reason: "not_own_request" });
    const empty = await callConnectorTool(deps, auth, "update_request", {
      requestId,
      status: "done",
      evidence: [],
    });
    expect(empty.structuredContent.reason).toBe("done_requires_evidence");
    const fake = await callConnectorTool(deps, auth, "update_request", {
      requestId,
      status: "done",
      evidence: ["x"],
    });
    expect(fake.structuredContent.reason).toBe("done_requires_checks");
    expect((await store.getRequest(requestId))?.status).not.toBe("done");
  });

  it("allows done after a checker pass on the current sha, then blocks it after a sha change", async () => {
    const checker: CheckerGateway = {
      async dispatch(input) {
        return {
          dispatched: true,
          githubRunId: input.sha === SHA ? "1001" : "2002",
          sha: input.sha,
          nonce: input.nonce,
          url: "https://example.test/run",
          workflow: PINNED_CHECKER_WORKFLOW,
          hostRepo: "owner/workers",
          trustedRef: "main",
        };
      },
      async find(input) {
        return input.sha === SHA ? "1001" : "2002";
      },
      async outcome(input) {
        if (input.sha === SHA) {
          return {
            state: "completed",
            conclusion: "success",
            githubRunId: input.githubRunId,
            evidence: ["checker:build:pass", "checker:lint:pass", "checker:playwright:pass"],
          };
        }
        return { state: "in_progress", conclusion: null, githubRunId: input.githubRunId, evidence: [] };
      },
      async head() {
        return SHA;
      },
    };
    const store = storeForLead();
    const deps = depsFor(store, { checker, checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Land it",
      repo: "owner/demo",
      pullRequest: "27",
      card: card(),
    });
    const requestId = String(opened.structuredContent.requestId);
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    const done = await callConnectorTool(deps, auth, "update_request", {
      requestId,
      status: "done",
      evidence: ["preview"],
    });
    expect(done.structuredContent).toMatchObject({ status: "updated", requestStatus: "done" });

    const next = await callConnectorTool(deps, auth, "open_request", {
      goal: "Land again",
      repo: "owner/demo",
      pullRequest: "28",
      card: card(),
    });
    const requestB = String(next.structuredContent.requestId);
    await callConnectorTool(deps, auth, "request_checks", { requestId: requestB, repo: "owner/demo", sha: SHA });
    expect((await store.getRequest(requestB))?.status).toBe("ready_for_review");
    const nextSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    await callConnectorTool(deps, auth, "request_checks", {
      requestId: requestB,
      repo: "owner/demo",
      sha: nextSha,
    });
    const blocked = await callConnectorTool(deps, auth, "update_request", {
      requestId: requestB,
      status: "done",
      evidence: ["preview"],
    });
    expect(blocked.structuredContent.reason).toBe("done_requires_checks");
    expect((await store.getRequest(requestB))?.status).toBe("verifying");
  });

  it("limits assign to the CEO and lets the CEO update a request", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(SHA), checkerConfigured: true });
    const lead = await store.authenticate(hashBotToken(TOKEN));
    const ceo = await store.authenticate(hashBotToken(CEO_TOKEN));
    const opened = await callConnectorTool(deps, lead, "open_request", {
      goal: "Assign later",
      repo: "owner/demo",
      pullRequest: "29",
      card: card(),
    });
    const requestId = String(opened.structuredContent.requestId);
    const refused = await callConnectorTool(deps, lead, "assign", { requestId, botId: OTHER });
    expect(refused.structuredContent.reason).toBe("ceo_only");
    const assigned = await callConnectorTool(deps, ceo, "assign", { requestId, botId: BOT });
    expect(assigned.structuredContent).toMatchObject({ status: "assigned", botId: BOT });
    await callConnectorTool(deps, lead, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    const done = await callConnectorTool(deps, ceo, "update_request", {
      requestId,
      status: "done",
      evidence: ["preview"],
    });
    expect(done.structuredContent).toMatchObject({ status: "updated", requestStatus: "done" });
  });
});

describe("done is tied to the request's own PR or branch head", () => {
  async function openBound(
    deps: ReturnType<typeof depsFor>,
    auth: Awaited<ReturnType<ReturnType<typeof storeForLead>["authenticate"]>>,
    binding: Record<string, unknown> = { pullRequest: "27" },
  ) {
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Bound request",
      repo: "owner/demo",
      card: card(),
      ...binding,
    });
    return String(opened.structuredContent.requestId);
  }

  it("refuses done after a pass on an arbitrary sha that is not the bound PR head", async () => {
    const calls: Record<string, unknown>[] = [];
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(HEAD_SHA, calls), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const requestId = await openBound(deps, auth);
    const checks = await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    expect(checks.structuredContent.ready).toBe(true);
    const done = await callConnectorTool(deps, auth, "update_request", {
      requestId,
      status: "done",
      evidence: ["preview"],
    });
    expect(done.isError).toBe(true);
    expect(done.structuredContent).toMatchObject({
      status: "refused",
      reason: "done_requires_checks_on_head",
      head: HEAD_SHA,
      checkedSha: SHA,
    });
    // request_checks looks up the head (the pass is off-head, so the request stays verifying), then done does.
    expect(calls).toEqual([
      { repo: "owner/demo", pullRequest: "27", branch: null },
      { repo: "owner/demo", pullRequest: "27", branch: null },
    ]);
    expect((await store.getRequest(requestId))?.status).not.toBe("done");
  });

  it("allows done when the passing check is on the bound PR head", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(SHA), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const requestId = await openBound(deps, auth, { pull_request: "#27" });
    expect((await store.getRequest(requestId))?.pullRequest).toBe("27");
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    const done = await callConnectorTool(deps, auth, "update_request", {
      requestId,
      status: "done",
      evidence: ["preview"],
    });
    expect(done.structuredContent).toMatchObject({ status: "updated", requestStatus: "done" });
  });

  it("binds a branch on the first request_checks and compares against that branch head", async () => {
    const calls: Record<string, unknown>[] = [];
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(SHA, calls), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const requestId = await openBound(deps, auth, {});
    await callConnectorTool(deps, auth, "request_checks", {
      requestId,
      repo: "owner/demo",
      sha: SHA,
      branch: "feature/done-head",
    });
    expect((await store.getRequest(requestId))?.branch).toBe("feature/done-head");
    const done = await callConnectorTool(deps, auth, "update_request", {
      requestId,
      status: "done",
      evidence: ["preview"],
    });
    expect(done.structuredContent).toMatchObject({ status: "updated", requestStatus: "done" });
    expect(calls).toEqual([
      { repo: "owner/demo", pullRequest: null, branch: "feature/done-head" },
      { repo: "owner/demo", pullRequest: null, branch: "feature/done-head" },
    ]);
  });

  it("refuses to rebind a request to a different PR or branch", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(SHA), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const requestId = await openBound(deps, auth);
    const swapped = await callConnectorTool(deps, auth, "request_checks", {
      requestId,
      repo: "owner/demo",
      sha: SHA,
      pullRequest: "99",
    });
    expect(swapped.structuredContent).toMatchObject({ status: "refused", reason: "binding_mismatch" });
    const branch = await callConnectorTool(deps, auth, "request_checks", {
      requestId,
      repo: "owner/demo",
      sha: SHA,
      branch: "known-good",
    });
    expect(branch.structuredContent).toMatchObject({ status: "refused", reason: "binding_mismatch" });
    expect((await store.getRequest(requestId))?.checkRun).toBeFalsy();
  });

  it("refuses an invalid binding at open_request", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(SHA), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Bad binding",
      repo: "owner/demo",
      card: card(),
      branch: "../../etc",
    });
    expect(opened.structuredContent).toMatchObject({ status: "refused", reason: "invalid_binding" });
  });

  it("fails closed when no PR or branch is bound", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(SHA), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const requestId = await openBound(deps, auth, {});
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    const done = await callConnectorTool(deps, auth, "update_request", {
      requestId,
      status: "done",
      evidence: ["preview"],
    });
    expect(done.structuredContent).toMatchObject({ status: "refused", reason: "done_requires_binding" });
    expect((await store.getRequest(requestId))?.status).not.toBe("done");
  });

  it("fails closed when the GitHub head lookup fails or is unavailable", async () => {
    for (const [checker, reason] of [
      [headChecker(new Error("head_lookup_404")), "head_lookup_failed"],
      [headChecker(null), "head_lookup_failed"],
      [passingChecker(), "head_lookup_unavailable"],
    ] as const) {
      const store = storeForLead();
      const deps = depsFor(store, { checker, checkerConfigured: true });
      const auth = await store.authenticate(hashBotToken(TOKEN));
      const requestId = await openBound(deps, auth);
      await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
      const done = await callConnectorTool(deps, auth, "update_request", {
        requestId,
        status: "done",
        evidence: ["preview"],
      });
      expect(done.structuredContent).toMatchObject({ status: "refused", reason });
      expect((await store.getRequest(requestId))?.status).not.toBe("done");
    }
  });

  it("reopening after done clears the pass, so done again needs a fresh check", async () => {
    let dispatches = 0;
    const base = headChecker(SHA);
    const checker: CheckerGateway = {
      ...base,
      async dispatch(input) {
        dispatches += 1;
        return base.dispatch(input);
      },
    };
    const store = storeForLead();
    const deps = depsFor(store, { checker, checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const requestId = await openBound(deps, auth);
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    const first = await callConnectorTool(deps, auth, "update_request", {
      requestId,
      status: "done",
      evidence: ["preview"],
    });
    expect(first.structuredContent.requestStatus).toBe("done");
    const reopened = await callConnectorTool(deps, auth, "update_request", { requestId, status: "queued" });
    expect(reopened.structuredContent.requestStatus).toBe("queued");
    expect((await store.getRequest(requestId))?.checkRun ?? null).toBeNull();
    const again = await callConnectorTool(deps, auth, "update_request", {
      requestId,
      status: "done",
      evidence: ["preview"],
    });
    expect(again.structuredContent).toMatchObject({ status: "refused", reason: "done_requires_checks" });
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    expect(dispatches).toBe(2);
    const redone = await callConnectorTool(deps, auth, "update_request", {
      requestId,
      status: "done",
      evidence: ["preview"],
    });
    expect(redone.structuredContent.requestStatus).toBe("done");
  });

  it("unassigned request: owner bots are refused, the CEO may update, done still needs a check", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(SHA), checkerConfigured: true });
    const lead = await store.authenticate(hashBotToken(TOKEN));
    const ceo = await store.authenticate(hashBotToken(CEO_TOKEN));
    await store.saveRequest({
      id: "unassigned-1",
      ownerId: OWNER,
      goal: "Nobody owns this",
      status: "queued",
      card: null,
      evidence: [],
      assignedBotId: null,
      repo: "owner/demo",
      notices: [],
      pullRequest: "30",
      branch: null,
    });
    const byLead = await callConnectorTool(deps, lead, "update_request", { requestId: "unassigned-1", status: "running" });
    expect(byLead.structuredContent.reason).toBe("not_own_request");
    const checks = await callConnectorTool(deps, lead, "request_checks", {
      requestId: "unassigned-1",
      repo: "owner/demo",
      sha: SHA,
    });
    expect(checks.structuredContent.reason).toBe("not_own_request");
    const byCeo = await callConnectorTool(deps, ceo, "update_request", { requestId: "unassigned-1", status: "running" });
    expect(byCeo.structuredContent).toMatchObject({ status: "updated", requestStatus: "running" });
    const ceoDone = await callConnectorTool(deps, ceo, "update_request", {
      requestId: "unassigned-1",
      status: "done",
      evidence: ["preview"],
    });
    expect(ceoDone.structuredContent.reason).toBe("done_requires_checks");
  });

  it("CEO-claim fields in the arguments do not grant CEO rights", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(SHA), checkerConfigured: true });
    const lead = await store.authenticate(hashBotToken(TOKEN));
    const other = await store.authenticate(hashBotToken(OTHER_TOKEN));
    const requestId = await openBound(deps, lead);
    const claims = { kind: "ceo", role: "ceo", botId: CEO, bot_id: CEO, actor: "unit-ceo", ceo: true };
    const update = await callConnectorTool(deps, other, "update_request", { requestId, status: "running", ...claims });
    expect(update.structuredContent.reason).toBe("not_own_request");
    const assign = await callConnectorTool(deps, other, "assign", { requestId, ...claims, botId: OTHER });
    expect(assign.structuredContent.reason).toBe("ceo_only");
    expect((await store.getRequest(requestId))?.assignedBotId).toBe(BOT);
  });

  it("rejects status variants that are not exact request states", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: headChecker(SHA), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const requestId = await openBound(deps, auth);
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    for (const status of ["DONE", "Done", " done", "done ", "complete", "merged"]) {
      const result = await callConnectorTool(deps, auth, "update_request", { requestId, status, evidence: ["x"] });
      expect(result.structuredContent.reason).toBe("invalid_status");
    }
    const ready = await callConnectorTool(deps, auth, "update_request", { requestId, status: "ready_for_review" });
    expect(ready.structuredContent.reason).toBe("ready_requires_checks");
    expect((await store.getRequest(requestId))?.status).toBe("ready_for_review");
  });

  it("looks up the PR head and the branch head through the checker's GitHub token", async () => {
    const urls: string[] = [];
    const auths: string[] = [];
    const checker = createGhChecker({
      token: "unit-token",
      hostRepo: "owner/workers",
      apiBase: "https://example.test",
      fetchImpl: (async (url: string, init?: RequestInit) => {
        urls.push(String(url));
        auths.push(String((init?.headers as Record<string, string>)?.Authorization));
        if (String(url).endsWith("/pulls/27")) {
          return new Response(JSON.stringify({ head: { sha: SHA.toUpperCase() } }), { status: 200 });
        }
        if (String(url).includes("/git/ref/heads/")) {
          return new Response(JSON.stringify({ object: { sha: HEAD_SHA, type: "commit" } }), { status: 200 });
        }
        return new Response("{}", { status: 404 });
      }) as typeof fetch,
    });
    expect(await checker.head?.({ repo: "owner/demo", pullRequest: "27", branch: null })).toBe(SHA);
    expect(await checker.head?.({ repo: "owner/demo", pullRequest: null, branch: "feature/x" })).toBe(HEAD_SHA);
    await expect(checker.head?.({ repo: "owner/demo", pullRequest: "404", branch: null })).rejects.toThrow("head_lookup_404");
    expect(urls).toEqual([
      "https://example.test/repos/owner/demo/pulls/27",
      "https://example.test/repos/owner/demo/git/ref/heads/feature/x",
      "https://example.test/repos/owner/demo/pulls/404",
    ]);
    expect(auths.every((value) => value === "Bearer unit-token")).toBe(true);
  });

  it("times out a hung GitHub head lookup, so done fails closed", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const checker = createGhChecker({
      token: "unit-token",
      hostRepo: "owner/workers",
      apiBase: "https://example.test",
      headTimeoutMs: 20,
      fetchImpl: ((_url: string, init?: RequestInit) => {
        signals.push(init?.signal);
        const signal = init?.signal;
        if (!signal) return Promise.reject(new Error("no_signal"));
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
      }) as typeof fetch,
    });
    await expect(checker.head?.({ repo: "owner/demo", pullRequest: "27", branch: null })).rejects.toThrow();
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(signals[0]?.aborted).toBe(true);
    expect(HEAD_LOOKUP_TIMEOUT_MS).toBe(10_000);
  });

  it("does not overwrite a check that lands while the head lookup is in flight", async () => {
    const store = storeForLead();
    let during: (() => Promise<void>) | null = null;
    const checker: CheckerGateway = {
      ...passingChecker(),
      async head() {
        if (during) await during();
        return SHA;
      },
    };
    const deps = depsFor(store, { checker, checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const requestId = await openBound(deps, auth);
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    during = async () => {
      const fresh = await store.getRequest(requestId);
      if (!fresh?.checkRun) throw new Error("no check");
      await store.saveRequest({ ...fresh, checkRun: { ...fresh.checkRun, sha: HEAD_SHA, nonce: "newer", passed: false } });
    };
    const done = await callConnectorTool(deps, auth, "update_request", { requestId, status: "done", evidence: ["preview"] });
    expect(done.isError).toBe(true);
    expect(done.structuredContent).toMatchObject({ status: "refused", reason: "request_changed", requestId });
    const after = await store.getRequest(requestId);
    expect(after?.checkRun).toMatchObject({ sha: HEAD_SHA, nonce: "newer", passed: false });
    expect(after?.status).not.toBe("done");
  });

  it("keeps a concurrent evidence change when done goes through", async () => {
    const store = storeForLead();
    let during: (() => Promise<void>) | null = null;
    const checker: CheckerGateway = {
      ...passingChecker(),
      async head() {
        if (during) await during();
        return SHA;
      },
    };
    const deps = depsFor(store, { checker, checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const requestId = await openBound(deps, auth);
    await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
    during = async () => {
      const fresh = await store.getRequest(requestId);
      if (!fresh) throw new Error("no request");
      await store.saveRequest({ ...fresh, notices: [...fresh.notices, "concurrent-notice"] });
    };
    const done = await callConnectorTool(deps, auth, "update_request", { requestId, status: "done", evidence: ["preview"] });
    expect(done.structuredContent).toMatchObject({ status: "updated", requestStatus: "done" });
    const after = await store.getRequest(requestId);
    expect(after?.notices).toContain("concurrent-notice");
    expect(after?.status).toBe("done");
  });
});

describe("PR #27 done-binding nits", () => {
  const MOVED = "dddddddddddddddddddddddddddddddddddddddd";

  type BindingState = { exists: boolean; open: boolean; head: string | null };

  function movableChecker(
    initial: string,
    state: BindingState | Error | null = null,
    bindingCalls: Record<string, unknown>[] = [],
  ): CheckerGateway & { move(sha: string): void; dispatches: number } {
    let head = initial;
    const base = passingChecker();
    const checker = {
      ...base,
      dispatches: 0,
      move(sha: string) {
        head = sha;
      },
      async dispatch(input: Parameters<CheckerGateway["dispatch"]>[0]) {
        checker.dispatches += 1;
        return base.dispatch(input);
      },
      async head() {
        return head;
      },
      async bindingState(input: { repo: string; pullRequest: string | null; branch: string | null }) {
        bindingCalls.push({ ...input });
        if (state instanceof Error) throw state;
        return state ?? { exists: true, open: true, head };
      },
    };
    return checker;
  }

  async function openWith(
    deps: ReturnType<typeof depsFor>,
    auth: Awaited<ReturnType<ReturnType<typeof storeForLead>["authenticate"]>>,
    binding: Record<string, unknown>,
  ) {
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Nit pack",
      repo: "owner/demo",
      card: card(),
      ...binding,
    });
    return opened;
  }

  describe("1. a request binds to a PR or a branch, never both", () => {
    it("bindingFromArgs refuses both", () => {
      expect(bindingFromArgs({ pullRequest: "5", branch: "feature/x" })).toEqual({ ok: false, reason: "binding_pr_and_branch" });
      expect(bindingFromArgs({ pull_request: "#5", branch: "feature/x" })).toMatchObject({ ok: false });
      expect(bindingFromArgs({ pullRequest: "5" })).toEqual({ ok: true, binding: { pullRequest: "5", branch: null } });
      expect(bindingFromArgs({ branch: "feature/x" })).toEqual({ ok: true, binding: { pullRequest: null, branch: "feature/x" } });
    });

    it("open_request and request_checks refuse a PR plus a branch", async () => {
      const store = storeForLead();
      const deps = depsFor(store, { checker: movableChecker(SHA), checkerConfigured: true });
      const auth = await store.authenticate(hashBotToken(TOKEN));
      const both = await openWith(deps, auth, { pullRequest: "27", branch: "feature/x" });
      expect(both.structuredContent).toMatchObject({ status: "refused", reason: "binding_pr_and_branch" });
      const opened = await openWith(deps, auth, {});
      const requestId = String(opened.structuredContent.requestId);
      const checks = await callConnectorTool(deps, auth, "request_checks", {
        requestId,
        repo: "owner/demo",
        sha: SHA,
        pullRequest: "27",
        branch: "feature/x",
      });
      expect(checks.structuredContent).toMatchObject({ status: "refused", reason: "binding_pr_and_branch" });
      const row = await store.getRequest(requestId);
      expect(row?.pullRequest ?? null).toBeNull();
      expect(row?.branch ?? null).toBeNull();
    });

    it("the store refuses to save a request bound to both", async () => {
      const store = storeForLead();
      await expect(
        store.saveRequest({
          id: "both-1",
          ownerId: OWNER,
          goal: "both",
          status: "queued",
          card: null,
          evidence: [],
          assignedBotId: BOT,
          repo: "owner/demo",
          notices: [],
          pullRequest: "27",
          branch: "feature/x",
        }),
      ).rejects.toThrow("binding_pr_and_branch");
      expect(await store.getRequest("both-1")).toBeNull();
    });

    it("head() refuses an ambiguous binding instead of preferring one", async () => {
      const urls: string[] = [];
      const checker = createGhChecker({
        token: "unit-token",
        hostRepo: "owner/workers",
        apiBase: "https://example.test",
        fetchImpl: (async (url: string) => {
          urls.push(String(url));
          return new Response(JSON.stringify({ head: { sha: SHA } }), { status: 200 });
        }) as typeof fetch,
      });
      await expect(checker.head?.({ repo: "owner/demo", pullRequest: "27", branch: "feature/x" })).rejects.toThrow(
        "binding_ambiguous",
      );
      expect(urls).toEqual([]);
    });

    it("done fails closed on a legacy row that carries both", async () => {
      const store = storeForLead();
      const checker = movableChecker(SHA);
      const deps = depsFor(store, { checker, checkerConfigured: true });
      const auth = await store.authenticate(hashBotToken(TOKEN));
      const opened = await openWith(deps, auth, { pullRequest: "27" });
      const requestId = String(opened.structuredContent.requestId);
      await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
      const getRequest = store.getRequest.bind(store);
      store.getRequest = async (id: string) => {
        const row = await getRequest(id);
        return row ? { ...row, branch: "feature/x" } : row;
      };
      const done = await callConnectorTool(deps, auth, "update_request", { requestId, status: "done", evidence: ["preview"] });
      expect(done.structuredContent).toMatchObject({ status: "refused", reason: "binding_ambiguous" });
    });
  });

  describe("2. branch names follow git check-ref-format", () => {
    it("rejects dot segments, hidden segments, empty segments, trailing slash or .lock", () => {
      for (const branch of [
        ".",
        "..",
        "a/./b",
        "a/../b",
        "../../etc",
        ".hidden",
        "foo/.bar",
        "a//b",
        "a/",
        "/a",
        "a.lock",
        "feature/b.lock",
        "a.lock/b",
        "a.",
        "-flag",
        "HEAD",
        "a b",
        "a~1",
        "a^",
        "a:b",
        "a@{1}",
        "x".repeat(201),
      ]) {
        expect(bindingFromArgs({ branch }), branch).toMatchObject({ ok: false });
      }
    });

    it("accepts ordinary branch names", () => {
      for (const branch of ["main", "feature/x", "release-1.2", "a.b/c_d", "dexter/v5-G3", "a.locked", "lock.a", "x".repeat(200)]) {
        expect(bindingFromArgs({ branch }), branch).toMatchObject({ ok: true });
      }
    });
  });

  describe("3. a done request whose bound head moves loses its passing evidence", () => {
    async function doneAt(checker: ReturnType<typeof movableChecker>) {
      const store = storeForLead();
      const deps = depsFor(store, { checker, checkerConfigured: true });
      const auth = await store.authenticate(hashBotToken(TOKEN));
      const opened = await openWith(deps, auth, { pullRequest: "27" });
      const requestId = String(opened.structuredContent.requestId);
      await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
      const done = await callConnectorTool(deps, auth, "update_request", { requestId, status: "done", evidence: ["preview"] });
      expect(done.structuredContent).toMatchObject({ status: "updated", requestStatus: "done" });
      expect((await store.getRequest(requestId))?.checkRun?.passed).toBe(true);
      return { store, deps, auth, requestId };
    }

    it("update_request on a done request invalidates the stored pass when the head moved", async () => {
      const checker = movableChecker(SHA);
      const { store, deps, auth, requestId } = await doneAt(checker);
      checker.move(MOVED);
      const again = await callConnectorTool(deps, auth, "update_request", { requestId, status: "done", evidence: ["preview"] });
      expect(again.structuredContent).toMatchObject({
        status: "refused",
        reason: "done_requires_checks_on_head",
        head: MOVED,
        checkedSha: SHA,
        checkRunInvalidated: true,
      });
      const row = await store.getRequest(requestId);
      expect(row?.checkRun?.sha).toBe(SHA);
      expect(row?.checkRun?.passed).toBe(false);
      expect(checkerPassedCurrentSha(row!)).toBe(false);
    });

    it("request_checks on a done request does not keep a pass for a sha that is no longer the head", async () => {
      const checker = movableChecker(SHA);
      const { store, deps, auth, requestId } = await doneAt(checker);
      checker.move(MOVED);
      const recheck = await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
      expect(recheck.structuredContent.ready).toBe(true);
      const row = await store.getRequest(requestId);
      expect(row?.checkRun?.sha).toBe(SHA);
      expect(row?.checkRun?.passed).toBe(false);
      expect(checkerPassedCurrentSha(row!)).toBe(false);
    });
  });

  describe("4. ready_for_review needs a pass on the current bound head", () => {
    const base = {
      id: "r1",
      ownerId: OWNER,
      goal: "g",
      status: "verifying" as const,
      card: null,
      evidence: [],
      assignedBotId: BOT,
      repo: "owner/demo",
      notices: [],
      pullRequest: "27",
      branch: null,
    };

    it("applyCheckEvidence only sets ready_for_review when the passing sha is the bound head", () => {
      expect(applyCheckEvidence({ ...base }, [], true, { sha: SHA, repo: "owner/demo", head: SHA }).status).toBe("ready_for_review");
      expect(applyCheckEvidence({ ...base }, [], true, { sha: SHA, repo: "owner/demo", head: SHA.toUpperCase() }).status).toBe(
        "ready_for_review",
      );
      expect(applyCheckEvidence({ ...base }, [], true, { sha: SHA, repo: "owner/demo", head: MOVED }).status).toBe("verifying");
      expect(applyCheckEvidence({ ...base }, [], true, { sha: SHA, repo: "owner/demo", head: null }).status).toBe("verifying");
      expect(
        applyCheckEvidence({ ...base, status: "ready_for_review" }, [], true, { sha: SHA, repo: "owner/demo", head: MOVED }).status,
      ).toBe("verifying");
    });

    it("request_checks reports the pass but keeps the request verifying when the sha is not the bound head", async () => {
      const store = storeForLead();
      const deps = depsFor(store, { checker: movableChecker(MOVED), checkerConfigured: true });
      const auth = await store.authenticate(hashBotToken(TOKEN));
      const opened = await openWith(deps, auth, { pullRequest: "27" });
      const requestId = String(opened.structuredContent.requestId);
      const checks = await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
      expect(checks.structuredContent).toMatchObject({ status: "ready", ready: true, onBoundHead: false, requestStatus: "verifying" });
      expect((await store.getRequest(requestId))?.status).toBe("verifying");
    });

    it("an unbound request never reaches ready_for_review", async () => {
      const store = storeForLead();
      const deps = depsFor(store, { checker: movableChecker(SHA), checkerConfigured: true });
      const auth = await store.authenticate(hashBotToken(TOKEN));
      const opened = await openWith(deps, auth, {});
      const requestId = String(opened.structuredContent.requestId);
      const checks = await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
      expect(checks.structuredContent).toMatchObject({ ready: true, onBoundHead: false });
      expect((await store.getRequest(requestId))?.status).not.toBe("ready_for_review");
    });

    it("a head lookup failure keeps the request out of ready_for_review", async () => {
      const store = storeForLead();
      const checker: CheckerGateway = {
        ...movableChecker(SHA),
        async head() {
          throw new Error("head_lookup_500");
        },
      };
      const deps = depsFor(store, { checker, checkerConfigured: true });
      const auth = await store.authenticate(hashBotToken(TOKEN));
      const opened = await openWith(deps, auth, { pullRequest: "27" });
      const requestId = String(opened.structuredContent.requestId);
      await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA });
      expect((await store.getRequest(requestId))?.status).toBe("verifying");
    });
  });

  describe("5. a bot-chosen binding must be an open PR or a branch in the request's repo", () => {
    async function unbound(checker: CheckerGateway) {
      const store = storeForLead();
      const deps = depsFor(store, { checker, checkerConfigured: true });
      const auth = await store.authenticate(hashBotToken(TOKEN));
      const opened = await openWith(deps, auth, {});
      return { store, deps, auth, requestId: String(opened.structuredContent.requestId) };
    }

    it("binds an open PR in the request's repo after verifying it", async () => {
      const calls: Record<string, unknown>[] = [];
      const checker = movableChecker(SHA, null, calls);
      const { store, deps, auth, requestId } = await unbound(checker);
      const checks = await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA, pullRequest: "27" });
      expect(checks.structuredContent).toMatchObject({ status: "ready", requestStatus: "ready_for_review" });
      expect(calls).toEqual([{ repo: "owner/demo", pullRequest: "27", branch: null }]);
      expect((await store.getRequest(requestId))?.pullRequest).toBe("27");
    });

    it("refuses a PR or branch that is not in the request's repo", async () => {
      for (const binding of [{ pullRequest: "404" }, { branch: "elsewhere" }]) {
        const checker = movableChecker(SHA, { exists: false, open: false, head: null });
        const { store, deps, auth, requestId } = await unbound(checker);
        const checks = await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA, ...binding });
        expect(checks.structuredContent).toMatchObject({ status: "refused", reason: "binding_not_in_repo" });
        const row = await store.getRequest(requestId);
        expect(row?.pullRequest ?? null).toBeNull();
        expect(row?.branch ?? null).toBeNull();
        expect(row?.checkRun ?? null).toBeNull();
        expect(checker.dispatches).toBe(0);
      }
    });

    it("refuses a closed PR", async () => {
      const checker = movableChecker(SHA, { exists: true, open: false, head: SHA });
      const { store, deps, auth, requestId } = await unbound(checker);
      const checks = await callConnectorTool(deps, auth, "request_checks", { requestId, repo: "owner/demo", sha: SHA, pullRequest: "26" });
      expect(checks.structuredContent).toMatchObject({ status: "refused", reason: "binding_pr_not_open" });
      expect((await store.getRequest(requestId))?.pullRequest ?? null).toBeNull();
    });

    it("fails closed when the binding cannot be verified", async () => {
      const failing = movableChecker(SHA, new Error("timeout"));
      const first = await unbound(failing);
      const lookup = await callConnectorTool(first.deps, first.auth, "request_checks", {
        requestId: first.requestId,
        repo: "owner/demo",
        sha: SHA,
        branch: "feature/x",
      });
      expect(lookup.structuredContent).toMatchObject({ status: "refused", reason: "binding_lookup_failed" });
      const noLookup: CheckerGateway = { ...movableChecker(SHA), bindingState: undefined };
      const second = await unbound(noLookup);
      const missing = await callConnectorTool(second.deps, second.auth, "request_checks", {
        requestId: second.requestId,
        repo: "owner/demo",
        sha: SHA,
        branch: "feature/x",
      });
      expect(missing.structuredContent).toMatchObject({ status: "refused", reason: "binding_unverifiable" });
    });

    it("the GitHub gateway checks PR state, the PR's base repo, and branch existence", async () => {
      const urls: string[] = [];
      const checker = createGhChecker({
        token: "unit-token",
        hostRepo: "owner/workers",
        apiBase: "https://example.test",
        fetchImpl: (async (url: string) => {
          urls.push(String(url));
          const u = String(url);
          if (u.endsWith("/pulls/27")) {
            return new Response(JSON.stringify({ state: "open", head: { sha: SHA }, base: { repo: { full_name: "Owner/Demo" } } }), { status: 200 });
          }
          if (u.endsWith("/pulls/26")) {
            return new Response(JSON.stringify({ state: "closed", head: { sha: SHA }, base: { repo: { full_name: "owner/demo" } } }), { status: 200 });
          }
          if (u.endsWith("/pulls/25")) {
            return new Response(JSON.stringify({ state: "open", head: { sha: SHA }, base: { repo: { full_name: "other/repo" } } }), { status: 200 });
          }
          if (u.endsWith("/git/ref/heads/feature/x")) {
            return new Response(JSON.stringify({ ref: "refs/heads/feature/x", object: { sha: HEAD_SHA } }), { status: 200 });
          }
          if (u.endsWith("/pulls/500")) return new Response("{}", { status: 500 });
          return new Response("{}", { status: 404 });
        }) as typeof fetch,
      });
      expect(await checker.bindingState?.({ repo: "owner/demo", pullRequest: "27", branch: null })).toEqual({ exists: true, open: true, head: SHA });
      expect(await checker.bindingState?.({ repo: "owner/demo", pullRequest: "26", branch: null })).toEqual({ exists: true, open: false, head: SHA });
      expect(await checker.bindingState?.({ repo: "owner/demo", pullRequest: "25", branch: null })).toMatchObject({ exists: false });
      expect(await checker.bindingState?.({ repo: "owner/demo", pullRequest: "404", branch: null })).toMatchObject({ exists: false });
      expect(await checker.bindingState?.({ repo: "owner/demo", pullRequest: null, branch: "feature/x" })).toEqual({ exists: true, open: true, head: HEAD_SHA });
      expect(await checker.bindingState?.({ repo: "owner/demo", pullRequest: null, branch: "gone" })).toMatchObject({ exists: false });
      await expect(checker.bindingState?.({ repo: "owner/demo", pullRequest: "500", branch: null })).rejects.toThrow("binding_lookup_500");
      await expect(checker.bindingState?.({ repo: "owner/demo", pullRequest: "27", branch: "feature/x" })).rejects.toThrow("binding_ambiguous");
    });
  });
});
