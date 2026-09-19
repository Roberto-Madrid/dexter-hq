import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_AGENT_STATUSES, KNOWN_RUN_STATUSES, State, mapAgentStatus, mapRunStatus } from '../src/states.js';

test('every documented run status maps to a distinct canonical state', () => {
  const expected = {
    CREATING: { state: State.QUEUED, terminal: false },
    RUNNING: { state: State.RUNNING, terminal: false },
    FINISHED: { state: State.COMPLETED, terminal: true },
    ERROR: { state: State.FAILED, terminal: true },
    CANCELLED: { state: State.CANCELLED, terminal: true },
    EXPIRED: { state: State.FAILED, terminal: true },
  };
  assert.deepEqual(KNOWN_RUN_STATUSES.sort(), Object.keys(expected).sort());
  for (const [raw, want] of Object.entries(expected)) {
    const got = mapRunStatus(raw);
    assert.equal(got.state, want.state, `${raw} state`);
    assert.equal(got.terminal, want.terminal, `${raw} terminal`);
    assert.equal(got.recognized, true);
  }
  assert.equal(mapRunStatus('EXPIRED').reason, 'expired');
});

test('unrecognised and missing run statuses become unknown, never guessed', () => {
  for (const raw of [null, undefined, '', 'PENDING_APPROVAL', 42]) {
    const got = mapRunStatus(raw);
    assert.equal(got.state, State.UNKNOWN);
    assert.equal(got.terminal, false);
    assert.equal(got.recognized, false);
  }
});

test('run status matching is case-insensitive but preserves the canonical raw value', () => {
  assert.equal(mapRunStatus('finished').state, State.COMPLETED);
  assert.equal(mapRunStatus('finished').raw, 'FINISHED');
});

test('agent statuses gate follow-up submission', () => {
  assert.deepEqual(KNOWN_AGENT_STATUSES.sort(), ['ACTIVE', 'ARCHIVED', 'IDLE']);
  assert.equal(mapAgentStatus('IDLE').acceptsFollowUp, true);
  assert.equal(mapAgentStatus('ACTIVE').acceptsFollowUp, false);
  assert.equal(mapAgentStatus('ARCHIVED').acceptsFollowUp, false);
  assert.equal(mapAgentStatus('ARCHIVED').terminal, true);
  assert.equal(mapAgentStatus('WHATEVER').state, State.UNKNOWN);
  assert.equal(mapAgentStatus('WHATEVER').acceptsFollowUp, false);
});
