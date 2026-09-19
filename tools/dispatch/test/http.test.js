import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../src/http.js';
import { createApi } from '../src/api.js';
import { Kind } from '../src/errors.js';
import { FAKE_KEY, HANG, countCalls, createMockFetch, fixedRandom } from './helpers/harness.js';

function clientFor(routes, overrides = {}) {
  const { fetchImpl, calls } = createMockFetch(routes);
  const slept = [];
  const http = createHttpClient({
    baseUrl: 'https://api.cursor.test',
    credential: { get: () => FAKE_KEY, present: true },
    fetchImpl,
    timeoutMs: 50,
    baseBackoffMs: 100,
    sleep: async (ms) => slept.push(ms),
    random: fixedRandom,
    ...overrides,
  });
  return { http, api: createApi(http), calls, slept };
}

test('rate-limited GETs back off and retry, honouring Retry-After', async () => {
  let attempts = 0;
  const { api, calls, slept } = clientFor({
    'GET /v1/models': () => {
      attempts += 1;
      if (attempts < 3) return { status: 429, body: { code: 'rate_limited' }, headers: { 'retry-after': '2' } };
      return { status: 200, body: { items: [] } };
    },
  });

  const res = await api.listModels();

  assert.equal(res.status, 200);
  assert.equal(countCalls(calls, 'GET /v1/models'), 3);
  assert.deepEqual(slept, [2000, 2000], 'Retry-After must drive the delay');
});

test('transient 5xx GETs retry with exponential backoff and then give up', async () => {
  const { api, calls, slept } = clientFor({ 'GET /v1/models': { status: 503, body: { message: 'unavailable' } } });

  await assert.rejects(api.listModels(), (err) => err.kind === Kind.TRANSIENT);

  assert.equal(countCalls(calls, 'GET /v1/models'), 4, 'initial attempt plus three retries');
  assert.deepEqual(slept, [75, 150, 300], 'exponential backoff with deterministic jitter');
});

test('creates are never retried, even on a transient failure', async () => {
  const { api, calls, slept } = clientFor({ 'POST /v1/agents': { status: 503, body: { message: 'unavailable' } } });

  await assert.rejects(api.createAgent({ prompt: { text: 'x' } }), (err) => err.kind === Kind.TRANSIENT);

  assert.equal(countCalls(calls, 'POST /v1/agents'), 1);
  assert.deepEqual(slept, []);
});

test('a timed-out create is flagged ambiguous; a timed-out GET is not', async () => {
  const create = clientFor({ 'POST /v1/agents': HANG });
  await assert.rejects(create.api.createAgent({}), (err) => {
    assert.equal(err.kind, Kind.TIMEOUT);
    assert.equal(err.ambiguous, true);
    assert.match(err.message, /Outcome is UNKNOWN/);
    return true;
  });

  const read = clientFor({ 'GET /v1/me': HANG }, { maxRetries: 0 });
  await assert.rejects(read.api.me(), (err) => {
    assert.equal(err.kind, Kind.TIMEOUT);
    assert.equal(err.ambiguous, false);
    assert.match(err.message, /Safe to retry/);
    return true;
  });
});

test('HTTP status codes map to distinct failure kinds', async () => {
  const cases = [
    [401, {}, Kind.AUTH],
    [403, {}, Kind.AUTH],
    [404, { code: 'run_not_found' }, Kind.NOT_FOUND],
    [409, { code: 'agent_busy' }, Kind.BUSY],
    [409, { code: 'run_not_cancellable' }, Kind.CONFLICT],
    [429, { code: 'rate_limited' }, Kind.RATE_LIMIT],
    [500, {}, Kind.TRANSIENT],
    [422, { code: 'invalid_request' }, Kind.API],
  ];
  for (const [status, body, kind] of cases) {
    const { api } = clientFor({ 'GET /v1/me': { status, body } }, { maxRetries: 0 });
    await assert.rejects(api.me(), (err) => err.kind === kind, `HTTP ${status} ${body.code ?? ''} -> ${kind}`);
  }
});

test('an echoed credential in an error body is redacted before it reaches the caller', async () => {
  const { api } = clientFor({
    'GET /v1/me': { status: 400, body: { code: 'bad', message: `token ${FAKE_KEY} rejected`, echoed: { authorization: `Bearer ${FAKE_KEY}` } } },
  });
  await assert.rejects(api.me(), (err) => {
    const serialized = JSON.stringify(err.toJSON());
    assert.ok(!serialized.includes(FAKE_KEY), 'credential leaked through API error details');
    return true;
  });
});

test('the Authorization header is sent but never appears in the recorded error details', async () => {
  const { api, calls } = clientFor({ 'GET /v1/me': { status: 500, body: { message: 'boom' } } }, { maxRetries: 0 });
  await assert.rejects(api.me(), (err) => !JSON.stringify(err.toJSON()).includes(FAKE_KEY));
  assert.equal(calls[0].headers.Authorization, `Bearer ${FAKE_KEY}`);
});
