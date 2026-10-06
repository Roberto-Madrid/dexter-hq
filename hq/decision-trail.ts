import type { ConnectorEvent } from "./connector-store.ts";

export const TRAIL_ACTIONS = new Set([
  "open_request",
  "assign",
  "launch_agent",
  "request_checks",
  "request_council",
  "request_approval",
  "approval",
  "approval_execute",
  "update_request",
]);

export type TrailEntry = {
  at: string;
  actor: string;
  action: string;
  summary: string;
};

function resultText(result: Record<string, unknown> | null): string {
  if (!result) return "";
  const reason = typeof result.reason === "string" ? result.reason : "";
  const status = typeof result.status === "string" ? result.status : "";
  const verdict = typeof result.result === "string" ? result.result : "";
  return [status, reason, verdict].filter(Boolean).join(" ");
}

export function eventTouchesRequest(event: ConnectorEvent, requestId: string): boolean {
  if (event.target === requestId) return true;
  const result = event.result ?? {};
  return result.requestId === requestId || result.approvalId === requestId;
}

export function trailSummary(event: ConnectorEvent): string {
  const extra = resultText(event.result);
  if (event.action === "request_checks") {
    const ready = event.result?.ready === true ? "ready" : "not ready";
    return extra ? `${event.actor} checks ${ready}: ${extra}` : `${event.actor} checks ${ready}`;
  }
  if (event.action === "request_council") {
    return extra ? `${event.actor} council ${extra}` : `${event.actor} asked the Council`;
  }
  if (event.action === "approval" || event.action === "approval_execute") {
    return extra ? `${event.actor} ${event.action} ${extra}` : `${event.actor} ${event.action}`;
  }
  if (event.action === "launch_agent") {
    return extra ? `${event.actor} launch ${extra}` : `${event.actor} launched an agent`;
  }
  return extra ? `${event.actor} ${event.action} ${extra}` : `${event.actor} ${event.action}`;
}

export function decisionTrail(events: ConnectorEvent[], requestId: string): TrailEntry[] {
  return events
    .filter((event) => TRAIL_ACTIONS.has(event.action) && eventTouchesRequest(event, requestId))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map((event) => ({
      at: event.at,
      actor: event.actor,
      action: event.action,
      summary: trailSummary(event),
    }));
}
