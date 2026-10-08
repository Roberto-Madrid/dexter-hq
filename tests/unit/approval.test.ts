import { describe, expect, it } from "vitest";
import { decideApproval, deployWithHqCredentials } from "../../hq/approval.ts";
import {
  callConnectorTool,
  createDefaultConnectorDeps,
  createMemoryConnectorStore,
  hashBotToken,
  loadConnectorSheetText,
} from "../../hq/connector.ts";
import { parseRoleSheet } from "../../kernel/role-sheet.ts";
import type { CheckerGateway } from "../../hq/checker.ts";

const OWNER = "11111111-1111-4111-8111-111111111111";
const BOT = "22222222-2222-4222-8222-222222222222";
const TOKEN = "unit-approval-token";
const NOW = "2026-10-04T23:00:00.000Z";

function storeWithLead() {
  return createMemoryConnectorStore({
    bots: [
      {
        id: BOT,
        ownerId: OWNER,
        name: "unit-lead",
        kind: "lead",
        repos: ["owner/demo"],
        tools: ["request_approval", "approval_status", "heartbeat"],
        currentTask: null,
        heartbeatAt: null,
      },
    ],
    tokens: [
      {
        tokenHash: hashBotToken(TOKEN),
        botId: BOT,
        scopes: ["request_approval", "approval_status", "heartbeat"],
      },
    ],
  });
}

const SHA = "dddddddddddddddddddddddddddddddddddddddd";

// Token police: a deploy approval needs a request whose pinned Checker run passed on the PR head.
const headOnly: CheckerGateway = {
  async dispatch() {
    throw new Error("unused");
  },
  async find() {
    return null;
  },
  async outcome() {
    throw new Error("unused");
  },
  async head() {
    return SHA;
  },
};

async function seedPassingRequest(store: ReturnType<typeof storeWithLead>) {
  await store.saveRequest({
    id: "req-deploy",
    ownerId: OWNER,
    goal: "Ship the preview.",
    status: "ready_for_review",
    card: { crew: "change", newScreen: false, requiresDesignApproval: false },
    evidence: [],
    assignedBotId: BOT,
    repo: "owner/demo",
    notices: [],
    pullRequest: "7",
    branch: null,
    checkRun: { nonce: "n-1", githubRunId: "1", sha: SHA, repo: "owner/demo", hostRepo: "owner/workers", dispatchedAt: NOW, passed: true },
  });
}

function depsFor(store: ReturnType<typeof storeWithLead>) {
  return createDefaultConnectorDeps({
    store,
    sheet: parseRoleSheet(loadConnectorSheetText()),
    cursor: null,
    cursorConfigured: false,
    checker: headOnly,
    checkerConfigured: true,
    ownerId: OWNER,
    now: () => NOW,
  });
}

describe("Needs you approval", () => {
  it("records a tower approve, writes the event log, and does not pretend a deploy ran without a credential", async () => {
    const store = storeWithLead();
    const deps = depsFor(store);
    const auth = await store.authenticate(hashBotToken(TOKEN));
    await seedPassingRequest(store);
    const requested = await callConnectorTool(deps, auth, "request_approval", { action: "deploy", target: "preview", requestId: "req-deploy" });
    const approvalId = String(requested.structuredContent.approvalId);
    expect(requested.structuredContent.status).toBe("pending");

    let deployCalls = 0;
    const first = await decideApproval(store, {
      approvalId,
      decision: "approved",
      now: () => NOW,
      env: {},
      deploy: async () => {
        deployCalls += 1;
        return { status: "ok", ran: true, deploymentId: "should-not-run" };
      },
    });
    expect(first.status).toBe("approved");
    expect(first.ran).toBe(false);
    expect(first.execution).toEqual({ status: "not_configured", reason: "missing_credential", ran: false });
    expect(deployCalls).toBe(0);

    const status = await callConnectorTool(deps, auth, "approval_status", { approvalId });
    expect(status.structuredContent.status).toBe("approved");
    expect(status.isError).toBe(false);

    const second = await decideApproval(store, {
      approvalId,
      decision: "approved",
      now: () => NOW,
      env: { VERCEL_TOKEN: "present" },
      deploy: async () => {
        deployCalls += 1;
        return { status: "ok", ran: true, deploymentId: "dpl_second" };
      },
    });
    expect(second.status).toBe("approved");
    expect(second.ran).toBe(false);
    expect(second.reason).toBe("already_decided");
    expect(deployCalls).toBe(0);

    const events = await store.listEvents();
    const decisions = events.filter((event) => event.action === "approval" && event.target === approvalId);
    const executes = events.filter((event) => event.action === "approval_execute" && event.target === approvalId);
    expect(decisions.some((event) => event.result?.status === "approved")).toBe(true);
    expect(executes).toHaveLength(1);
    expect(executes[0]?.result).toMatchObject({ status: "not_configured", reason: "missing_credential", ran: false });
    expect(JSON.stringify(events)).not.toContain("should-not-run");
  });

  it("records a deny, leaves it denied, and never runs deploy", async () => {
    const store = storeWithLead();
    const deps = depsFor(store);
    const auth = await store.authenticate(hashBotToken(TOKEN));
    await store.saveApproval({
      id: "appr-deny",
      ownerId: OWNER,
      action: "deploy",
      target: "preview",
      status: "pending",
      requestId: null,
    });
    let deployCalls = 0;
    const denied = await decideApproval(store, {
      approvalId: "appr-deny",
      decision: "denied",
      env: { VERCEL_TOKEN: "present" },
      deploy: async () => {
        deployCalls += 1;
        return { status: "ok", ran: true, deploymentId: "dpl_denied" };
      },
    });
    expect(denied).toEqual({ status: "denied", approvalId: "appr-deny", action: "deploy", ran: false });
    expect(deployCalls).toBe(0);

    const again = await decideApproval(store, {
      approvalId: "appr-deny",
      decision: "approved",
      env: { VERCEL_TOKEN: "present" },
      deploy: async () => {
        deployCalls += 1;
        return { status: "ok", ran: true, deploymentId: "dpl_denied" };
      },
    });
    expect(again.status).toBe("denied");
    expect(again.reason).toBe("already_decided");
    expect(again.ran).toBe(false);
    expect(deployCalls).toBe(0);

    const status = await callConnectorTool(deps, auth, "approval_status", { approvalId: "appr-deny" });
    expect(status.structuredContent.status).toBe("denied");
    const executes = (await store.listEvents()).filter((event) => event.action === "approval_execute");
    expect(executes).toHaveLength(0);
  });

  it("runs deploy once when HQ has a credential and the API returns an id", async () => {
    const store = storeWithLead();
    await store.saveApproval({
      id: "appr-run",
      ownerId: OWNER,
      action: "deploy",
      target: "preview",
      status: "pending",
      requestId: null,
    });
    let deployCalls = 0;
    const result = await decideApproval(store, {
      approvalId: "appr-run",
      decision: "approved",
      env: { VERCEL_TOKEN: "present" },
      deploy: async (input) => {
        deployCalls += 1;
        expect(input.target).toBe("preview");
        expect(input.token).toBe("present");
        return { status: "ok", ran: true, deploymentId: "dpl_ok" };
      },
    });
    expect(result.status).toBe("approved");
    expect(result.ran).toBe(true);
    expect(result.execution).toEqual({ status: "ok", ran: true, deploymentId: "dpl_ok" });

    const replay = await decideApproval(store, {
      approvalId: "appr-run",
      decision: "approved",
      env: { VERCEL_TOKEN: "present" },
      deploy: async () => {
        deployCalls += 1;
        return { status: "ok", ran: true, deploymentId: "dpl_ok" };
      },
    });
    expect(replay.ran).toBe(false);
    expect(deployCalls).toBe(1);
  });

  it("does not treat a token-backed deploy as success without a deployment id", async () => {
    const attempt = await deployWithHqCredentials(
      { target: "preview", token: "present" },
      async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    );
    expect(attempt).toEqual({ status: "error", reason: "deploy_incomplete", ran: false });
  });

  it("keeps approval_status available while STOP ALL is on", async () => {
    const store = storeWithLead();
    const deps = depsFor(store);
    const auth = await store.authenticate(hashBotToken(TOKEN));
    await store.saveApproval({
      id: "appr-stop",
      ownerId: OWNER,
      action: "deploy",
      target: "preview",
      status: "approved",
      requestId: null,
    });
    await store.setStopped(true);
    const blocked = await callConnectorTool(deps, auth, "request_approval", { action: "deploy", target: "preview" });
    expect(blocked.structuredContent.status).toBe("stopped");
    const status = await callConnectorTool(deps, auth, "approval_status", { approvalId: "appr-stop" });
    expect(status.structuredContent.status).toBe("approved");
    expect(status.isError).toBe(false);
  });
});
