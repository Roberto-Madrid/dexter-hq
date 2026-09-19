import test from 'node:test';
import assert from 'node:assert/strict';
import { validateLaunch } from '../src/validate.js';
import { normalizeRepoUrl } from '../src/policy.js';
import { BASE_SHA, HQ_REPO_URL, POLICY_FIXTURE, REPO_URL } from './helpers/harness.js';

const BASE_ARGS = {
  policy: POLICY_FIXTURE,
  missionId: 'barber-recovery',
  repoUrl: REPO_URL,
  startingRef: BASE_SHA,
  expectedBaseCommit: BASE_SHA,
  modelId: 'composer-2',
  discoveredModelIds: ['composer-2', 'claude-4.6-sonnet-thinking'],
  activeAgentCount: 0,
  autoCreatePR: false,
};

function problemsFrom(overrides) {
  try {
    validateLaunch({ ...BASE_ARGS, ...overrides });
  } catch (err) {
    return err.details.problems.join(' | ');
  }
  return null;
}

test('a fully specified launch passes validation', () => {
  const plan = validateLaunch(BASE_ARGS);
  assert.equal(plan.expectedBaseCommit, BASE_SHA.toLowerCase());
  assert.deepEqual(plan.requestedModel, { id: 'composer-2' });
  assert.equal(plan.autoCreatePR, false);
  assert.equal(plan.slots.used, 0);
  assert.equal(plan.slots.limit, 2);
});

test('repository must be on the allowlist', () => {
  assert.match(problemsFrom({ repoUrl: 'https://github.com/someone/else' }), /not in repositoryAllowlist/);
});

test('the old repository name is not silently accepted', () => {
  assert.match(problemsFrom({ repoUrl: 'https://github.com/Roberto-Madrid/Dexter' }), /not in repositoryAllowlist/);
});

test('repository matching ignores case, .git suffix and scheme noise', () => {
  assert.equal(normalizeRepoUrl('git@github.com:Roberto-Madrid/dexter-barber.git'), normalizeRepoUrl(REPO_URL));
  assert.equal(normalizeRepoUrl('github.com/roberto-madrid/dexter-barber/'), normalizeRepoUrl(REPO_URL));
  assert.equal(problemsFrom({ repoUrl: 'git@github.com:Roberto-Madrid/dexter-barber.git' }), null);
});

test('mission must exist and must permit the repository', () => {
  assert.match(problemsFrom({ missionId: 'not-a-mission' }), /not defined in the policy missions map/);
  assert.match(problemsFrom({ missionId: 'bootstrap' }), /does not permit repository/);
  assert.equal(problemsFrom({ missionId: 'bootstrap', repoUrl: HQ_REPO_URL }), null);
});

test('base commit must be a full SHA and must agree with an explicit SHA ref', () => {
  assert.match(problemsFrom({ expectedBaseCommit: undefined }), /must be a full 40-character commit SHA/);
  assert.match(problemsFrom({ expectedBaseCommit: '53fac96' }), /must be a full 40-character commit SHA/);
  assert.match(
    problemsFrom({ startingRef: 'a'.repeat(40) }),
    /--starting-ref \(aaaaaaaa.*\) and --base-commit \(53fac96.*\) disagree/,
  );
});

test('a moving branch ref is refused unless explicitly allowed', () => {
  assert.match(problemsFrom({ startingRef: 'main' }), /is a moving ref/);
  assert.equal(problemsFrom({ startingRef: 'main', allowBranchRef: true }), null);
});

test('model ids must come from discovery, not from a remembered alias', () => {
  assert.match(problemsFrom({ modelId: 'claude-4-sonnet-thinking' }), /was not returned by GET \/v1\/models/);
  assert.match(problemsFrom({ modelId: 'composer-2', discoveredModelIds: null }), /discovery data unavailable/);
});

test('a policy allowedModelIds list further narrows discovery', () => {
  const policy = { ...POLICY_FIXTURE, allowedModelIds: ['claude-4.6-sonnet-thinking'] };
  assert.match(problemsFrom({ policy }), /not in the policy allowedModelIds/);
});

test('omitting the model is allowed and reports a null requested model', () => {
  const plan = validateLaunch({ ...BASE_ARGS, modelId: null, discoveredModelIds: [] });
  assert.equal(plan.requestedModel, null);
});

test('dispatch slots are enforced and an unknown count blocks the launch', () => {
  assert.match(problemsFrom({ activeAgentCount: 2 }), /2\/2 dispatch slots already in use/);
  assert.match(problemsFrom({ activeAgentCount: null }), /active agent count is unknown/);
});

test('autoCreatePR cannot be turned on against a policy that keeps it off', () => {
  assert.match(problemsFrom({ autoCreatePR: true }), /automatic PR creation off/);
  const plan = validateLaunch({ ...BASE_ARGS, policy: { ...POLICY_FIXTURE, autoCreatePR: true }, autoCreatePR: true });
  assert.equal(plan.autoCreatePR, true);
});

test('all failing preconditions are reported together', () => {
  const problems = problemsFrom({ repoUrl: 'https://github.com/x/y', missionId: 'nope', expectedBaseCommit: 'zzz' });
  assert.equal(problems.split(' | ').length >= 3, true);
});
