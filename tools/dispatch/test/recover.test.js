import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { run, EXIT } from '../src/cli.js';
import {
  BASE_SHA,
  REPO_URL,
  agentFixture,
  captureStreams,
  countCalls,
  createMockFetch,
  envWithKey,
  makeWorkspace,
  noSleep,
} from './helpers/harness.js';

const BIN = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'dispatch.js');

function seed(cwd, records) {
  const dir = join(cwd, '.dexter', 'dispatch', 'records');
  mkdirSync(dir, { recursive: true });
  for (const record of records) {
    writeFileSync(join(dir, `${record.taskId}.json`), JSON.stringify(record, null, 2));
  }
  return dir;
}

const LAUNCHED = {
  taskId: 'task-001',
  clientAgentId: 'bc-00000000-0000-0000-0000-000000000001',
  agentName: 'barber-recovery [task:task-001]',
  missionId: 'barber-recovery',
  repoUrl: REPO_URL,
  startingRef: BASE_SHA,
  expectedBaseCommit: BASE_SHA,
  state: 'launched',
  agentId: 'bc-00000000-0000-0000-0000-000000000001',
  runId: 'run-00000000-0000-0000-0000-000000000001',
  lastKnownRunStatus: 'RUNNING',
  createdAt: '2026-09-19T04:30:00.000Z',
};

const AMBIGUOUS = {
  taskId: 'task-002',
  clientAgentId: 'bc-00000000-0000-0000-0000-000000000002',
  agentName: 'barber-recovery [task:task-002]',
  missionId: 'barber-recovery',
  repoUrl: REPO_URL,
  state: 'ambiguous',
  agentId: null,
  runId: null,
  createdAt: '2026-09-19T04:31:00.000Z',
};

test('a fresh process with no prior conversation rebuilds ids from disk alone', () => {
  const { cwd } = makeWorkspace();
  seed(cwd, [LAUNCHED, AMBIGUOUS]);

  // Deliberately spawned with no API key and no network use.
  const stdout = execFileSync(process.execPath, [BIN, 'recover'], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    encoding: 'utf8',
  });

  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.offline, true);
  assert.equal(payload.count, 2);
  assert.deepEqual(
    payload.tasks.map((t) => [t.taskId, t.agentId, t.runId]),
    [
      ['task-001', 'bc-00000000-0000-0000-0000-000000000001', 'run-00000000-0000-0000-0000-000000000001'],
      ['task-002', null, null],
    ],
  );
  assert.deepEqual(payload.needsReconciliation, ['task-002']);
  assert.equal(payload.tasks[0].lastKnownRunState.state, 'running');
  assert.equal(payload.tasks[0].expectedBaseCommit, BASE_SHA);
});

test('recover --refresh reconciles an ambiguous record without re-creating anything', async () => {
  const { cwd } = makeWorkspace();
  const dir = seed(cwd, [AMBIGUOUS]);
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({
    [`GET /v1/agents/${AMBIGUOUS.clientAgentId}`]: {
      status: 200,
      body: agentFixture({ id: AMBIGUOUS.clientAgentId, name: AMBIGUOUS.agentName, latestRunId: 'run-abc' }),
    },
  });

  const code = await run(['recover', '--refresh'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  assert.equal(countCalls(calls, 'POST /v1/agents'), 0, 'recovery must never create an agent');
  const payload = io.json();
  assert.equal(payload.tasks[0].state, 'reconciled');
  assert.equal(payload.tasks[0].agentId, AMBIGUOUS.clientAgentId);
  assert.equal(payload.tasks[0].runId, 'run-abc');

  const persisted = JSON.parse(readFileSync(join(dir, 'task-002.json'), 'utf8'));
  assert.equal(persisted.state, 'reconciled');
  assert.equal(persisted.agentId, AMBIGUOUS.clientAgentId);
});

test('recover works offline with no credential present', async () => {
  const { cwd } = makeWorkspace();
  seed(cwd, [LAUNCHED]);
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({});

  const code = await run(['recover'], { cwd, env: {}, fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  assert.equal(calls.length, 0);
  assert.equal(io.json().tasks[0].agentId, LAUNCHED.agentId);
});

test('recover reports an empty store rather than failing', async () => {
  const { cwd } = makeWorkspace();
  const io = captureStreams();
  const { fetchImpl } = createMockFetch({});

  const code = await run(['recover'], { cwd, env: {}, fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  assert.equal(io.json().count, 0);
});
