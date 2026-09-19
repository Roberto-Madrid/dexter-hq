import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, EXIT } from '../src/cli.js';
import {
  BASE_SHA,
  EMPTY_AGENTS,
  FAKE_KEY,
  HANG,
  MODELS_RESPONSE,
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

const LAUNCH_ARGS = (promptFile, taskId = 'task-001') => [
  'launch',
  '--task-id',
  taskId,
  '--mission',
  'barber-recovery',
  '--repo',
  REPO_URL,
  '--starting-ref',
  BASE_SHA,
  '--base-commit',
  BASE_SHA,
  '--model',
  'composer-2',
  '--prompt-file',
  promptFile,
];

function recordPath(cwd, taskId = 'task-001') {
  return join(cwd, '.dexter', 'dispatch', 'records', `${taskId}.json`);
}

test('dispatch slots count only agents this client launched, not the whole account', async () => {
  const { cwd, promptFile } = makeWorkspace();
  const io = captureStreams();

  // The key's owner always has at least one ACTIVE agent while dispatching:
  // the HQ session issuing the command. Neither of these carries the
  // [task:<id>] marker, so neither occupies a dispatch slot.
  const { fetchImpl } = createMockFetch({
    'GET /v1/models': MODELS_RESPONSE,
    'GET /v1/agents': {
      status: 200,
      body: {
        items: [
          agentFixture({ id: 'bc-hq-session', name: 'Run live dispatch acceptance proofs', status: 'ACTIVE' }),
          agentFixture({ id: 'bc-unrelated', name: 'QA smoke on another project', status: 'ACTIVE' }),
        ],
      },
    },
    'POST /v1/agents': (call) => ({
      status: 200,
      body: { agent: agentFixture({ id: call.body.agentId }), run: runFixture({ agentId: call.body.agentId }) },
    }),
  });

  const code = await run(LAUNCH_ARGS(promptFile), { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  const payload = io.json();
  assert.equal(payload.slots.used, 0);
  assert.equal(payload.slots.activeAgentsAccountWide, 2);
});

test('an active agent launched by this client does consume a dispatch slot', async () => {
  const { cwd, promptFile } = makeWorkspace();
  const io = captureStreams();

  const { fetchImpl, calls } = createMockFetch({
    'GET /v1/models': MODELS_RESPONSE,
    'GET /v1/agents': {
      status: 200,
      body: {
        items: [
          agentFixture({ id: 'bc-a', name: 'barber-recovery [task:earlier-a]', status: 'ACTIVE' }),
          agentFixture({ id: 'bc-b', name: 'barber-recovery [task:earlier-b]', status: 'ACTIVE' }),
        ],
      },
    },
  });

  const code = await run(LAUNCH_ARGS(promptFile), { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.VALIDATION);
  assert.match(io.json().details.problems[0], /2\/2 dispatch slots already in use/);
  assert.equal(countCalls(calls, 'POST /v1/agents'), 0, 'no agent may be created when the limit is reached');
});

test('launch persists intent before the create POST and ids immediately after', async () => {
  const { cwd, promptFile } = makeWorkspace();
  const io = captureStreams();
  let intentExistedAtPostTime = null;
  let intentAtPostTime = null;

  const { fetchImpl, calls } = createMockFetch({
    'GET /v1/models': MODELS_RESPONSE,
    'GET /v1/agents': EMPTY_AGENTS,
    'POST /v1/agents': (call) => {
      intentExistedAtPostTime = existsSync(recordPath(cwd));
      intentAtPostTime = JSON.parse(readFileSync(recordPath(cwd), 'utf8'));
      return {
        status: 200,
        body: { agent: agentFixture({ id: call.body.agentId }), run: runFixture({ agentId: call.body.agentId }) },
      };
    },
  });

  const code = await run(LAUNCH_ARGS(promptFile), { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  assert.equal(intentExistedAtPostTime, true, 'intent record must exist before the POST');
  assert.equal(intentAtPostTime.state, 'intent');
  assert.equal(intentAtPostTime.agentId, null);
  assert.equal(intentAtPostTime.expectedBaseCommit, BASE_SHA);

  const payload = io.json();
  assert.equal(payload.ok, true);
  assert.equal(payload.recordState, 'launched');
  assert.equal(payload.agentId, payload.clientAgentId);
  assert.equal(payload.runId, 'run-00000000-0000-0000-0000-000000000001');
  assert.equal(payload.runState.state, 'queued', 'CREATING is queued, not completed');
  assert.deepEqual(payload.model, { requested: 'composer-2', effective: null, effectiveSource: 'not_exposed_by_api' });

  const post = calls.find((c) => c.key === 'POST /v1/agents');
  assert.equal(post.body.autoCreatePR, false, 'automatic PR creation must be off by default');
  assert.equal(post.body.workOnCurrentBranch, false);
  assert.deepEqual(post.body.repos, [{ url: REPO_URL, startingRef: BASE_SHA }]);
  assert.match(post.body.agentId, /^bc-[0-9a-f-]{36}$/);
  assert.equal(post.body.name, 'barber-recovery [task:task-001]');

  const persisted = JSON.parse(readFileSync(recordPath(cwd), 'utf8'));
  assert.equal(persisted.state, 'launched');
  assert.equal(persisted.agentId, payload.agentId);
  assert.ok(!JSON.stringify(persisted).includes(FAKE_KEY), 'credential must never reach a durable record');
});

test('an ambiguous create is reconciled by lookup, never by a second POST', async () => {
  const { cwd, promptFile } = makeWorkspace();
  const io = captureStreams();
  let clientAgentId = null;

  const { fetchImpl, calls } = createMockFetch({
    'GET /v1/models': MODELS_RESPONSE,
    'GET /v1/agents': EMPTY_AGENTS,
    'POST /v1/agents': (call) => {
      clientAgentId = call.body.agentId;
      return HANG; // request times out; the server may or may not have created the agent
    },
  });
  // The reconciliation lookup targets a path only known at runtime.
  const originalFetch = fetchImpl;
  const wrapped = async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === 'GET' && path === `/v1/agents/${clientAgentId}`) {
      calls.push({ key: `GET ${path}`, method: 'GET', path, query: {}, headers: init.headers });
      return new Response(JSON.stringify(agentFixture({ id: clientAgentId })), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return originalFetch(url, init);
  };

  const code = await run(LAUNCH_ARGS(promptFile), { cwd, env: envWithKey(), fetchImpl: wrapped, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  assert.equal(countCalls(calls, 'POST /v1/agents'), 1, 'exactly one create must ever be sent');
  const payload = io.json();
  assert.equal(payload.recordState, 'reconciled');
  assert.equal(payload.agentId, clientAgentId);
  assert.equal(payload.reconciledVia, 'get_agent_by_client_id');
  assert.match(payload.note, /no duplicate was created/);
});

test('an ambiguous create with no matching agent fails loudly and records not_created', async () => {
  const { cwd, promptFile } = makeWorkspace();
  const io = captureStreams();
  let clientAgentId = null;

  const { fetchImpl, calls } = createMockFetch({
    'GET /v1/models': MODELS_RESPONSE,
    'GET /v1/agents': EMPTY_AGENTS,
    'POST /v1/agents': (call) => {
      clientAgentId = call.body.agentId;
      return HANG;
    },
  });
  const wrapped = async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === 'GET' && path.startsWith('/v1/agents/bc-')) {
      calls.push({ key: `GET ${path}`, method: 'GET', path, query: {}, headers: init.headers });
      return new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return fetchImpl(url, init);
  };

  const code = await run(LAUNCH_ARGS(promptFile), { cwd, env: envWithKey(), fetchImpl: wrapped, ...io, sleep: noSleep });

  assert.equal(code, EXIT.AMBIGUOUS);
  assert.equal(countCalls(calls, 'POST /v1/agents'), 1, 'must not retry the create');
  const payload = io.json();
  assert.equal(payload.kind, 'ambiguous');
  assert.match(payload.message, /will not auto-retry a create/);

  const persisted = JSON.parse(readFileSync(recordPath(cwd), 'utf8'));
  assert.equal(persisted.state, 'not_created');
  assert.equal(persisted.clientAgentId, clientAgentId);
});

test('agent_id_conflict is resolved by lookup through the task marker in the agent name', async () => {
  const { cwd, promptFile } = makeWorkspace();
  const io = captureStreams();
  let listCall = 0;

  const { fetchImpl, calls } = createMockFetch({
    'GET /v1/models': MODELS_RESPONSE,
    'GET /v1/agents': () => {
      listCall += 1;
      // First call is the concurrency check; the second is the reconciliation lookup.
      if (listCall === 1) return EMPTY_AGENTS;
      return { status: 200, body: { items: [agentFixture({ id: 'bc-server-minted', name: 'barber-recovery [task:task-001]' })] } };
    },
    'POST /v1/agents': { status: 409, body: { code: 'agent_id_conflict', message: 'agent already exists' } },
  });
  const wrapped = async (url, init) => {
    const path = new URL(url).pathname;
    if (init?.method === 'GET' && path.startsWith('/v1/agents/bc-')) {
      calls.push({ key: `GET ${path}`, method: 'GET', path, query: {}, headers: init.headers });
      return new Response(JSON.stringify({ code: 'not_found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return fetchImpl(url, init);
  };

  const code = await run(LAUNCH_ARGS(promptFile), { cwd, env: envWithKey(), fetchImpl: wrapped, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  assert.equal(countCalls(calls, 'POST /v1/agents'), 1);
  const payload = io.json();
  assert.equal(payload.agentId, 'bc-server-minted');
  assert.equal(payload.reconciledVia, 'list_agents_task_marker');
});

test('a duplicate task id is refused before any network call', async () => {
  const { cwd, promptFile } = makeWorkspace();
  const first = captureStreams();
  const { fetchImpl, calls } = createMockFetch({
    'GET /v1/models': MODELS_RESPONSE,
    'GET /v1/agents': EMPTY_AGENTS,
    'POST /v1/agents': (call) => ({
      status: 200,
      body: { agent: agentFixture({ id: call.body.agentId }), run: runFixture({ agentId: call.body.agentId }) },
    }),
  });

  await run(LAUNCH_ARGS(promptFile), { cwd, env: envWithKey(), fetchImpl, ...first, sleep: noSleep });
  const postsAfterFirst = countCalls(calls, 'POST /v1/agents');

  const second = captureStreams();
  const code = await run(LAUNCH_ARGS(promptFile), { cwd, env: envWithKey(), fetchImpl, ...second, sleep: noSleep });

  assert.equal(code, EXIT.VALIDATION);
  assert.equal(countCalls(calls, 'POST /v1/agents'), postsAfterFirst, 'no second create for a reused task id');
  assert.match(second.json().message, /already has a durable record/);
});

test('validation failures stop before the create and leave no record behind', async () => {
  const { cwd, promptFile } = makeWorkspace();
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({
    'GET /v1/models': MODELS_RESPONSE,
    'GET /v1/agents': EMPTY_AGENTS,
  });

  const args = LAUNCH_ARGS(promptFile, 'task-bad');
  args[args.indexOf(REPO_URL)] = 'https://github.com/Roberto-Madrid/Dexter';

  const code = await run(args, { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.VALIDATION);
  assert.equal(countCalls(calls, 'POST /v1/agents'), 0);
  assert.equal(existsSync(recordPath(cwd, 'task-bad')), false);
  assert.match(io.json().details.problems.join(' '), /not in repositoryAllowlist/);
});

test('launch refuses to run when the dispatch policy file is absent', async () => {
  const { cwd, promptFile } = makeWorkspace();
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({});

  const code = await run([...LAUNCH_ARGS(promptFile), '--policy', 'config/does-not-exist.json'], {
    cwd,
    env: envWithKey(),
    fetchImpl,
    ...io,
    sleep: noSleep,
  });

  assert.equal(code, EXIT.VALIDATION);
  assert.equal(calls.length, 0);
  assert.match(io.json().message, /requires the dispatch policy file/);
  assert.match(io.json().message, /tools\/dispatch\/README\.md/);
});
