import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PolicyError, ValidationError } from './errors.js';

/**
 * Defaults mirror the pre-existing `dexter-barber/.cursor/dispatch.json`
 * (`apiKeyEnv`, `apiBase`, `autoCreatePR`). They are fallbacks only: any
 * command that needs an allowlist or a mission requires the real policy file.
 *
 * The schema this client reads is documented in tools/dispatch/README.md.
 * This tool never writes `config/dispatch-policy.json` — another owner does.
 */
export const DEFAULT_POLICY = Object.freeze({
  apiBase: 'https://api.cursor.com',
  apiKeyEnv: 'DEXTER_CURSOR_API_KEY',
  autoCreatePR: false,
  maxConcurrentAgents: 2,
  recordsDir: '.dexter/dispatch',
  repositoryAllowlist: [],
  allowedModelIds: [],
  missions: {},
  requestTimeoutMs: 30000,
  pollTimeoutMs: 900000,
});

export const DEFAULT_POLICY_PATH = 'config/dispatch-policy.json';

/** Case-insensitive host/path comparison; strips `.git`, trailing slash, scheme noise. */
export function normalizeRepoUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  let s = url.trim();
  s = s.replace(/^git\+/, '');
  s = s.replace(/^git@([^:]+):/, 'https://$1/');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  const path = parsed.pathname.replace(/\.git$/i, '').replace(/\/+$/, '');
  return `${parsed.hostname.toLowerCase()}${path.toLowerCase()}`;
}

function assertType(value, kind, field, errors) {
  if (value === undefined) return;
  const actual = Array.isArray(value) ? 'array' : typeof value;
  if (actual !== kind) errors.push(`${field}: expected ${kind}, got ${actual}`);
}

export function validatePolicyShape(raw, source) {
  const errors = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new PolicyError(`Dispatch policy at "${source}" must be a JSON object.`);
  }
  assertType(raw.apiBase, 'string', 'apiBase', errors);
  assertType(raw.apiKeyEnv, 'string', 'apiKeyEnv', errors);
  assertType(raw.autoCreatePR, 'boolean', 'autoCreatePR', errors);
  assertType(raw.maxConcurrentAgents, 'number', 'maxConcurrentAgents', errors);
  assertType(raw.recordsDir, 'string', 'recordsDir', errors);
  assertType(raw.repositoryAllowlist, 'array', 'repositoryAllowlist', errors);
  assertType(raw.allowedModelIds, 'array', 'allowedModelIds', errors);
  assertType(raw.missions, 'object', 'missions', errors);
  assertType(raw.requestTimeoutMs, 'number', 'requestTimeoutMs', errors);
  assertType(raw.pollTimeoutMs, 'number', 'pollTimeoutMs', errors);
  if (raw.apiKeyEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(String(raw.apiKeyEnv))) {
    errors.push('apiKeyEnv: must be an UPPER_SNAKE_CASE environment variable name');
  }
  if (errors.length > 0) {
    throw new PolicyError(`Dispatch policy at "${source}" is malformed.`, { problems: errors });
  }
  return raw;
}

/**
 * Reads the policy defensively. A missing file is not fatal here — callers
 * decide via `requirePolicyFor` whether the defaults are sufficient.
 */
export function loadPolicy({ path = DEFAULT_POLICY_PATH, cwd = process.cwd(), readFile = readFileSync } = {}) {
  const absolute = resolve(cwd, path);
  let text;
  try {
    text = readFile(absolute, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { policy: { ...DEFAULT_POLICY }, source: absolute, present: false };
    }
    throw new PolicyError(`Cannot read dispatch policy at "${absolute}": ${err.code ?? 'read error'}.`);
  }

  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new PolicyError(`Dispatch policy at "${absolute}" is not valid JSON: ${err.message}`);
  }
  validatePolicyShape(raw, absolute);
  return { policy: { ...DEFAULT_POLICY, ...raw }, source: absolute, present: true };
}

/** Fails loudly when a command genuinely needs the file another owner writes. */
export function requirePolicy(loaded, commandName) {
  if (!loaded.present) {
    throw new PolicyError(
      `"${commandName}" requires the dispatch policy file, which is absent at "${loaded.source}". ` +
        `This tool does not create it by design — see the "Dispatch policy contract" section of tools/dispatch/README.md ` +
        `for the exact schema, or pass --policy <path>.`,
      { expectedPath: loaded.source },
    );
  }
  if (!Array.isArray(loaded.policy.repositoryAllowlist) || loaded.policy.repositoryAllowlist.length === 0) {
    throw new ValidationError(
      `Dispatch policy at "${loaded.source}" has an empty "repositoryAllowlist"; refusing to launch against an unapproved repository.`,
    );
  }
  return loaded.policy;
}
