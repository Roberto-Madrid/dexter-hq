import type { ConnectorApproval, ConnectorStore } from "./connector-store.ts";
import { UPGRADE_APPROVAL_ACTIONS, executeUpgradeApproval } from "./upgrade-check.ts";

export type ApprovalDecision = "approved" | "denied";

export type DeployAttempt = {
  status: "ok" | "not_configured" | "error";
  reason?: string;
  ran: boolean;
  deploymentId?: string;
};

export type DecideApprovalResult = {
  status: "approved" | "denied" | "unknown";
  approvalId?: string;
  action?: string;
  ran: boolean;
  reason?: string;
  execution?: DeployAttempt;
};

type DeployFn = (input: { target: string; token: string }) => Promise<DeployAttempt>;

function readDeploymentId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.uid === "string" && record.uid) return record.uid;
  if (typeof record.id === "string" && record.id) return record.id;
  return null;
}

export async function deployWithHqCredentials(
  input: { target: string; token: string },
  fetchImpl: typeof fetch = fetch,
): Promise<DeployAttempt> {
  const response = await fetchImpl("https://api.vercel.com/v13/deployments", {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: input.target || "preview",
      target: "preview",
    }),
  });
  if (!response.ok) {
    return { status: "error", reason: "deploy_rejected", ran: false };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { status: "error", reason: "deploy_incomplete", ran: false };
  }
  const deploymentId = readDeploymentId(payload);
  if (!deploymentId) return { status: "error", reason: "deploy_incomplete", ran: false };
  return { status: "ok", ran: true, deploymentId };
}

function tokenFrom(env: Record<string, string | undefined> | NodeJS.ProcessEnv): string {
  const value = env.VERCEL_TOKEN;
  return typeof value === "string" ? value.trim() : "";
}

async function executeApproved(
  row: ConnectorApproval,
  env: Record<string, string | undefined> | NodeJS.ProcessEnv,
  deploy: DeployFn | undefined,
): Promise<DeployAttempt> {
  if (row.action !== "deploy") {
    return { status: "error", reason: "no_executor", ran: false };
  }
  const token = tokenFrom(env);
  if (!token) {
    return { status: "not_configured", reason: "missing_credential", ran: false };
  }
  const fn = deploy ?? deployWithHqCredentials;
  try {
    return await fn({ target: row.target, token });
  } catch {
    return { status: "error", reason: "deploy_failed", ran: false };
  }
}

async function runUpgradeApproval(store: ConnectorStore, row: ConnectorApproval, at: string): Promise<DeployAttempt> {
  try {
    return await executeUpgradeApproval(store, row, at);
  } catch {
    return { status: "error", reason: "upgrade_failed", ran: false };
  }
}

export async function decideApproval(
  store: ConnectorStore,
  input: {
    approvalId: string;
    decision: ApprovalDecision;
    now?: () => string;
    env?: Record<string, string | undefined> | NodeJS.ProcessEnv;
    deploy?: DeployFn;
  },
): Promise<DecideApprovalResult> {
  const at = (input.now ?? (() => new Date().toISOString()))();
  const claimed = await store.claimApproval(input.approvalId, input.decision);
  if (!claimed.row) {
    return { status: "unknown", ran: false, reason: "unknown_approval" };
  }
  const row = claimed.row;
  if (!claimed.claimed) {
    await store.appendEvent({
      ownerId: row.ownerId,
      actor: "owner",
      action: "approval",
      target: row.id,
      result: { status: row.status, reason: "already_decided", ran: false },
      at,
    });
    if (row.status === "pending") {
      return { status: "unknown", approvalId: row.id, action: row.action, ran: false, reason: "not_claimed" };
    }
    return {
      status: row.status,
      approvalId: row.id,
      action: row.action,
      ran: false,
      reason: "already_decided",
    };
  }
  await store.appendEvent({
    ownerId: row.ownerId,
    actor: "owner",
    action: "approval",
    target: row.id,
    result: { status: row.status, action: row.action, target: row.target },
    at,
  });
  if (input.decision === "denied") {
    return { status: "denied", approvalId: row.id, action: row.action, ran: false };
  }
  // model_upgrade starts the upgrade check; upgrade_rollback and council_upgrade switch the pin (hq/upgrade-check.ts).
  const upgrade = UPGRADE_APPROVAL_ACTIONS.has(row.action);
  const execution =
    row.action === "deploy"
      ? await executeApproved(row, input.env ?? {}, input.deploy)
      : upgrade
        ? await runUpgradeApproval(store, row, at)
        : { status: "ok" as const, ran: false };
  if (row.action === "design" || row.action === "design_gate") {
    if (row.requestId) {
      const request = await store.getRequest(row.requestId);
      if (request && request.status === "needs_you" && request.card?.requiresApproval !== true) {
        request.status = "queued";
        await store.saveRequest(request);
      }
    }
  }
  if (row.action === "deploy" || upgrade) {
    await store.appendEvent({
      ownerId: row.ownerId,
      actor: "owner",
      action: "approval_execute",
      target: row.id,
      result: {
        status: execution.status,
        reason: execution.reason ?? null,
        ran: execution.ran,
        deploymentId: execution.deploymentId ?? null,
      },
      at,
    });
  } else {
    await store.appendEvent({
      ownerId: row.ownerId,
      actor: "owner",
      action: "approval",
      target: row.requestId ?? row.id,
      result: { status: "approved", action: row.action, requestId: row.requestId },
      at,
    });
  }
  return {
    status: "approved",
    approvalId: row.id,
    action: row.action,
    ran: execution.ran,
    execution,
  };
}
