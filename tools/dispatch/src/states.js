/**
 * Canonical lifecycle vocabulary. HTTP 200 is not completion — callers must
 * branch on these values, never on the transport status code.
 */
export const State = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
  UNKNOWN: 'unknown',
});

/**
 * Run statuses confirmed from the live endpoints documentation
 * (https://cursor.com/docs/cloud-agent/api/endpoints, fetched 2026-09-19).
 * CREATING/RUNNING/FINISHED appear in responses and prose; ERROR, CANCELLED
 * and EXPIRED are named as the terminal set alongside FINISHED in "Get A Run".
 */
const RUN_STATE = new Map([
  ['CREATING', { state: State.QUEUED, terminal: false }],
  ['RUNNING', { state: State.RUNNING, terminal: false }],
  ['FINISHED', { state: State.COMPLETED, terminal: true }],
  ['ERROR', { state: State.FAILED, terminal: true, reason: 'error' }],
  ['CANCELLED', { state: State.CANCELLED, terminal: true, reason: 'cancelled' }],
  ['EXPIRED', { state: State.FAILED, terminal: true, reason: 'expired' }],
]);

/** Agent lifecycle statuses, documented under "Get An Agent". */
const AGENT_STATE = new Map([
  ['ACTIVE', { state: 'active', acceptsFollowUp: false, terminal: false }],
  ['IDLE', { state: 'idle', acceptsFollowUp: true, terminal: false }],
  ['ARCHIVED', { state: 'archived', acceptsFollowUp: false, terminal: true }],
]);

export const KNOWN_RUN_STATUSES = [...RUN_STATE.keys()];
export const KNOWN_AGENT_STATUSES = [...AGENT_STATE.keys()];

/** Unrecognised statuses map to `unknown` and are never guessed into a state. */
export function mapRunStatus(raw) {
  const key = typeof raw === 'string' ? raw.toUpperCase() : null;
  const hit = key ? RUN_STATE.get(key) : undefined;
  if (!hit) {
    return { raw: raw ?? null, state: State.UNKNOWN, terminal: false, reason: 'unrecognized_status', recognized: false };
  }
  return { raw: key, state: hit.state, terminal: hit.terminal, reason: hit.reason ?? null, recognized: true };
}

export function mapAgentStatus(raw) {
  const key = typeof raw === 'string' ? raw.toUpperCase() : null;
  const hit = key ? AGENT_STATE.get(key) : undefined;
  if (!hit) {
    return { raw: raw ?? null, state: State.UNKNOWN, acceptsFollowUp: false, terminal: false, recognized: false };
  }
  return { raw: key, state: hit.state, acceptsFollowUp: hit.acceptsFollowUp, terminal: hit.terminal, recognized: true };
}
