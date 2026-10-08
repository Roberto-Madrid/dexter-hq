import { terminalAgentStatus } from "../adapters/cursor-cloud.ts";
import {
  ACTIVE_AGENT_STATUSES,
  isActiveAgent,
  runHandleFor,
  withoutFollowupClaim,
  type ConnectorAgent,
  type ConnectorStore,
} from "./connector-store.ts";
import type { ConnectorDeps } from "./connector.ts";

/** A `reserving` row older than this belongs to a launch that died before Cursor answered. */
export const STALE_RESERVATION_MS = 15 * 60 * 1000;

export type ReconcileResult = { configured: boolean; checked: number; closed: number; errors: number; released: number };

export { runHandleFor };

/**
 * Moves an active agent to its terminal status once. A second call, a cancel that won, or a follow-up that
 * replaced the run after `agent` was read changes nothing.
 */
export async function closeIfTerminal(
  store: ConnectorStore,
  agent: ConnectorAgent,
  run: { state: string; usage?: Record<string, unknown> },
  at: string,
): Promise<boolean> {
  const status = terminalAgentStatus(run.state);
  if (!status) return false;
  const usage = run.usage && Object.keys(run.usage).length > 0 ? { usage: run.usage } : {};
  const changed = await store.setAgentStatus({
    id: agent.id,
    from: ACTIVE_AGENT_STATUSES,
    status,
    result: { ...agent.result, finalState: run.state, ...usage },
    run: runHandleFor(agent),
  });
  if (changed) {
    await store.appendEvent({
      ownerId: agent.ownerId,
      actor: "hq",
      action: "agent_finished",
      target: agent.cursorHandle ?? agent.id,
      result: { status, state: run.state, repo: agent.repo, botId: agent.botId },
      at,
    });
  }
  return changed;
}

/**
 * Runs in the per-minute tick. Polls every active agent and closes the finished ones, so caps free up.
 * It only reads Cursor and writes terminal states, so it keeps running while STOP is on.
 */
export async function reconcileConnector(
  deps: Pick<ConnectorDeps, "store" | "cursor" | "cursorConfigured" | "now">,
): Promise<ReconcileResult> {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const agents = await deps.store.listAgents();
  let released = 0;
  for (const agent of agents) {
    if (agent.status !== "reserving") continue;
    const since = typeof agent.result?.reservedAt === "string" ? agent.result.reservedAt : agent.createdAt;
    if (!since || Date.parse(at) - Date.parse(since) < STALE_RESERVATION_MS) continue;
    // A launch that died never reached Cursor's answer: launch_failed. A follow-up that died goes back to where it was.
    // dexter-shortcut: a follow-up that died after Cursor accepted it goes back untracked; upgrade path: read the agent's latest run on Cursor before releasing.
    const from = typeof agent.result?.followupFrom === "string" ? agent.result.followupFrom : null;
    const moved = from
      ? await deps.store.setAgentStatus({ id: agent.id, from: ["reserving"], status: from, result: withoutFollowupClaim(agent.result) })
      : await deps.store.setAgentStatus({ id: agent.id, from: ["reserving"], status: "launch_failed" });
    if (moved) released += 1;
  }
  if (!deps.cursorConfigured || !deps.cursor) return { configured: false, checked: 0, closed: 0, errors: 0, released };
  let checked = 0;
  let closed = 0;
  let errors = 0;
  for (const agent of agents) {
    if (agent.status === "reserving" || !isActiveAgent(agent.status)) continue;
    const handle = runHandleFor(agent);
    if (!handle) continue;
    checked += 1;
    try {
      const run = await deps.cursor.status({ id: handle, runtime: "cursor-cloud" });
      if (await closeIfTerminal(deps.store, agent, run, at)) closed += 1;
    } catch {
      errors += 1;
    }
  }
  return { configured: true, checked, closed, errors, released };
}
