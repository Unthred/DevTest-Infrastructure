// Issue #1107: the classifier and the park rules for infrastructure faults. Pure functions; no model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as faults from '../supervisor/faults.mjs';

const ended = (over = {}) => ({ status: 'blocked', lastEvent: 'crash', usage: {}, ...over });
const MIN = 60000;

test('classifier: each named infrastructure cause', () => {
  const cases = [
    [ended({ lastEvent: 'auth_error' }), 'auth_error'],
    [ended({ lastEvent: 'preflight_failed' }), 'launcher'],
    [ended({ lastEvent: 'usage_limit' }), 'usage_limit'],
    [ended({ lastEvent: 'transient_rate_limit' }), 'usage_limit'],
    [ended({ lastEvent: 'retry_exhausted', usageLimitHits: 2 }), 'usage_limit'],
    [ended({ lastEvent: 'network_error' }), 'network'],
    [ended({ lastEvent: 'incomplete', incompleteReason: { cause: 'incomplete', detail: 'HTTP 529 overloaded_error from the API' } }), 'provider_outage'],
    [ended({ lastEvent: 'crash', incompleteReason: { cause: 'crash', detail: 'write failed: ENOSPC no space left on device' } }), 'host_resources'],
    [ended({ lastEvent: 'crash' }), 'other_infra'],
  ];
  for (const [job, cause] of cases) assert.deepEqual([faults.classifyEnd(job).kind, faults.classifyEnd(job).cause], ['infra', cause], JSON.stringify(job));
  for (const cause of ['auth_error', 'launcher', 'usage_limit', 'network', 'provider_outage', 'host_resources', 'other_infra']) assert.ok(faults.INFRA_CAUSES.includes(cause));
});

test('classifier: a named fault is infrastructure even when tokens were spent', () => {
  const c = faults.classifyEnd(ended({ lastEvent: 'network_error', usage: { inputTokens: 900, outputTokens: 40 } }));
  assert.deepEqual([c.kind, c.cause], ['infra', 'network']);
});

test('classifier: work outcomes', () => {
  assert.deepEqual(faults.classifyEnd({ status: 'completed' }), { kind: 'work', cause: 'completed' });
  assert.equal(faults.classifyEnd(ended({ lastEvent: 'incomplete', incompleteReason: { cause: 'postcondition_not_met', detail: 'no new head' } })).kind, 'work');
  assert.equal(faults.classifyEnd(ended({ lastEvent: 'context_limit' })).kind, 'work');
  // An unknown end counts as work only when the agent ran.
  const ran = faults.classifyEnd(ended({ lastEvent: 'crash', usage: { inputTokens: 10, outputTokens: 5 } }));
  assert.deepEqual([ran.kind, ran.cause], ['work', 'crash']);
});

test('classifier: a zero token end with no output is infrastructure by default', () => {
  for (const usage of [undefined, {}, { inputTokens: 0, outputTokens: 0 }, { inputTokens: -4, outputTokens: 'x' }]) {
    const c = faults.classifyEnd(ended({ lastEvent: 'something_new', usage }));
    assert.deepEqual([c.kind, c.cause], ['infra', 'other_infra']);
  }
});

test('classifier: a deliberate stop is neither; malformed or missing records are infrastructure', () => {
  assert.equal(faults.classifyEnd(ended({ lastEvent: 'manual_stop' })).kind, 'none');
  for (const bad of [null, undefined, 'x', 7, [], {}, { status: 5 }]) assert.deepEqual([faults.classifyEnd(bad).kind, faults.classifyEnd(bad).cause], ['infra', 'other_infra']);
  assert.doesNotThrow(() => faults.classifyEnd({ status: 'failed', incompleteReason: 'text', usage: 'x' }));
});

test('counting: only work outcomes are attempts', () => {
  assert.equal(faults.countsAsAttempt(faults.classifyEnd(ended({ lastEvent: 'auth_error' }))), false);
  assert.equal(faults.countsAsAttempt(faults.classifyEnd({ status: 'completed' })), true);
  assert.equal(faults.countsAsAttempt(faults.classifyEnd(ended({ lastEvent: 'manual_stop' }))), false);
  assert.equal(faults.countsAsAttempt(null), false);
});

test('park: backoff 5, 15, 30, 60 minutes then hourly; a pass releases', () => {
  const s = {}, t0 = 1_000_000;
  const rec = faults.noteFault(s, { agent: 'codex', cause: 'auth_error', job: 'abcdef123456', ref: 'PR #9', now: t0 });
  assert.equal(rec.nextProbeAt, t0 + 5 * MIN);
  assert.deepEqual(faults.dueProbes(s, t0 + 4 * MIN), []);
  assert.deepEqual(faults.dueProbes(s, t0 + 5 * MIN), ['codex']);
  let now = t0 + 5 * MIN;
  for (const wait of [15, 30, 60, 60, 60]) {
    const r = faults.noteProbe(s, 'codex', false, now);
    assert.equal(r.released, false);
    assert.equal(s.parked.codex.nextProbeAt, now + wait * MIN);
    now = s.parked.codex.nextProbeAt;
  }
  assert.deepEqual(faults.noteProbe(s, 'codex', true, now), { released: true });
  assert.equal(faults.isParked(s, 'codex'), false);
  assert.equal(faults.noteProbe(s, 'codex', true, now), null);
});

test('park: a usage limit is counted but not parked (D-019 holds it until the reset)', () => {
  const s = {};
  assert.equal(faults.noteFault(s, { agent: 'claude', cause: 'usage_limit', job: 'j', now: 5 }), null);
  assert.equal(s.counts.usage_limit, 1);
  assert.equal(faults.isParked(s, 'claude'), false);
});

test('park: one Needs you item per agent, only after 30 minutes, gone on release', () => {
  const s = {}, t0 = 5_000_000;
  for (let i = 0; i < 6; i++) faults.noteFault(s, { agent: 'codex', cause: 'auth_error', job: `job${i}`, ref: `PR #${i}`, now: t0 + i * MIN });
  faults.noteFault(s, { agent: 'claude', cause: 'network', job: 'x', ref: 'issue #3', now: t0 + 6 * MIN });
  assert.deepEqual(faults.attentionItems(s, t0 + 29 * MIN), [], 'not before 30 minutes');
  const items = faults.attentionItems(s, t0 + 36 * MIN + 1);
  assert.deepEqual(items.map(i => i.id).sort(), ['agentfault-claude', 'agentfault-codex']);
  const codex = items.find(i => i.agent === 'codex');
  assert.match(codex.text, /sign-in problem/); assert.match(codex.text, /6 jobs/); assert.match(codex.text, /PR #0/);
  assert.match(codex.action, /sign the codex CLI in on Tower/);
  faults.noteProbe(s, 'codex', true, t0 + 40 * MIN);
  assert.deepEqual(faults.attentionItems(s, t0 + 41 * MIN).map(i => i.id), ['agentfault-claude']);
});

test('park: a fault soon after a release continues the earlier one', () => {
  const s = {}, t0 = 9_000_000;
  faults.noteFault(s, { agent: 'codex', cause: 'auth_error', job: 'a', now: t0 });
  faults.noteProbe(s, 'codex', true, t0 + 6 * MIN);
  const again = faults.noteFault(s, { agent: 'codex', cause: 'auth_error', job: 'b', now: t0 + 7 * MIN });
  assert.equal(again.since, t0, 'the 30 minute clock keeps running');
  faults.noteProbe(s, 'codex', true, t0 + 8 * MIN);
  const later = faults.noteFault(s, { agent: 'codex', cause: 'auth_error', job: 'c', now: t0 + 90 * MIN });
  assert.equal(later.since, t0 + 90 * MIN, 'an old release starts a new fault');
});

test('legacy caps: only caps set by an infrastructure cause are listed', () => {
  const same = { 'review:9': { cause: 'auth_error', count: 2 }, 'fix:9': { cause: 'postcondition_not_met', count: 2 }, 'rebase:4': { cause: 'network_error', count: 1 } };
  assert.deepEqual(faults.legacyInfraCaps(same, 2).map(x => x.key), ['review:9']);
  assert.deepEqual(faults.legacyInfraCaps(null, 2), []);
});

test('summary: faults are reported apart', () => {
  const s = {}; faults.noteFault(s, { agent: 'codex', cause: 'launcher', job: 'abc', now: 10 });
  const r = faults.summary(s, 10 + 31 * MIN);
  assert.deepEqual(r.counts, { launcher: 1 }); assert.equal(r.parked[0].raised, true); assert.equal(r.recent.length, 1);
});
