import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { redact } from './redact.js';
import { ValidationError } from './errors.js';

/** Record lifecycle. `ambiguous` is a first-class state, not an error state. */
export const RecordState = Object.freeze({
  INTENT: 'intent',
  LAUNCHED: 'launched',
  AMBIGUOUS: 'ambiguous',
  RECONCILED: 'reconciled',
  NOT_CREATED: 'not_created',
  CLOSED: 'closed',
});

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

export function assertTaskId(taskId) {
  if (!TASK_ID.test(String(taskId ?? ''))) {
    throw new ValidationError(
      `Invalid task id "${taskId}": expected 3-64 characters of [A-Za-z0-9._-] starting alphanumeric.`,
    );
  }
  return taskId;
}

function writeAtomic(path, text) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
  const fd = openSync(tmp, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/**
 * Durable, human-readable local record of dispatch intent and outcomes.
 * Written before a launch so that an ambiguous create can always be
 * reconciled by a later, unrelated process.
 */
export function createStore({ dir, cwd = process.cwd() }) {
  const root = resolve(cwd, dir);
  const recordsDir = join(root, 'records');
  const journalPath = join(root, 'journal.jsonl');

  function ensure() {
    mkdirSync(recordsDir, { recursive: true });
  }

  function pathFor(taskId) {
    return join(recordsDir, `${assertTaskId(taskId)}.json`);
  }

  function appendEvent(taskId, event, data) {
    ensure();
    const line = JSON.stringify(redact({ at: new Date().toISOString(), taskId, event, ...data }));
    appendFileSync(journalPath, `${line}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  function get(taskId) {
    try {
      return JSON.parse(readFileSync(pathFor(taskId), 'utf8'));
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }

  function put(record) {
    ensure();
    const next = redact({ ...record, updatedAt: new Date().toISOString() });
    writeAtomic(pathFor(next.taskId), `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  function putIntent(record) {
    assertTaskId(record.taskId);
    const existing = get(record.taskId);
    if (existing) {
      throw new ValidationError(
        `Task id "${record.taskId}" already has a durable record in state "${existing.state}". ` +
          `Reuse it via "recover"/"status" rather than launching a duplicate worker.`,
      );
    }
    const now = new Date().toISOString();
    const stored = put({ ...record, state: RecordState.INTENT, createdAt: now, agentId: null, runId: null });
    appendEvent(record.taskId, 'intent_persisted', { clientAgentId: record.clientAgentId });
    return stored;
  }

  function update(taskId, patch, event) {
    const existing = get(taskId);
    if (!existing) throw new ValidationError(`No durable record for task id "${taskId}" under "${recordsDir}".`);
    const stored = put({ ...existing, ...patch });
    if (event) appendEvent(taskId, event, { state: stored.state, agentId: stored.agentId, runId: stored.runId });
    return stored;
  }

  function list() {
    let names;
    try {
      names = readdirSync(recordsDir);
    } catch (err) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
    return names
      .filter((n) => n.endsWith('.json'))
      .map((n) => {
        try {
          return JSON.parse(readFileSync(join(recordsDir, n), 'utf8'));
        } catch {
          return { taskId: n.replace(/\.json$/, ''), state: 'unreadable', corrupt: true };
        }
      })
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }

  return { root, recordsDir, journalPath, putIntent, update, get, list, appendEvent };
}
