import test from 'node:test';
import assert from 'node:assert/strict';
import { redact, redactString, registerSecret, resetSecrets, looksLikeSecret } from '../src/redact.js';
import { AuthError, DispatchError } from '../src/errors.js';
import { BASE_SHA, FAKE_KEY } from './helpers/harness.js';

test('registered credential value never survives redaction', () => {
  resetSecrets();
  registerSecret(FAKE_KEY);
  const text = `request failed with Authorization: Bearer ${FAKE_KEY}`;
  const out = redactString(text);
  assert.ok(!out.includes(FAKE_KEY), 'literal key leaked');
  assert.ok(out.includes('[REDACTED]'));
});

test('prefixed credential shapes are redacted even when never registered', () => {
  resetSecrets();
  for (const secret of ['key_abcdefghijklmnopqrstuvwxyz', 'sk-abcdefghijklmnopqrstuv', 'ghp_abcdefghijklmnopqrst']) {
    assert.ok(!redactString(`token=${secret}`).includes(secret), `${secret} leaked`);
  }
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.ok(!redactString(jwt).includes(jwt));
});

test('credentials embedded in remote URLs are redacted', () => {
  resetSecrets();
  const out = redactString('https://x-access-token:ghs_abcdefghijklmnop@github.com/org/repo');
  assert.ok(!out.includes('ghs_abcdefghijklmnop'));
  assert.ok(out.includes('github.com/org/repo'));
});

test('git SHAs and agent ids stay readable', () => {
  resetSecrets();
  assert.equal(redactString(BASE_SHA), BASE_SHA);
  assert.equal(redactString('bc-00000000-0000-0000-0000-000000000001'), 'bc-00000000-0000-0000-0000-000000000001');
  assert.equal(looksLikeSecret(BASE_SHA), false);
});

test('sensitive object keys are masked wholesale', () => {
  resetSecrets();
  const masked = redact({
    headers: { Authorization: 'Bearer abc', 'x-api-key': 'plain', accept: 'application/json' },
    nested: { apiKey: 'plain', cookie: 'session=1' },
  });
  assert.equal(masked.headers.Authorization, '[REDACTED]');
  assert.equal(masked.headers['x-api-key'], '[REDACTED]');
  assert.equal(masked.headers.accept, 'application/json');
  assert.equal(masked.nested.apiKey, '[REDACTED]');
  assert.equal(masked.nested.cookie, '[REDACTED]');
});

test('DispatchError redacts both message and details', () => {
  resetSecrets();
  registerSecret(FAKE_KEY);
  const err = new AuthError(`rejected key ${FAKE_KEY}`, { headers: { authorization: `Bearer ${FAKE_KEY}` } });
  const json = JSON.stringify(err.toJSON());
  assert.ok(!json.includes(FAKE_KEY), 'secret leaked through error serialization');
  assert.ok(json.includes('[REDACTED]'));
  assert.ok(err instanceof DispatchError);
});

test('redaction survives circular structures', () => {
  resetSecrets();
  const a = { name: 'a' };
  a.self = a;
  assert.equal(redact(a).self, '[Circular]');
});

test('an identifier field keeps its value but still loses an embedded secret', () => {
  resetSecrets();
  registerSecret(FAKE_KEY);

  // Observed live: this branch name was masked to "cursor/[REDACTED]" by the
  // unprefixed high-entropy heuristic, which protected nothing and hid the
  // only handle the operator had on the agent's branch.
  const branch = 'cursor/hq-bootstrap-preflight-task-hq-preflight-001-69d8';
  const masked = redact({
    branch,
    url: 'https://cursor.com/agents/bc-82f15814-538b-4106-b939-fa1e7e7b0453',
    repoUrl: 'github.com/Roberto-Madrid/dexter-barber',
  });

  assert.equal(masked.branch, branch);
  assert.equal(masked.url, 'https://cursor.com/agents/bc-82f15814-538b-4106-b939-fa1e7e7b0453');
  assert.equal(masked.repoUrl, 'github.com/Roberto-Madrid/dexter-barber');

  // Credential shapes are still masked inside an identifier-valued field.
  assert.equal(redact({ url: `https://x-access-token:${FAKE_KEY}@github.com/o/r` }).url,
    'https://[REDACTED]@github.com/o/r');
  assert.equal(redact({ branch: `feature/${FAKE_KEY}` }).branch, 'feature/[REDACTED]');
});
