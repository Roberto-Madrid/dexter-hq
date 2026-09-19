import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetSecrets } from '../../src/redact.js';

export const HANG = Symbol('hang');

/**
 * Offline fetch double. Routes are keyed by "METHOD /path". A handler may be a
 * literal response, a function, an Error to throw, or HANG to never settle
 * (used to exercise the abort/timeout path).
 */
export function createMockFetch(routes) {
  const calls = [];
  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const key = `${init.method ?? 'GET'} ${parsed.pathname}`;
    const call = {
      key,
      method: init.method ?? 'GET',
      path: parsed.pathname,
      query: Object.fromEntries(parsed.searchParams),
      headers: init.headers ?? {},
      body: init.body ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);

    const handler = routes[key];
    if (handler === undefined) throw new Error(`mock: no route for ${key}`);

    const value = typeof handler === 'function' ? await handler(call, calls) : handler;
    if (value === HANG) {
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }
    if (value instanceof Error) throw value;
    return new Response(value.body === undefined ? '' : JSON.stringify(value.body), {
      status: value.status ?? 200,
      headers: { 'content-type': 'application/json', ...(value.headers ?? {}) },
    });
  }
  return { fetchImpl, calls };
}

export function countCalls(calls, key) {
  return calls.filter((c) => c.key === key).length;
}

export const REPO_URL = 'https://github.com/Roberto-Madrid/dexter-barber';
export const HQ_REPO_URL = 'https://github.com/Roberto-Madrid/dexter-hq';
export const BASE_SHA = '53fac961c485b8ff6799b838a062f50905af0682';

export const POLICY_FIXTURE = {
  apiBase: 'https://api.cursor.test',
  apiKeyEnv: 'DEXTER_CURSOR_API_KEY',
  autoCreatePR: false,
  maxConcurrentAgents: 2,
  recordsDir: '.dexter/dispatch',
  repositoryAllowlist: [REPO_URL, HQ_REPO_URL],
  allowedModelIds: [],
  missions: {
    'barber-recovery': { description: 'Barber app recovery', repositories: [REPO_URL] },
    bootstrap: { description: 'HQ bootstrap', repositories: [HQ_REPO_URL] },
  },
  requestTimeoutMs: 50,
  pollTimeoutMs: 1000,
};

/** Creates an isolated workspace with a policy file and prompt file. */
export function makeWorkspace(policy = POLICY_FIXTURE) {
  resetSecrets();
  const cwd = mkdtempSync(join(tmpdir(), 'dispatch-test-'));
  mkdirSync(join(cwd, 'config'), { recursive: true });
  writeFileSync(join(cwd, 'config', 'dispatch-policy.json'), JSON.stringify(policy, null, 2));
  const promptFile = join(cwd, 'task.md');
  writeFileSync(promptFile, 'Implement the approved bounded task.');
  return { cwd, promptFile, policyPath: join(cwd, 'config', 'dispatch-policy.json') };
}

export const FAKE_KEY = 'key_TestOnlyPlaceholder1234567890abcdefXYZ';

export function envWithKey(extra = {}) {
  return { DEXTER_CURSOR_API_KEY: FAKE_KEY, ...extra };
}

export function captureStreams() {
  const out = [];
  const err = [];
  return {
    stdout: { write: (s) => out.push(s) },
    stderr: { write: (s) => err.push(s) },
    outText: () => out.join(''),
    errText: () => err.join(''),
    json: () => JSON.parse(out.join('')),
  };
}

export const noSleep = async () => {};
export const fixedRandom = () => 0.5;

export const MODELS_RESPONSE = {
  status: 200,
  body: {
    items: [
      { id: 'composer-2', displayName: 'Composer 2', aliases: ['composer'], variants: [{ params: [], isDefault: true }] },
      { id: 'claude-4.6-sonnet-thinking', displayName: 'Claude 4.6 Sonnet (Thinking)', variants: [{ params: [], isDefault: true }] },
    ],
  },
};

export const EMPTY_AGENTS = { status: 200, body: { items: [] } };

export function agentFixture(overrides = {}) {
  return {
    id: 'bc-00000000-0000-0000-0000-000000000001',
    name: 'barber-recovery [task:task-001]',
    status: 'ACTIVE',
    env: { type: 'cloud' },
    repos: [{ url: REPO_URL, startingRef: BASE_SHA }],
    workOnCurrentBranch: false,
    autoCreatePR: false,
    url: 'https://cursor.com/agents/bc-00000000-0000-0000-0000-000000000001',
    createdAt: '2026-09-19T04:30:00.000Z',
    updatedAt: '2026-09-19T04:30:00.000Z',
    latestRunId: 'run-00000000-0000-0000-0000-000000000001',
    ...overrides,
  };
}

export function runFixture(overrides = {}) {
  return {
    id: 'run-00000000-0000-0000-0000-000000000001',
    agentId: 'bc-00000000-0000-0000-0000-000000000001',
    status: 'CREATING',
    createdAt: '2026-09-19T04:30:00.000Z',
    updatedAt: '2026-09-19T04:30:00.000Z',
    ...overrides,
  };
}
