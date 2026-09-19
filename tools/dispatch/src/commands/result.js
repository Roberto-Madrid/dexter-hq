import { Kind } from '../errors.js';
import { mapRunStatus } from '../states.js';
import { resolveTarget } from './status.js';

/**
 * Terminal-run payload: final reply text, duration, pushed branches, and
 * artifact references. A non-terminal run returns `ok: false` with the live
 * state rather than an empty result.
 */
export async function result(ctx, options) {
  const target = resolveTarget(ctx, options);
  const { body: agent } = await ctx.api.getAgent(target.agentId);
  const runId = target.runId ?? agent?.latestRunId ?? null;

  if (!runId) {
    return { command: 'result', ok: false, reason: 'no_run', agentId: target.agentId, runState: mapRunStatus(null) };
  }

  const { body: run } = await ctx.api.getRun(target.agentId, runId);
  const runState = mapRunStatus(run?.status);

  let artifacts = { available: false, reason: null, items: [] };
  try {
    const res = await ctx.api.listArtifacts(target.agentId);
    artifacts = { available: true, reason: null, items: res.body?.items ?? [] };
  } catch (err) {
    if (err.kind === Kind.NOT_FOUND || err.kind === Kind.TRANSIENT || err.kind === Kind.RATE_LIMIT) {
      artifacts = { available: false, reason: err.kind, items: [] };
    } else {
      throw err;
    }
  }

  return {
    command: 'result',
    ok: runState.terminal,
    agentId: target.agentId,
    agentUrl: agent?.url ?? null,
    runId,
    runState,
    durationMs: run?.durationMs ?? null,
    resultText: runState.terminal ? (run?.result ?? null) : null,
    // Per the live docs, git state is per-agent, not per-run. Observed live:
    // an entry appears for the branch name assigned to the agent even when the
    // agent pushed nothing, so a non-empty list is not evidence of a push.
    branches: run?.git?.branches ?? [],
    branchScope: 'agent',
    branchesMeaning: 'branch name assigned to the agent; presence does not confirm the branch was pushed — verify against the remote',
    artifacts,
    note: runState.terminal ? null : `Run is ${runState.state}; no final result exists yet.`,
  };
}
