import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
  runFixture,
} from './helpers/harness.js';

const AGENT_ID = 'bc-00000000-0000-0000-0000-000000000001';
const RUN_ID = 'run-00000000-0000-0000-0000-000000000001';

/** Writes a launched record so lifecycle commands can resolve by --task-id. */
function seedRecord(cwd, overrides = {}) {
  const dir = join(cwd, '.dexter', 'dispatch', 'records');
  mkdirSync(dir, { recursive: true });
  const record = {
    taskId: 'task-001',
    clientAgentId: AGENT_ID,
    agentName: 'barber-recovery [task:task-001]',
    missionId: 'barber-recovery',
    repoUrl: REPO_URL,
    startingRef: BASE_SHA,
    expectedBaseCommit: BASE_SHA,
    requestedModelId: 'composer-2',
    state: 'launched',
    agentId: AGENT_ID,
    runId: RUN_ID,
    createdAt: '2026-09-19T04:30:00.000Z',
    ...overrides,
  };
  writeFileSync(join(dir, `${record.taskId}.json`), JSON.stringify(record, null, 2));
  return join(dir, `${record.taskId}.json`);
}

test('status reports a running agent and persists a resume record', async () => {
  const { cwd } = makeWorkspace();
  const path = seedRecord(cwd);
  const io = captureStreams();
  const { fetchImpl } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture() },
    [`GET /v1/agents/${AGENT_ID}/runs/${RUN_ID}`]: { status: 200, body: runFixture({ status: 'RUNNING' }) },
  });

  const code = await run(['status', '--task-id', 'task-001'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  const payload = io.json();
  assert.equal(payload.run.status.state, 'running');
  assert.equal(payload.run.status.terminal, false);
  assert.equal(payload.agent.status.state, 'active');

  const persisted = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(persisted.lastKnownRunState, 'running');
  assert.equal(persisted.resume.reason, 'observed');
});

test('status --wait polls with backoff until the run is terminal', async () => {
  const { cwd } = makeWorkspace();
  seedRecord(cwd);
  const io = captureStreams();
  const sequence = ['CREATING', 'RUNNING', 'RUNNING', 'FINISHED'];
  let i = 0;
  const { fetchImpl, calls } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture({ status: 'IDLE' }) },
    [`GET /v1/agents/${AGENT_ID}/runs/${RUN_ID}`]: () => ({
      status: 200,
      body: runFixture({ status: sequence[Math.min(i++, sequence.length - 1)] }),
    }),
  });

  const code = await run(['status', '--task-id', 'task-001', '--wait'], {
    cwd,
    env: envWithKey(),
    fetchImpl,
    ...io,
    sleep: noSleep,
  });

  assert.equal(code, EXIT.OK);
  const payload = io.json();
  assert.equal(payload.run.status.state, 'completed');
  assert.equal(payload.polls, 4);
  assert.equal(countCalls(calls, `GET /v1/agents/${AGENT_ID}/runs/${RUN_ID}`), 4);
});

test('status --wait stops at the hard timeout and leaves a resume record', async () => {
  const { cwd } = makeWorkspace();
  const path = seedRecord(cwd);
  const io = captureStreams();
  let clock = 0;
  const { fetchImpl } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture() },
    [`GET /v1/agents/${AGENT_ID}/runs/${RUN_ID}`]: { status: 200, body: runFixture({ status: 'RUNNING' }) },
  });

  const code = await run(['status', '--task-id', 'task-001', '--wait'], {
    cwd,
    env: envWithKey(),
    fetchImpl,
    ...io,
    sleep: async () => {
      clock += 400;
    },
    now: () => clock,
  });

  assert.equal(code, EXIT.API);
  const payload = io.json();
  assert.equal(payload.timedOut, true);
  assert.match(payload.message, /resume record was written/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).resume.reason, 'poll_timeout');
});

test('result returns the terminal reply, branches and artifacts', async () => {
  const { cwd } = makeWorkspace();
  seedRecord(cwd);
  const io = captureStreams();
  const { fetchImpl } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture({ status: 'IDLE' }) },
    [`GET /v1/agents/${AGENT_ID}/runs/${RUN_ID}`]: {
      status: 200,
      body: runFixture({
        status: 'FINISHED',
        durationMs: 12357,
        result: 'Added the booking fix.',
        git: { branches: [{ repoUrl: 'github.com/Roberto-Madrid/dexter-barber', branch: 'cursor/booking-fix-a1b2' }] },
      }),
    },
    [`GET /v1/agents/${AGENT_ID}/artifacts`]: {
      status: 200,
      body: { items: [{ path: 'artifacts/screenshot.png', sizeBytes: 12345, updatedAt: '2026-09-19T04:45:00.000Z' }] },
    },
  });

  const code = await run(['result', '--task-id', 'task-001'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  const payload = io.json();
  assert.equal(payload.runState.state, 'completed');
  assert.equal(payload.resultText, 'Added the booking fix.');
  assert.equal(payload.durationMs, 12357);
  assert.equal(payload.branches[0].branch, 'cursor/booking-fix-a1b2');
  assert.equal(payload.branchScope, 'agent');
  assert.equal(payload.artifacts.items[0].path, 'artifacts/screenshot.png');
});

test('result on a non-terminal run returns no text and says why', async () => {
  const { cwd } = makeWorkspace();
  seedRecord(cwd);
  const io = captureStreams();
  const { fetchImpl } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture() },
    [`GET /v1/agents/${AGENT_ID}/runs/${RUN_ID}`]: { status: 200, body: runFixture({ status: 'RUNNING', result: 'leaked partial' }) },
    [`GET /v1/agents/${AGENT_ID}/artifacts`]: { status: 200, body: { items: [] } },
  });

  const code = await run(['result', '--task-id', 'task-001'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.API);
  const payload = io.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.resultText, null);
  assert.match(payload.note, /Run is running/);
});

test('an unrecognised run status surfaces as unknown rather than success', async () => {
  const { cwd } = makeWorkspace();
  seedRecord(cwd);
  const io = captureStreams();
  const { fetchImpl } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture({ status: 'SOMETHING_NEW' }) },
    [`GET /v1/agents/${AGENT_ID}/runs/${RUN_ID}`]: { status: 200, body: runFixture({ status: 'SOMETHING_NEW' }) },
  });

  await run(['status', '--task-id', 'task-001'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  const payload = io.json();
  assert.equal(payload.run.status.state, 'unknown');
  assert.equal(payload.run.status.recognized, false);
  assert.equal(payload.agent.status.state, 'unknown');
});

test('followup is withheld while the agent is ACTIVE — no POST is sent', async () => {
  const { cwd, promptFile } = makeWorkspace();
  seedRecord(cwd);
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture({ status: 'ACTIVE' }) },
  });

  const code = await run(['followup', '--task-id', 'task-001', '--prompt-file', promptFile], {
    cwd,
    env: envWithKey(),
    fetchImpl,
    ...io,
    sleep: noSleep,
  });

  assert.equal(code, EXIT.BUSY);
  assert.equal(countCalls(calls, `POST /v1/agents/${AGENT_ID}/runs`), 0, 'must not prompt a busy agent');
  assert.equal(io.json().reason, 'agent_busy');
});

test('a 409 agent_busy on followup is reported once and never retried', async () => {
  const { cwd, promptFile } = makeWorkspace();
  seedRecord(cwd);
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture({ status: 'IDLE' }) },
    [`POST /v1/agents/${AGENT_ID}/runs`]: { status: 409, body: { code: 'agent_busy', message: 'run in flight' } },
  });

  const code = await run(['followup', '--task-id', 'task-001', '--prompt-file', promptFile], {
    cwd,
    env: envWithKey(),
    fetchImpl,
    ...io,
    sleep: noSleep,
  });

  assert.equal(code, EXIT.BUSY);
  assert.equal(countCalls(calls, `POST /v1/agents/${AGENT_ID}/runs`), 1);
  assert.match(io.json().message, /Not retried/);
});

test('followup on an IDLE agent submits exactly one bounded run', async () => {
  const { cwd, promptFile } = makeWorkspace();
  const path = seedRecord(cwd);
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture({ status: 'IDLE' }) },
    [`POST /v1/agents/${AGENT_ID}/runs`]: {
      status: 200,
      body: { run: runFixture({ id: 'run-2', status: 'CREATING' }) },
    },
  });

  const code = await run(['followup', '--task-id', 'task-001', '--prompt-file', promptFile], {
    cwd,
    env: envWithKey(),
    fetchImpl,
    ...io,
    sleep: noSleep,
  });

  assert.equal(code, EXIT.OK);
  assert.equal(countCalls(calls, `POST /v1/agents/${AGENT_ID}/runs`), 1);
  assert.equal(io.json().runState.state, 'queued');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).runId, 'run-2');
});

test('cancel maps a cancelled run and closes the record', async () => {
  const { cwd } = makeWorkspace();
  const path = seedRecord(cwd);
  const io = captureStreams();
  let cancelled = false;
  const { fetchImpl } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture() },
    [`POST /v1/agents/${AGENT_ID}/runs/${RUN_ID}/cancel`]: () => {
      cancelled = true;
      return { status: 200, body: { id: RUN_ID } };
    },
    [`GET /v1/agents/${AGENT_ID}/runs/${RUN_ID}`]: () => ({
      status: 200,
      body: runFixture({ status: cancelled ? 'CANCELLED' : 'RUNNING' }),
    }),
  });

  const code = await run(['cancel', '--task-id', 'task-001'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  assert.equal(io.json().runState.state, 'cancelled');
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).state, 'closed');
});

test('cancelling a terminal run reports run_not_cancellable instead of failing', async () => {
  const { cwd } = makeWorkspace();
  seedRecord(cwd);
  const io = captureStreams();
  const { fetchImpl } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture({ status: 'IDLE' }) },
    [`POST /v1/agents/${AGENT_ID}/runs/${RUN_ID}/cancel`]: { status: 409, body: { code: 'run_not_cancellable' } },
    [`GET /v1/agents/${AGENT_ID}/runs/${RUN_ID}`]: { status: 200, body: runFixture({ status: 'FINISHED' }) },
  });

  const code = await run(['cancel', '--task-id', 'task-001'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.API);
  const payload = io.json();
  assert.equal(payload.cancelled, false);
  assert.equal(payload.reason, 'run_not_cancellable');
  assert.equal(payload.runState.state, 'completed');
});

test('usage reports real token counts and refuses to estimate cost', async () => {
  const { cwd } = makeWorkspace();
  seedRecord(cwd);
  const io = captureStreams();
  const { fetchImpl } = createMockFetch({
    [`GET /v1/agents/${AGENT_ID}`]: { status: 200, body: agentFixture({ status: 'IDLE' }) },
    [`GET /v1/agents/${AGENT_ID}/usage`]: {
      status: 200,
      body: {
        totalUsage: { inputTokens: 12480, outputTokens: 3110, cacheWriteTokens: 18200, cacheReadTokens: 42600, totalTokens: 76390 },
        runs: [{ id: RUN_ID, usage: { totalTokens: 76390 } }],
      },
    },
  });

  const code = await run(['usage', '--task-id', 'task-001'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  const payload = io.json();
  assert.equal(payload.tokens.available, true);
  assert.equal(payload.tokens.totalUsage.totalTokens, 76390);
  assert.equal(payload.cost.status, 'unknown');
  assert.equal(payload.cost.value, null);
  assert.equal(payload.allowanceRemaining.status, 'unknown');
  assert.equal(payload.effectiveModel.status, 'unknown');
});
