import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAgent } from '../supervisor/agentselection.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const HOUR = 3600000;
const agent = (name, over = {}) => ({ agent: name, allowed: true, freeSlot: true, reserve: false, out: false,
  weekly: { used: 0.2, resetsAt: NOW + 72 * HOUR }, short: { used: 0.1, resetsAt: NOW + 3 * HOUR },
  rate: { weekly: 0, short: 0 }, expected: { weekly: 0.04, short: 0.08 }, costSource: 'history', ...over });
const pick = (candidates, pin) => chooseAgent({ now: NOW, candidates, pin });

test('agent choice is table driven over synthetic plan shares', () => {
  const cases = [
    { name: 'large plan takes costly implement and fix', candidates: [agent('A', { expected: { weekly: 0.02, short: 0.04 } }), agent('B', { expected: { weekly: 0.12, short: 0.2 } })], want: 'A' },
    { name: 'swapping plan-relative costs mirrors the outcome', candidates: [agent('A', { expected: { weekly: 0.12, short: 0.2 } }), agent('B', { expected: { weekly: 0.02, short: 0.04 } })], want: 'B' },
    { name: 'a cheap job may use the smaller plan', candidates: [agent('A', { expected: { weekly: 0.08, short: 0.14 } }), agent('B', { expected: { weekly: 0.01, short: 0.02 } })], want: 'B' },
    { name: 'a config-only third agent participates', candidates: [agent('A', { expected: { weekly: 0.08, short: 0.14 } }), agent('B', { expected: { weekly: 0.06, short: 0.1 } }), agent('C', { expected: { weekly: 0.01, short: 0.02 } })], want: 'C' },
    { name: 'short room skips a job too large to finish', candidates: [agent('A', { short: { used: 0.95, resetsAt: NOW + HOUR }, expected: { weekly: 0.01, short: 0.1 } }), agent('B')], want: 'B' },
    { name: 'rising burn moves work before reserve', candidates: [agent('A', { rate: { weekly: 0.02, short: 0.1 } }), agent('B', { rate: { weekly: 0, short: 0 } })], want: 'B' },
    { name: 'a full preferred slot uses the other agent', candidates: [agent('A', { freeSlot: false, pin: 'preferred' }), agent('B')], pin: { preferred: 'A' }, want: 'B' },
    { name: 'a required pin waits', candidates: [agent('A', { freeSlot: false }), agent('B')], pin: { required: 'A' }, want: null }
  ];
  for (const c of cases) {
    const result = pick(c.candidates, c.pin);
    assert.equal(result.agent, c.want, c.name);
    assert.equal(result.candidates.length, c.candidates.length, `${c.name}: all candidates are visible`);
  }
});

test('configured default cost is visible in the reason and reserve/out candidates cannot win', () => {
  const result = pick([agent('A', { reserve: true }), agent('B', { costSource: 'configured-default' })]);
  assert.equal(result.agent, 'B');
  assert.equal(result.candidates[0].rule, 'at or below reserve');
  assert.equal(result.candidates[1].costSource, 'configured-default');
  assert.match(result.rule, /expected cost/);
});
