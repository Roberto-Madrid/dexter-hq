import test from 'node:test';
import assert from 'node:assert/strict';
import { run, EXIT } from '../src/cli.js';
import {
  HQ_REPO_URL,
  MODELS_RESPONSE,
  REPO_URL,
  captureStreams,
  createMockFetch,
  envWithKey,
  makeWorkspace,
  noSleep,
} from './helpers/harness.js';

test('discover returns model ids from the API and flags allowlisted repositories', async () => {
  const { cwd } = makeWorkspace();
  const io = captureStreams();
  const { fetchImpl } = createMockFetch({
    'GET /v1/models': MODELS_RESPONSE,
    'GET /v1/repositories': {
      status: 200,
      body: { items: [{ url: REPO_URL }, { url: HQ_REPO_URL }, { url: 'https://github.com/someone/unrelated' }] },
    },
  });

  const code = await run(['discover'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  const payload = io.json();
  assert.deepEqual(
    payload.models.items.map((m) => m.id),
    ['composer-2', 'claude-4.6-sonnet-thinking'],
  );
  assert.equal(payload.repositories.available, true);
  const allowlisted = payload.repositories.items.filter((r) => r.inPolicyAllowlist).map((r) => r.url);
  assert.deepEqual(allowlisted, [REPO_URL, HQ_REPO_URL]);
  assert.equal(payload.repositories.items.find((r) => r.url.includes('unrelated')).inPolicyAllowlist, false);
});

test('repository discovery being rate limited degrades to unavailable, not failure', async () => {
  const { cwd } = makeWorkspace();
  const io = captureStreams();
  const { fetchImpl } = createMockFetch({
    'GET /v1/models': MODELS_RESPONSE,
    'GET /v1/repositories': { status: 429, body: { code: 'rate_limited', message: 'slow down' }, headers: { 'retry-after': '0' } },
  });

  const code = await run(['discover'], { cwd, env: envWithKey(), fetchImpl, ...io, sleep: noSleep });

  assert.equal(code, EXIT.OK);
  const payload = io.json();
  assert.equal(payload.models.count, 2);
  assert.equal(payload.repositories.available, false);
  assert.equal(payload.repositories.reason, 'rate_limit');
});
