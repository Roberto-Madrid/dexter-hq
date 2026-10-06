import { describe, expect, it } from "vitest";
import { assembleTower } from "../../app/(hq)/tower-model.ts";
import { decideApproval } from "../../hq/approval.ts";
import {
  PINNED_CHECKER_WORKFLOW,
  applyCheckEvidence,
  checksMoveRequestReady,
  createGhChecker,
  evidenceFromOutcome,
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
import { composeLaunchBrief } from "../../hq/personas.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import type { PlanCard } from "../../kernel/types.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const TOKEN = "unit-quality-token";
const NOW = "2026-10-06T05:00:00.000Z";

const SCOPES = [
  "whoami",
  "open_request",
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
    ],
    tokens: [{ tokenHash: hashBotToken(TOKEN), botId: BOT, scopes: SCOPES }],
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
        runId: input.runId,
        sha: input.sha ?? "abc1234deadbeef",
        url: "https://example.test/actions",
        workflow: PINNED_CHECKER_WORKFLOW,
      };
    },
    async outcome() {
      return {
        state: "completed",
        conclusion: "success",
        evidence: ["checker:build:pass", "checker:lint:pass", "checker:playwright:pass"],
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
      branch: "main",
      sha: "abc1234deadbeef",
      runId: "check-1",
    });
    expect(checks.isError).toBe(false);
    expect(checks.structuredContent).toMatchObject({
      status: "ready",
      ready: true,
      workflow: "checker.yml",
      requestStatus: "ready_for_review",
    });
    expect(JSON.stringify(checks.structuredContent.evidence)).toContain("checker:sha:abc1234deadbeef");
    expect(JSON.stringify(checks.structuredContent.evidence)).toContain("playwright");
    const request = await store.getRequest(requestId);
    expect(request?.status).toBe("ready_for_review");
    expect(request?.evidence.some((item) => item.includes("checker.yml"))).toBe(true);
  });

  it("does not claim ready when the checker is not configured", async () => {
    const store = storeForLead();
    const deps = depsFor(store, { checker: null, checkerConfigured: false });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const opened = await callConnectorTool(deps, auth, "open_request", {
      goal: "Ship the checker",
      repo: "owner/demo",
      card: card(),
    });
    const checks = await callConnectorTool(deps, auth, "request_checks", {
      requestId: opened.structuredContent.requestId,
      repo: "owner/demo",
      branch: "main",
    });
    expect(checks.structuredContent.status).toBe("not-configured");
    expect(checks.structuredContent.ready).toBe(false);
    expect(checks.isError).toBe(true);
  });

  it("pins the checker workflow name on dispatch", async () => {
    const calls: { url: string; body: string }[] = [];
    const checker = createGhChecker({
      token: "unit-token",
      apiBase: "https://example.test",
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, body: String(init?.body ?? "") });
        if (url.includes("/dispatches")) return new Response(null, { status: 204 });
        return Response.json({
          workflow_runs: [
            { name: "checker-run-9", status: "completed", conclusion: "success", id: 9, html_url: "https://example.test/9" },
          ],
        });
      },
    });
    await checker.dispatch({ repo: "owner/workers", ref: "main", runId: "run-9" });
    expect(calls[0]?.url).toContain(`/actions/workflows/${PINNED_CHECKER_WORKFLOW}/dispatches`);
    expect(JSON.parse(calls[0]?.body ?? "{}").inputs.run_id).toBe("run-9");
    const outcome = await checker.outcome({ repo: "owner/workers", runId: "run-9" });
    expect(checksMoveRequestReady(outcome)).toBe(true);
  });

  it("refuses launch_agent until design approval, then allows it", async () => {
    const store = storeForLead();
    const briefs: string[] = [];
    const deps = depsFor(store, {
      cursorConfigured: true,
      cursor: {
        async start(spec) {
          briefs.push(spec.brief ?? "");
          return { id: "agent-1", runtime: "cursor-cloud" };
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
      },
    });
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

  it("injects the matching persona into the launched brief", async () => {
    const store = storeForLead();
    let captured = "";
    const deps = depsFor(store, {
      cursorConfigured: true,
      cursor: {
        async start(spec) {
          captured = spec.brief ?? "";
          return { id: "agent-qa", runtime: "cursor-cloud" };
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
      },
    });
    const auth = await store.authenticate(hashBotToken(TOKEN));
    const result = await callConnectorTool(deps, auth, "launch_agent", {
      repo: "owner/demo",
      role: "qa_visual",
      brief: "Run the definition of done.",
      idempotencyKey: "persona-1",
    });
    expect(result.structuredContent.persona).toBe("qa");
    expect(captured.startsWith("Persona contract (qa):")).toBe(true);
    expect(captured).toContain("Brief:\nRun the definition of done.");
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
      branch: "main",
      sha: "deadbeef",
      runId: "trail-check",
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
        bots: [{ id: BOT, ownerId: OWNER, name: "unit-lead", kind: "lead", repos: ["owner/demo"], tools: SCOPES, currentTask: null, heartbeatAt: NOW }],
        requests: [(await store.getRequest(requestId))!],
        events,
        approvals: [],
        agents: [],
      },
    });
    expect(snapshot.requests.items[0]?.trail.some((entry) => entry.action === "request_checks")).toBe(true);
  });

  it("keeps failed checks from marking the request ready", () => {
    const outcome = { state: "completed" as const, conclusion: "failure" as const, evidence: ["checker:build:fail"] };
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
        sha: "s",
        repo: "owner/demo",
        ref: "main",
        outcome,
      }),
      false,
    );
    expect(next.status).toBe("verifying");
  });
});
