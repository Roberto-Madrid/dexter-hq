import { reconcileAndPersist } from '../reconcile.js';
import { mapRunStatus } from '../states.js';
import { RecordState } from '../store.js';

/**
 * Rebuilds known agent/run ids purely from the durable local store, so a
 * fresh process with no prior conversation can pick up in-flight work.
 * Offline by default; `--refresh` additionally reconciles ambiguous records.
 */
export async function recover(ctx, { taskId = null, refresh = false } = {}) {
  const all = ctx.store.list();
  const records = taskId ? all.filter((r) => r.taskId === taskId) : all;

  const tasks = [];
  for (const record of records) {
    const entry = {
      taskId: record.taskId,
      state: record.state ?? 'unknown',
      clientAgentId: record.clientAgentId ?? null,
      agentId: record.agentId ?? null,
      runId: record.runId ?? null,
      agentUrl: record.agentUrl ?? null,
      missionId: record.missionId ?? null,
      repository: record.repoUrl ?? null,
      startingRef: record.startingRef ?? null,
      expectedBaseCommit: record.expectedBaseCommit ?? null,
      lastKnownRunState: mapRunStatus(record.lastKnownRunStatus ?? null),
      createdAt: record.createdAt ?? null,
      refreshed: false,
    };

    if (refresh && record.state === RecordState.AMBIGUOUS) {
      const outcome = await reconcileAndPersist(ctx, record);
      entry.state = outcome.record.state;
      entry.agentId = outcome.record.agentId;
      entry.runId = outcome.record.runId;
      entry.reconciledVia = outcome.via;
      entry.refreshed = true;
    }

    tasks.push(entry);
  }

  return {
    command: 'recover',
    ok: true,
    offline: !refresh,
    recordsDir: ctx.store.recordsDir,
    count: tasks.length,
    needsReconciliation: tasks.filter((t) => t.state === RecordState.AMBIGUOUS).map((t) => t.taskId),
    tasks,
  };
}
