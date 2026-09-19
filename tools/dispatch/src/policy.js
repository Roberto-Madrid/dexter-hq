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

/**
 * HQ's `config/dispatch-policy.json` is authored in a nested, documented form
 * (`kind: "dispatch-policy"`) that carries governance context this client does
 * not need. The flat keys below are the client's contract; they are derived
 * from the canonical document rather than duplicated inside it, so the two
 * shapes cannot drift apart.
 */
export function isCanonicalPolicy(raw) {
  return Boolean(raw) && typeof raw === 'object' && raw.kind === 'dispatch-policy';
}

function canonicalRepoUrls(raw) {
  const entries = raw.repository_allowlist?.entries;
  if (!Array.isArray(entries)) return [];
  return entries.map((e) => e?.canonical_url ?? e?.repository).filter((u) => typeof u === 'string' && u !== '');
}

function canonicalMissions(raw) {
  const missions = raw.missions;
  if (!missions || typeof missions !== 'object' || Array.isArray(missions)) return {};
  const byId = new Map();
  for (const entry of raw.repository_allowlist?.entries ?? []) {
    if (entry?.id) byId.set(entry.id, entry.canonical_url ?? entry.repository);
  }
  const out = {};
  for (const [id, mission] of Object.entries(missions)) {
    const fromIds = (mission?.repository_ids ?? []).map((rid) => byId.get(rid)).filter(Boolean);
    const explicit = (mission?.repositories ?? []).filter((u) => typeof u === 'string' && u !== '');
    out[id] = { description: mission?.description ?? null, repositories: [...fromIds, ...explicit] };
  }
  return out;
}

export function adaptCanonicalPolicy(raw) {
  const flat = {};
  const apiKeyEnv = raw.credentials?.cursor_api_key_env;
  if (typeof apiKeyEnv === 'string') flat.apiKeyEnv = apiKeyEnv;

  const apiBase = raw.api?.base_url;
  if (typeof apiBase === 'string') flat.apiBase = apiBase;

  const recordsDir = raw.dispatch_records?.directory;
  if (typeof recordsDir === 'string') flat.recordsDir = recordsDir;

  const repos = canonicalRepoUrls(raw);
  if (repos.length > 0) flat.repositoryAllowlist = repos;

  const missions = canonicalMissions(raw);
  if (Object.keys(missions).length > 0) flat.missions = missions;

  const modelIds = raw.model_policy?.discovery?.available_model_ids;
  if (Array.isArray(modelIds) && modelIds.length > 0) flat.allowedModelIds = modelIds;

  const concurrent = raw.concurrency_limits?.concurrent_implementation_workers;
  if (typeof concurrent === 'number') flat.maxConcurrentAgents = concurrent;

  // Bootstrap keeps automatic PR creation off; the canonical field is the switch.
  const autoPr = raw.pull_requests?.auto_create_pr_during_bootstrap;
  if (typeof autoPr === 'boolean') flat.autoCreatePR = autoPr;

  const requestMs = raw.timeouts?.request_ms;
  if (typeof requestMs === 'number') flat.requestTimeoutMs = requestMs;
  const pollMs = raw.timeouts?.poll_ms;
  if (typeof pollMs === 'number') flat.pollTimeoutMs = pollMs;

  return flat;
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
  // Derived values win: `missions` exists in both shapes, and the canonical
  // nested form carries its repository restriction under `repository_ids`.
  // Letting the raw block through would drop that restriction silently.
  const derived = isCanonicalPolicy(raw) ? adaptCanonicalPolicy(raw) : {};
  const merged = { ...raw, ...derived };
  validatePolicyShape(merged, absolute);
  return { policy: { ...DEFAULT_POLICY, ...merged }, source: absolute, present: true, canonical: isCanonicalPolicy(raw) };
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
