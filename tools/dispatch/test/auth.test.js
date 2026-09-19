import test from 'node:test';
import assert from 'node:assert/strict';
import { run, EXIT } from '../src/cli.js';
import {
  FAKE_KEY,
  captureStreams,
  createMockFetch,
  envWithKey,
  makeWorkspace,
  noSleep,
} from './helpers/harness.js';

test('auth-check degrades with an actionable message when the secret is absent', async () => {
  const { cwd } = makeWorkspace();
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({});

  const code = await run(['auth-check'], { cwd, env: {}, fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.NO_CREDENTIAL);
  assert.equal(calls.length, 0, 'no live call should be attempted without a credential');
  const payload = io.json();
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'secret_not_available');
  assert.equal(payload.credentialStatus.present, false);
  assert.equal(payload.credentialStatus.envVar, 'DEXTER_CURSOR_API_KEY');
  assert.match(payload.message, /DEXTER_CURSOR_API_KEY/);
});

test('auth-check reports identity without emitting the credential anywhere', async () => {
  const { cwd } = makeWorkspace();
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({
    'GET /v1/me': {
      status: 200,
      body: { apiKeyName: 'Dexter HQ Key', userId: 42, userEmail: 'owner@example.com', createdAt: '2026-01-01T00:00:00.000Z' },
    },
  });

  const code = await run(['auth-check', '--log-level', 'debug'], {
    cwd,
    env: envWithKey(),
    fetchImpl,
    ...io,
    sleep: noSleep,
  });

  assert.equal(code, EXIT.OK);
  const payload = io.json();
  assert.equal(payload.authenticated, true);
  assert.equal(payload.identity.apiKeyName, 'Dexter HQ Key');
  assert.equal(payload.identity.keyScope, 'user');

  assert.equal(calls[0].headers.Authorization, `Bearer ${FAKE_KEY}`, 'header must still be sent');
  assert.ok(!io.outText().includes(FAKE_KEY), 'credential leaked to stdout');
  assert.ok(!io.errText().includes(FAKE_KEY), 'credential leaked to stderr');
});

test('a rejected credential is reported as an auth failure, not a crash, and is redacted', async () => {
  const { cwd } = makeWorkspace();
  const io = captureStreams();
  const { fetchImpl } = createMockFetch({
    'GET /v1/me': { status: 401, body: { code: 'unauthorized', message: `bad key ${FAKE_KEY}` } },
  });

  const code = await run(['auth-check'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.API);
  const payload = io.json();
  assert.equal(payload.authenticated, false);
  assert.equal(payload.reason, 'credential_rejected');
  assert.ok(!io.outText().includes(FAKE_KEY), 'credential echoed back from the error body');
});

test('online commands refuse to run without a credential instead of crashing', async () => {
  const { cwd } = makeWorkspace();
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({});

  const code = await run(['discover'], { cwd, env: {}, fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.NO_CREDENTIAL);
  assert.equal(calls.length, 0);
  assert.match(io.json().message, /DEXTER_CURSOR_API_KEY/);
});

test('a credential passed on the command line aborts the run', async () => {
  const { cwd } = makeWorkspace();
  const io = captureStreams();
  const { fetchImpl, calls } = createMockFetch({});

  const code = await run(['auth-check', '--task-id', FAKE_KEY], {
    cwd,
    env: envWithKey(),
    fetchImpl,
    ...io,
    sleep: noSleep,
  });

  assert.equal(code, EXIT.VALIDATION);
  assert.equal(calls.length, 0);
  assert.ok(!io.outText().includes(FAKE_KEY));
});
