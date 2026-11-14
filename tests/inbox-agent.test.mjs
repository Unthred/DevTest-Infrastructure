// Issue #1348: the pure choice of the agent that takes an approved Inbox prompt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseInboxAgent } from '../supervisor/inboxagent.mjs';

const agents = names => names.map(n => [n, { provider: n }]);
const base = { limitedOf: () => ({ out: false }), providerSlotFull: () => false, usedBy: {}, modes: {}, admits: () => ({ ok: true }) };

test('valid: the first agent that is free and admitted is chosen', () => {
  assert.deepEqual(chooseInboxAgent({ ...base, agents: agents(['a', 'b']), modes: { a: {}, b: {} } }), { agent: 'a', allowanceRefusal: null });
});

test('boundary: a first agent refused by admits is skipped, a later one is chosen and the refusal is cleared', () => {
  const admits = mode => (mode.refuse ? { ok: false, why: 'first refusal' } : { ok: true });
  const out = chooseInboxAgent({ ...base, agents: agents(['a', 'b']), modes: { a: { refuse: true }, b: {} }, admits });
  assert.deepEqual(out, { agent: 'b', allowanceRefusal: null });
});

test('no agent and no refusal when every agent has a usage limit or a full provider slot', () => {
  const admits = () => assert.fail('admits must not be asked for a skipped agent');
  const out = chooseInboxAgent({
    ...base, agents: agents(['a', 'b']), limitedOf: n => ({ out: n === 'a' }), providerSlotFull: p => p === 'b', modes: { a: {}, b: {} }, admits
  });
  assert.deepEqual(out, { agent: null, allowanceRefusal: null });
});

test('invalid: every agent refused by admits gives the first refusal', () => {
  const admits = mode => ({ ok: false, why: mode.why });
  const out = chooseInboxAgent({ ...base, agents: agents(['a', 'b']), modes: { a: { why: 'one' }, b: { why: 'two' } }, admits });
  assert.deepEqual(out, { agent: null, allowanceRefusal: 'one' });
});

test('an agent without a mode is admitted without asking admits', () => {
  const out = chooseInboxAgent({ ...base, agents: agents(['a']), modes: undefined, admits: () => assert.fail('not asked') });
  assert.equal(out.agent, 'a');
});
