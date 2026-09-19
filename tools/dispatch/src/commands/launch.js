import { randomUUID } from 'node:crypto';
import { AmbiguousCreateError, Kind, ValidationError } from '../errors.js';
import { RecordState } from '../store.js';
import { validateLaunch } from '../validate.js';
import { discover, discoveredModelIds } from './discover.js';
import { buildAgentName, isDispatchAgentName, reconcileAndPersist } from '../reconcile.js';
import { mapRunStatus } from '../states.js';

/**
 * Counts the dispatch slots this client is actually occupying.
 *
 * `GET /v1/agents` returns every agent belonging to the key's owner: their
 * interactive sessions, other repositories, and — always — the HQ session
 * running this command, which is ACTIVE for as long as it is dispatching.
 * Counting all of them made the concurrency limit unsatisfiable by
 * construction. Only agents carrying this client's `[task:<id>]` name marker
 * consume a dispatch slot; the account-wide total is still reported so the
 * operator can see the difference.
 */
async function countActiveAgents(ctx, { maxPages = 5 } = {}) {
  let cursor;
  let dispatched = 0;
  let accountWide = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const { body } = await ctx.api.listAgents({ limit: 100, cursor, includeArchived: false });
    for (const agent of body?.items ?? []) {
      if (String(agent.status).toUpperCase() !== 'ACTIVE') continue;
      accountWide += 1;
      if (isDispatchAgentName(agent.name)) dispatched += 1;
    }
    cursor = body?.nextCursor;
    if (!cursor) break;
  }
  return { dispatched, accountWide };
}

/**
 * Creates one agent. The durable intent record is written before the POST, and
 * the returned ids are written immediately after, so no outcome is ever lost.
 */
export async function launch(ctx, options) {
  const {
    taskId,
    missionId,
    repoUrl,
    startingRef,
    baseCommit,
    model = null,
    prompt,
    autoCreatePR = false,
    allowBranchRef = false,
    workOnCurrentBranch = false,
  } = options;

  if (!prompt || String(prompt).trim().length === 0) {
    throw new ValidationError('--prompt-file is required and must contain the approved task text.');
  }

  const modelIds = model === null ? [] : discoveredModelIds(await discover(ctx, { includeRepositories: false }));
  const activeAgents = await countActiveAgents(ctx);

  const plan = validateLaunch({
    policy: ctx.policy,
    activeAgentsAccountWide: activeAgents.accountWide,
    missionId,
    repoUrl,
    startingRef,
    expectedBaseCommit: baseCommit,
    modelId: model,
    discoveredModelIds: modelIds,
    activeAgentCount: activeAgents.dispatched,
    autoCreatePR,
    allowBranchRef,
  });

  const clientAgentId = `bc-${randomUUID()}`;
  const agentName = buildAgentName(missionId, taskId);

  // Durable intent BEFORE the network call.
  const intent = ctx.store.putIntent({
    taskId,
    clientAgentId,
    agentName,
    missionId,
    repoUrl: plan.repoUrl,
    startingRef: plan.startingRef,
    expectedBaseCommit: plan.expectedBaseCommit,
    requestedModelId: model,
    autoCreatePR: plan.autoCreatePR,
    apiBase: ctx.http.baseUrl,
  });

  const requestBody = {
    agentId: clientAgentId,
    name: agentName,
    prompt: { text: String(prompt) },
    repos: [{ url: plan.repoUrl, startingRef: plan.startingRef }],
    workOnCurrentBranch,
    autoCreatePR: plan.autoCreatePR,
  };
  if (plan.requestedModel) requestBody.model = plan.requestedModel;

  let created;
  try {
    created = await ctx.api.createAgent(requestBody);
  } catch (err) {
    if (err.kind === Kind.CONFLICT && err.code === 'agent_id_conflict') {
      ctx.store.update(intent.taskId, { state: RecordState.AMBIGUOUS, ambiguousReason: 'agent_id_conflict' }, 'create_conflict');
      const outcome = await reconcileAndPersist(ctx, intent);
      return buildResult(ctx, outcome.record, plan, {
        ok: outcome.reconciled,
        note: 'Server reported agent_id_conflict: the agent already existed. Resolved by lookup, no second create was sent.',
        reconciledVia: outcome.via,
      });
    }

    if (err.ambiguous === true || err.kind === Kind.TIMEOUT) {
      ctx.store.update(intent.taskId, { state: RecordState.AMBIGUOUS, ambiguousReason: err.kind }, 'create_ambiguous');
      ctx.logger?.warn?.('create outcome is ambiguous; reconciling by lookup instead of retrying the POST');
      const outcome = await reconcileAndPersist(ctx, intent);
      if (outcome.reconciled) {
        return buildResult(ctx, outcome.record, plan, {
          ok: true,
          note: 'Create request did not return cleanly, but the agent exists. Adopted via lookup; no duplicate was created.',
          reconciledVia: outcome.via,
        });
      }
      throw new AmbiguousCreateError(
        `Create request failed with "${err.kind}" and no matching agent was found by lookup. ` +
          `The durable record for task "${taskId}" is marked "${RecordState.NOT_CREATED}". ` +
          `Re-run launch explicitly with a NEW --task-id only after confirming no agent exists; this client will not auto-retry a create.`,
        { taskId, clientAgentId, lookup: outcome.via },
      );
    }

    ctx.store.update(intent.taskId, { state: RecordState.CLOSED, failure: err.kind }, 'create_failed');
    throw err;
  }

  const agent = created.body?.agent ?? null;
  const run = created.body?.run ?? null;

  // Persist returned identifiers immediately.
  const stored = ctx.store.update(
    intent.taskId,
    {
      state: RecordState.LAUNCHED,
      agentId: agent?.id ?? null,
      runId: run?.id ?? agent?.latestRunId ?? null,
      agentUrl: agent?.url ?? null,
      lastKnownRunStatus: run?.status ?? null,
    },
    'launched',
  );

  return buildResult(ctx, stored, plan, { ok: true, run });
}

function buildResult(ctx, record, plan, { ok, note = null, reconciledVia = null, run = null }) {
  const runState = mapRunStatus(run?.status ?? record.lastKnownRunStatus ?? null);
  return {
    command: 'launch',
    ok,
    taskId: record.taskId,
    clientAgentId: record.clientAgentId,
    agentId: record.agentId,
    runId: record.runId,
    agentUrl: record.agentUrl,
    recordState: record.state,
    recordPath: `${ctx.store.recordsDir}/${record.taskId}.json`,
    repository: plan.repoUrl,
    startingRef: plan.startingRef,
    expectedBaseCommit: plan.expectedBaseCommit,
    model: { requested: plan.requestedModel?.id ?? null, effective: null, effectiveSource: 'not_exposed_by_api' },
    autoCreatePR: plan.autoCreatePR,
    slots: plan.slots,
    runState,
    reconciledVia,
    note,
  };
}
