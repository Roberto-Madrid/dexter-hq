import type { ConnectorApproval, ConnectorStore } from "./connector-store.ts";

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
  const execution = await executeApproved(row, input.env ?? {}, input.deploy);
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
  return {
    status: "approved",
    approvalId: row.id,
    action: row.action,
    ran: execution.ran,
    execution,
  };
}
