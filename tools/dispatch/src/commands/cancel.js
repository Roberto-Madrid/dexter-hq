import { Kind, ValidationError } from '../errors.js';
import { mapRunStatus } from '../states.js';
import { RecordState } from '../store.js';
import { resolveTarget } from './status.js';

/**
 * Cancels the active run of an owned agent. Cancellation is terminal; the
 * agent itself is left intact so the conversation can be continued later.
 */
export async function cancel(ctx, options) {
  const target = resolveTarget(ctx, options);
  const { body: agent } = await ctx.api.getAgent(target.agentId);
  const runId = target.runId ?? agent?.latestRunId ?? null;

  if (!runId) {
    throw new ValidationError(`Agent "${target.agentId}" has no run to cancel.`);
  }

  try {
    await ctx.api.cancelRun(target.agentId, runId);
  } catch (err) {
    if (err.kind === Kind.CONFLICT && err.code === 'run_not_cancellable') {
      const { body: run } = await ctx.api.getRun(target.agentId, runId);
      return {
        command: 'cancel',
        ok: false,
        cancelled: false,
        reason: 'run_not_cancellable',
        agentId: target.agentId,
        runId,
        runState: mapRunStatus(run?.status),
        message: 'Run is already terminal or was never active; nothing was cancelled.',
      };
    }
    throw err;
  }

  const { body: run } = await ctx.api.getRun(target.agentId, runId);
  const runState = mapRunStatus(run?.status);

  if (target.record?.taskId) {
    ctx.store.update(
      target.record.taskId,
      { state: RecordState.CLOSED, lastKnownRunStatus: run?.status ?? null, lastKnownRunState: runState.state },
      'cancelled',
    );
  }

  return { command: 'cancel', ok: true, cancelled: true, agentId: target.agentId, runId, runState };
}
