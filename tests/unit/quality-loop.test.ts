import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assembleTower } from "../../app/(hq)/tower-model.ts";
import { decideApproval } from "../../hq/approval.ts";
import {
  PINNED_CHECKER_PATH,
  PINNED_CHECKER_WORKFLOW,
  applyCheckEvidence,
  checkerRunName,
  checksMoveRequestReady,
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

const OWNER = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const TOKEN = "unit-quality-token";
const OTHER_TOKEN = "unit-other-token";
const NOW = "2026-10-06T05:00:00.000Z";
const SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const SCOPES = [
  "whoami",
  "open_request",
  "update_request",
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
    ],
    tokens: [
      { tokenHash: hashBotToken(TOKEN), botId: BOT, scopes: SCOPES },
      { tokenHash: hashBotToken(OTHER_TOKEN), botId: OTHER, scopes: SCOPES },
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

describe("Stage 2 quality loop", () => {
  it("runs pinned checks and moves the request to ready_for_review with evidence", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: passingChecker(), checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Ship the checker",
      repo: "owner/demo",
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
      { sha: SHA, repo: "owner/demo" },
    );
    expect(next.status).toBe("verifying");
  });

  it("builds and tests subject/ at the target sha, not the judge sample", () => {
    const workflow = readFileSync("workers/.github/workflows/checker.yml", "utf8");
    expect(workflow).toContain("working-directory: subject");
    expect(workflow).not.toContain("judge/checker-sample");
    expect(workflow).toContain("ref: ${{ inputs.target_sha }}");
    expect(workflow).toContain("path: subject");
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
    expect(planted.structuredContent.reason).toBe("ready_requires_checks");
    await callConnectorTool(deps, other, "update_request", {
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
    };
    const store = storeForLead();
    const deps = depsFor(store, { checker, checkerConfigured: true });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "New sha",
      repo: "owner/demo",
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
});
