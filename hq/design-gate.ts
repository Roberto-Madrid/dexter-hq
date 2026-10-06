import type { ConnectorAuth, ConnectorStore } from "./connector-store.ts";

export const DESIGN_SKETCH_ROLES = new Set(["designer"]);

export function briefRequiresDesignApproval(brief: string, args: Record<string, unknown>): boolean {
  if (args.requiresDesignApproval === true || args.requires_design_approval === true) return true;
  return /\brequires design approval\b/i.test(brief);
}

export function requestRequiresDesign(card: Record<string, unknown> | null): boolean {
  if (!card) return false;
  return card.requiresDesignApproval === true || card.newScreen === true;
}

export async function designApprovalGranted(
  store: ConnectorStore,
  input: { requestId: string; approvalId: string | null },
): Promise<boolean> {
  if (input.approvalId) {
    const row = await store.getApproval(input.approvalId);
    if (
      row?.status === "approved" &&
      (row.action === "design" || row.action === "design_gate") &&
      row.requestId === input.requestId
    ) {
      return true;
    }
  }
  const rows = await store.listApprovals();
  return rows.some(
    (row) =>
      row.requestId === input.requestId &&
      row.status === "approved" &&
      (row.action === "design" || row.action === "design_gate"),
  );
}

export async function launchBlockedByDesignGate(
  store: ConnectorStore,
  _auth: ConnectorAuth,
  input: {
    role: string;
    brief: string;
    args: Record<string, unknown>;
    requestId: string | null;
    approvalId: string | null;
  },
): Promise<{ blocked: boolean; reason: string | null }> {
  if (DESIGN_SKETCH_ROLES.has(input.role)) return { blocked: false, reason: null };
  if (!input.requestId) return { blocked: true, reason: "request_required" };
  const request = await store.getRequest(input.requestId);
  if (!request) return { blocked: true, reason: "unknown_request" };
  if (request.assignedBotId && request.assignedBotId !== _auth.id) {
    return { blocked: true, reason: "not_own_request" };
  }
  const needed =
    requestRequiresDesign(request.card) || briefRequiresDesignApproval(input.brief, input.args);
  if (!needed) return { blocked: false, reason: null };
  const granted = await designApprovalGranted(store, {
    requestId: request.id,
    approvalId: input.approvalId,
  });
  if (granted) return { blocked: false, reason: null };
  return { blocked: true, reason: "design_approval_required" };
}
