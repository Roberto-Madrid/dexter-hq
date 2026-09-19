import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { adaptCanonicalPolicy, isCanonicalPolicy, loadPolicy, normalizeRepoUrl } from '../src/policy.js';
import { validateLaunch } from '../src/validate.js';

/**
 * HQ authors config/dispatch-policy.json in a nested governance form. These
 * tests pin the translation into the flat contract the client consumes, so the
 * two shapes cannot drift apart unnoticed.
 */
const CANONICAL = {
  schema_version: 1,
  kind: 'dispatch-policy',
  api: { base_url: 'https://api.cursor.com' },
  dispatch_records: { directory: '.dexter/dispatch' },
  timeouts: { request_ms: 30000, poll_ms: 900000 },
  credentials: { cursor_api_key_env: 'DEXTER_CURSOR_API_KEY' },
  pull_requests: { auto_create_pr_during_bootstrap: false },
  concurrency_limits: { concurrent_implementation_workers: 2 },
  repository_allowlist: {
    entries: [
      { id: 'hq', repository: 'Roberto-Madrid/dexter-hq', canonical_url: 'https://github.com/Roberto-Madrid/dexter-hq' },
      { id: 'barber', repository: 'Roberto-Madrid/dexter-barber', canonical_url: 'https://github.com/Roberto-Madrid/dexter-barber' },
    ],
  },
  missions: {
    'hq-bootstrap-preflight': { description: 'read-only preflight', repository_ids: ['barber'] },
  },
  model_policy: { discovery: { available_model_ids: ['composer-2.5', 'claude-opus-5'] } },
};

function writeCanonical(overrides = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'dispatch-policy-'));
  mkdirSync(join(cwd, 'config'), { recursive: true });
  writeFileSync(join(cwd, 'config/dispatch-policy.json'), JSON.stringify({ ...CANONICAL, ...overrides }, null, 2));
  return cwd;
}

test('the canonical HQ policy document is recognised and translated', () => {
  assert.equal(isCanonicalPolicy(CANONICAL), true);
  assert.equal(isCanonicalPolicy({ repositoryAllowlist: [] }), false);

  const flat = adaptCanonicalPolicy(CANONICAL);
  assert.deepEqual(flat.repositoryAllowlist, [
    'https://github.com/Roberto-Madrid/dexter-hq',
    'https://github.com/Roberto-Madrid/dexter-barber',
  ]);
  assert.equal(flat.apiKeyEnv, 'DEXTER_CURSOR_API_KEY');
  assert.equal(flat.recordsDir, '.dexter/dispatch');
  assert.equal(flat.maxConcurrentAgents, 2);
  assert.equal(flat.autoCreatePR, false);
  assert.deepEqual(flat.allowedModelIds, ['composer-2.5', 'claude-opus-5']);
});

test('loading the canonical document produces a usable allowlist instead of an empty one', () => {
  const loaded = loadPolicy({ cwd: writeCanonical() });
  assert.equal(loaded.present, true);
  assert.equal(loaded.canonical, true);
  assert.equal(loaded.policy.repositoryAllowlist.length, 2);
});

test('a mission keeps its repository restriction through the translation', () => {
  const { policy } = loadPolicy({ cwd: writeCanonical() });
  const mission = policy.missions['hq-bootstrap-preflight'];
  assert.deepEqual(mission.repositories, ['https://github.com/Roberto-Madrid/dexter-barber']);

  assert.throws(
    () =>
      validateLaunch({
        policy,
        missionId: 'hq-bootstrap-preflight',
        repoUrl: 'https://github.com/Roberto-Madrid/dexter-hq',
        startingRef: 'a'.repeat(40),
        expectedBaseCommit: 'a'.repeat(40),
        modelId: null,
        discoveredModelIds: [],
        activeAgentCount: 0,
        autoCreatePR: false,
      }),
    (err) => err.details.problems.some((p) => p.includes('does not permit repository')),
  );
});

test('allowlist matching ignores the owner-casing difference between the API and git remotes', () => {
  // The API reports `Roberto-Madrid`; git remotes and agent records use `roberto-madrid`.
  assert.equal(
    normalizeRepoUrl('https://github.com/Roberto-Madrid/dexter-barber'),
    normalizeRepoUrl('git@github.com:roberto-madrid/dexter-barber.git'),
  );

  const { policy } = loadPolicy({ cwd: writeCanonical() });
  const plan = validateLaunch({
    policy,
    missionId: 'hq-bootstrap-preflight',
    repoUrl: 'https://github.com/roberto-madrid/dexter-barber',
    startingRef: 'b'.repeat(40),
    expectedBaseCommit: 'b'.repeat(40),
    modelId: 'composer-2.5',
    discoveredModelIds: ['composer-2.5'],
    activeAgentCount: 0,
    autoCreatePR: false,
  });
  assert.equal(plan.normalizedRepo, 'github.com/roberto-madrid/dexter-barber');
});
