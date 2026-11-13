// Issue #1166: the agent choice rule as a pure function, table driven with synthetic agents (no real agent names).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAgent, describeChoice, spareOf } from '../supervisor/agentchoice.mjs';

const cand = (agent, o = {}) => ({ agent, job: 'implement #7', slotFree: true, eligible: true, used: 0.1, rate: 0, hoursToReset: 100, short: { used: 0.1 },
  share: { weekly: 0.02, short: 0.1, source: 'history', note: 'n' }, requiredAgent: null, preferredAgent: null, credit: false, ...o });
const withShare = (weekly, short = weekly * 7) => ({ weekly, short, source: 'history', note: 'n' });
const pick = (...c) => chooseAgent(c);

test('the large plan takes the expensive job types, the small one a type that is cheaper there', () => {
  // A is large: an implement is 0.4% of its week, 4% of B's. A fix is 0.2% of A's week but only 0.1% of B's week.
  const a = share => cand('A', { share });
  const b = share => cand('B', { share });
  assert.equal(pick(a(withShare(0.004)), b(withShare(0.04))).chosen, 'A', 'implement');
  assert.equal(pick(a(withShare(0.002)), b(withShare(0.01))).chosen, 'A', 'fix');
  assert.equal(pick(a(withShare(0.002)), b(withShare(0.0005))).chosen, 'B', 'a job type that is cheap on the small plan goes there');
});

test('swapping which plan is large mirrors the outcome with no other change', () => {
  const big = withShare(0.004), small = withShare(0.04);
  assert.equal(pick(cand('A', { share: big }), cand('B', { share: small })).chosen, 'A');
  assert.equal(pick(cand('A', { share: small }), cand('B', { share: big })).chosen, 'B');
});

test('a third agent added by data alone competes on the same numbers', () => {
  const r = pick(cand('A', { share: withShare(0.04) }), cand('B', { share: withShare(0.03) }), cand('C', { share: withShare(0.005) }));
  assert.equal(r.chosen, 'C');
  assert.equal(r.candidates.length, 3);
  assert.equal(r.rule, 'least-plan-cost-for-spare');
});

test('equal cost goes to config order; a preferred pin breaks the tie; fewer planned starts break it before order', () => {
  assert.equal(pick(cand('A'), cand('B')).chosen, 'A');
  assert.equal(pick(cand('A'), cand('B')).rule, 'config-order');
  assert.equal(pick(cand('A', { preferredAgent: 'B' }), cand('B', { preferredAgent: 'B' })).chosen, 'B');
  assert.equal(pick(cand('A', { preferredAgent: 'B' }), cand('B', { preferredAgent: 'B' })).rule, 'preferred-pin');
  const planned = pick(cand('A', { planned: 1 }), cand('B', { planned: 0 }));
  assert.equal(planned.chosen, 'B');
  assert.equal(planned.rule, 'fewer-planned');
});

test('a short window that cannot cover the job skips the agent; the same agent is used again for a small job', () => {
  const nearlyFull = { used: 0.97 };
  const big = pick(cand('A', { short: nearlyFull, share: withShare(0.001, 0.1) }), cand('B', { share: withShare(0.05, 0.1) }));
  assert.equal(big.chosen, 'B');
  assert.match(big.candidates[0].skipped, /short window cannot cover the job \(3% left, the job needs about 10%\)/);
  const small = pick(cand('A', { short: nearlyFull, share: withShare(0.001, 0.01) }), cand('B', { share: withShare(0.05, 0.1) }));
  assert.equal(small.chosen, 'A');
});

test('a rising recent rate moves new work to the other agent before the reserve is reached', () => {
  assert.equal(pick(cand('A'), cand('B')).chosen, 'A');
  const rising = pick(cand('A', { rate: 0.008 }), cand('B'));   // 0.1 used + 0.8%/h over 100 h: nothing is left by the reset
  assert.equal(rising.chosen, 'B');
  assert.equal(spareOf(cand('A', { rate: 0.008 })).toFixed(6), (1 - 0.1 - 0.8).toFixed(6));
});

test('a full slot or an ineligible agent never wins; a preferred agent with a full slot loses to the free one', () => {
  const r = pick(cand('A', { slotFree: false, preferredAgent: 'A' }), cand('B', { preferredAgent: 'A' }));
  assert.equal(r.chosen, 'B');
  assert.equal(r.candidates[0].skipped, 'no free slot for this role');
  const held = pick(cand('A', { eligible: false, why: 'below its reserve' }), cand('B'));
  assert.equal(held.candidates[0].skipped, 'below its reserve');
});

test('a required pin waits for its agent: nobody else runs the job', () => {
  const waits = pick(cand('A', { requiredAgent: 'B', share: withShare(0.001) }), cand('B', { requiredAgent: 'B', slotFree: false }));
  assert.equal(waits.chosen, null);
  assert.equal(waits.rule, 'none-qualifies');
  assert.match(waits.candidates[0].skipped, /pinned to B/);
  const runs = pick(cand('A', { requiredAgent: 'B' }), cand('B', { requiredAgent: 'B', share: withShare(0.5, 0.5) }));
  assert.equal(runs.chosen, 'B');
  assert.equal(runs.rule, 'required-pin');
});

test('an agent with no spare ranks after one that has some; an unknown reading ranks last; nobody qualifying leaves the job waiting', () => {
  assert.equal(pick(cand('A', { used: 1 }), cand('B', { used: 0.9 })).chosen, 'B');
  assert.equal(pick(cand('A', { used: null }), cand('B', { used: 0.9 })).chosen, 'B');
  assert.equal(pick(cand('A', { eligible: false }), cand('B', { slotFree: false })).chosen, null);
});

test('the credit agent takes work only when no plan agent can', () => {
  const both = pick(cand('A', { credit: true, share: withShare(0.0001) }), cand('B'));
  assert.equal(both.chosen, 'B');
  assert.match(both.candidates[0].skipped, /credit agent takes work only when they are held/);
  assert.equal(pick(cand('A', { credit: true }), cand('B', { eligible: false })).chosen, 'A');
});

test('every choice carries a reason naming each candidate figure, the source of the cost and the deciding rule', () => {
  const r = pick(cand('A', { share: { weekly: 0.03, short: 0.2, source: 'default', note: 'history too short' }, rate: 0.01, hoursToReset: 10 }), cand('B', { slotFree: false }));
  const text = describeChoice(r);
  assert.match(text, /^A runs implement #7: the only agent that can take it/);
  assert.match(text, /A: spare 80%, job about 3% of its week \(default\), rate 1%\/h, short window room 90%, slot free/);
  assert.match(text, /B: skipped, no free slot for this role/);
  assert.match(describeChoice(pick(cand('A', { eligible: false }))), /^the job waits: no agent qualifies/);
});
