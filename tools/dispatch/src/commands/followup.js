import { Kind, ValidationError } from '../errors.js';
import { mapAgentStatus, mapRunStatus } from '../states.js';
import { resolveTarget } from './status.js';

const MAX_FOLLOWUP_CHARS = 8000;

/**
 * Submits exactly one follow-up run, and only when the agent is IDLE.
 * A busy agent is never re-prompted and never retried inside this command.
 */
export async function followup(ctx, options) {
  const { prompt } = options;
  if (!prompt || String(prompt).trim().length === 0) {
    throw new ValidationError('--prompt-file is required and must contain the follow-up text.');
  }
  if (String(prompt).length > MAX_FOLLOWUP_CHARS) {
    throw new ValidationError(
      `Follow-up is ${String(prompt).length} characters; the bounded limit is ${MAX_FOLLOWUP_CHARS}. Split the work into a new task instead.`,
    );
  }

  const target = resolveTarget(ctx, options);
  const { body: agent } = await ctx.api.getAgent(target.agentId);
  const agentState = mapAgentStatus(agent?.status);

  if (!agentState.acceptsFollowUp) {
    return {
      command: 'followup',
      ok: false,
      submitted: false,
      reason: agentState.state === 'archived' ? 'agent_archived' : 'agent_busy',
      agentId: target.agentId,
      agentState,
      message:
        agentState.state === 'archived'
          ? 'Agent is ARCHIVED and cannot accept runs. Unarchive it out-of-band or dispatch a new task.'
          : `Agent status is ${agentState.raw ?? 'unknown'}; a run is in flight. No follow-up was sent. Poll with "status" and retry once the agent is IDLE.`,
    };
  }

  try {
    const { body } = await ctx.api.createRun(target.agentId, { prompt: { text: String(prompt) } });
    const run = body?.run ?? null;
    if (target.record?.taskId) {
      ctx.store.update(
        target.record.taskId,
        { runId: run?.id ?? target.record.runId, lastKnownRunStatus: run?.status ?? null },
        'followup_submitted',
      );
    }
    return {
      command: 'followup',
      ok: true,
      submitted: true,
      agentId: target.agentId,
      runId: run?.id ?? null,
      runState: mapRunStatus(run?.status),
    };
  } catch (err) {
    if (err.kind === Kind.BUSY) {
      return {
        command: 'followup',
        ok: false,
        submitted: false,
        reason: 'agent_busy',
        agentId: target.agentId,
        agentState,
        message:
          'Server rejected the follow-up with 409 agent_busy — another run is CREATING or RUNNING. Not retried; wait for the run to terminate or cancel it.',
      };
    }
    throw err;
  }
}
