import { Kind } from './errors.js';
import { RecordState } from './store.js';

/** Display name carries the client task id so an ambiguous create is findable. */
export function buildAgentName(missionId, taskId) {
  return `${missionId} [task:${taskId}]`.slice(0, 100);
}

export function agentNameMatchesTask(name, taskId) {
  return typeof name === 'string' && name.includes(`[task:${taskId}]`);
}

/**
 * True for an agent this client dispatched. The marker is the only signal the
 * API exposes for provenance — `GET /v1/agents` returns every agent the key's
 * owner has, including their own interactive sessions and unrelated projects.
 */
export function isDispatchAgentName(name) {
  return typeof name === 'string' && /\[task:[^\]]+\]/.test(name);
}

/**
 * Resolves an ambiguous POST /v1/agents outcome using supported lookups only.
 * Never re-POSTs: a blind retry can create a duplicate worker.
 *
 * Lookup order:
 *   1. GET /v1/agents/{clientAgentId} — the id we supplied on create.
 *   2. GET /v1/agents (paged) matching the task marker in the agent name.
 */
export async function reconcileCreate(ctx, record, { maxPages = 5 } = {}) {
  const { clientAgentId, taskId } = record;

  try {
    const { body } = await ctx.api.getAgent(clientAgentId);
    if (body?.id) {
      return { found: true, via: 'get_agent_by_client_id', agent: body };
    }
  } catch (err) {
    if (err.kind !== Kind.NOT_FOUND) throw err;
  }

  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const { body } = await ctx.api.listAgents({ limit: 100, cursor });
    const items = Array.isArray(body?.items) ? body.items : [];
    const hit = items.find((a) => a.id === clientAgentId || agentNameMatchesTask(a.name, taskId));
    if (hit) return { found: true, via: 'list_agents_task_marker', agent: hit };
    cursor = body?.nextCursor;
    if (!cursor) break;
  }

  return { found: false, via: 'exhausted_lookup', agent: null };
}

/** Applies a reconciliation outcome to the durable record. */
export async function reconcileAndPersist(ctx, record) {
  const outcome = await reconcileCreate(ctx, record);
  if (outcome.found) {
    const agent = outcome.agent;
    const stored = ctx.store.update(
      record.taskId,
      {
        state: RecordState.RECONCILED,
        agentId: agent.id,
        runId: agent.latestRunId ?? record.runId ?? null,
        agentUrl: agent.url ?? null,
        reconciledVia: outcome.via,
      },
      'create_reconciled',
    );
    return { reconciled: true, via: outcome.via, record: stored };
  }
  const stored = ctx.store.update(
    record.taskId,
    { state: RecordState.NOT_CREATED, reconciledVia: outcome.via },
    'create_not_found',
  );
  return { reconciled: false, via: outcome.via, record: stored };
}
