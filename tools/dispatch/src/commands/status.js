import { Kind, ValidationError } from '../errors.js';
import { mapAgentStatus, mapRunStatus } from '../states.js';

/** Resolves an agent/run pair from a durable task record or explicit ids. */
export function resolveTarget(ctx, { taskId, agentId, runId }) {
  if (agentId) return { agentId, runId: runId ?? null, record: taskId ? ctx.store.get(taskId) : null };
  if (!taskId) throw new ValidationError('Provide --task-id (preferred) or --agent-id.');
  const record = ctx.store.get(taskId);
  if (!record) {
    throw new ValidationError(
      `No durable record for task "${taskId}" under "${ctx.store.recordsDir}". Run "recover" to list known tasks.`,
    );
  }
  if (!record.agentId) {
    throw new ValidationError(
      `Task "${taskId}" has no agent id yet (record state "${record.state}"). ` +
        `If the state is "ambiguous", run "recover --refresh --task-id ${taskId}" to reconcile before acting.`,
    );
  }
  return { agentId: record.agentId, runId: runId ?? record.runId ?? null, record };
}

async function readOnce(ctx, agentId, runId, { includeArtifacts }) {
  const { body: agent } = await ctx.api.getAgent(agentId);
  const targetRunId = runId ?? agent?.latestRunId ?? null;

  let run = null;
  if (targetRunId) {
    const res = await ctx.api.getRun(agentId, targetRunId);
    run = res.body ?? null;
  }

  let artifacts = { available: false, reason: 'not_requested', items: [] };
  if (includeArtifacts) {
    try {
      const res = await ctx.api.listArtifacts(agentId);
      artifacts = { available: true, reason: null, items: res.body?.items ?? [] };
    } catch (err) {
      if (err.kind === Kind.NOT_FOUND || err.kind === Kind.TRANSIENT) {
        artifacts = { available: false, reason: err.kind, items: [] };
      } else {
        throw err;
      }
    }
  }

  return {
    agent: {
      id: agent?.id ?? agentId,
      name: agent?.name ?? null,
      url: agent?.url ?? null,
      status: mapAgentStatus(agent?.status),
      repos: agent?.repos ?? [],
      autoCreatePR: agent?.autoCreatePR ?? null,
      latestRunId: agent?.latestRunId ?? null,
    },
    run: run
      ? {
          id: run.id,
          status: mapRunStatus(run.status),
          createdAt: run.createdAt ?? null,
          updatedAt: run.updatedAt ?? null,
          durationMs: run.durationMs ?? null,
          branches: run.git?.branches ?? [],
        }
      : null,
    artifacts,
  };
}

/**
 * Bounded polling: exponential backoff, hard timeout, and a resume record
 * written to the durable store so a later process can pick the task back up.
 */
export async function status(ctx, options) {
  const { taskId, agentId: explicitAgentId, runId: explicitRunId, wait = false, includeArtifacts = false } = options;
  const target = resolveTarget(ctx, { taskId, agentId: explicitAgentId, runId: explicitRunId });

  const nowFn = options.now ?? ctx.now ?? (() => Date.now());
  const started = nowFn();
  const hardTimeoutMs = options.pollTimeoutMs ?? ctx.policy.pollTimeoutMs;
  const sleep = options.sleep ?? ctx.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  let attempt = 0;
  let snapshot = await readOnce(ctx, target.agentId, target.runId, { includeArtifacts });

  while (wait && snapshot.run && !snapshot.run.status.terminal) {
    const elapsed = nowFn() - started;
    if (elapsed >= hardTimeoutMs) {
      persistResume(ctx, target, snapshot, { reason: 'poll_timeout', elapsedMs: elapsed });
      return {
        command: 'status',
        ok: false,
        timedOut: true,
        message: `Polling stopped after ${elapsed}ms without a terminal run state. A resume record was written; the run is still ${snapshot.run.status.state}.`,
        taskId: taskId ?? null,
        ...snapshot,
      };
    }
    const delay = Math.min(ctx.http.backoff(attempt, null), hardTimeoutMs - elapsed);
    await sleep(delay);
    attempt += 1;
    snapshot = await readOnce(ctx, target.agentId, target.runId, { includeArtifacts });
  }

  persistResume(ctx, target, snapshot, { reason: 'observed' });

  return { command: 'status', ok: true, timedOut: false, taskId: taskId ?? null, polls: attempt + 1, ...snapshot };
}

function persistResume(ctx, target, snapshot, meta) {
  if (!target.record?.taskId) return;
  try {
    ctx.store.update(
      target.record.taskId,
      {
        agentId: snapshot.agent.id,
        runId: snapshot.run?.id ?? target.record.runId ?? null,
        lastKnownRunStatus: snapshot.run?.status.raw ?? null,
        lastKnownRunState: snapshot.run?.status.state ?? 'unknown',
        resume: { at: new Date().toISOString(), ...meta },
      },
      'status_observed',
    );
  } catch (err) {
    ctx.logger?.warn?.(`could not persist resume record: ${err.message}`);
  }
}
