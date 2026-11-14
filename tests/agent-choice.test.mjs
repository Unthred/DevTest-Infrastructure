// Issue #1345: choice is exercised only through its exported pure entry point.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseAgent, describeChoice } from '../supervisor/agentchoice.mjs';
import { recentRate } from '../supervisor/recentrate.mjs';

const HOUR = 60 * 60 * 1000;
const NOW = Date.parse('2026-11-14T12:00:00Z');

function candidate(id, changes = {}) {
  return {
    id,
    mayDo: true,
    freeSlot: true,
    atOrBelowReserve: false,
    weekly: { used: 0.1, resetsAt: NOW + 100 * HOUR },
    short: { used: 0.1, resetsAt: NOW + 2 * HOUR },
    capacity: 1_000,
    share: { weekly: 0.02, short: 0.1, source: 'history', note: 'median history' },
    rate: { weekly: 0, short: 0 },
    pin: null,
    pool: 'plan',
    ...changes,
  };
}

const choose = (...candidates) => chooseAgent({ candidates, now: NOW });

test('with both spares negative the job goes where it costs least of the plan', () => {
  const a = candidate('A', {
    weekly: { used: 0.44, resetsAt: NOW + 135 * HOUR },
    rate: { weekly: 0.0152, short: 0 },
    share: { weekly: 0.0107, short: 0.01, source: 'history', note: 'median history' },
  });
  const b = candidate('B', {
    weekly: { used: 0.46, resetsAt: NOW + 135 * HOUR },
    rate: { weekly: 0.014, short: 0 },
    share: { weekly: 0.077, short: 0.01, source: 'history', note: 'median history' },
  });
  const result = choose(a, b);
  assert.equal(result.chosen, 'A');
  assert.equal(result.rule, 'least plan cost');
});

test('the large plan takes expensive job types and the small one a cheaper type there', () => {
  assert.equal(choose(candidate('A', { share: share(0.004) }), candidate('B', { share: share(0.04) })).chosen, 'A');
  assert.equal(choose(candidate('A', { share: share(0.002) }), candidate('B', { share: share(0.0005) })).chosen, 'B');
});

test('swapping which plan is large mirrors the outcome', () => {
  assert.equal(choose(candidate('A', { share: share(0.04) }), candidate('B', { share: share(0.004) })).chosen, 'B');
});

test('a third agent added by data alone competes on the same numbers', () => {
  const result = choose(candidate('A', { share: share(0.04) }), candidate('B', { share: share(0.03) }), candidate('C', { share: share(0.005) }));
  assert.equal(result.chosen, 'C');
  assert.equal(result.candidates.length, 3);
});

test('a short window that cannot cover the job skips the agent and the same agent takes a small job', () => {
  const almostFull = { used: 0.97, resetsAt: NOW + 2 * HOUR };
  const large = choose(candidate('A', { short: almostFull, share: share(0.001, 0.1) }), candidate('B', { share: share(0.05, 0.1) }));
  assert.equal(large.chosen, 'B');
  assert.equal(large.candidates[0].skipped, 'short window cannot cover the job');
  const small = choose(candidate('A', { short: almostFull, share: share(0.001, 0.01) }), candidate('B', { share: share(0.05, 0.1) }));
  assert.equal(small.chosen, 'A');
});

test('an unknown short window is named in the row rather than silently skipped', () => {
  const result = choose(candidate('A', { short: null }), candidate('B', { share: share(0.5) }));
  assert.equal(result.chosen, 'A');
  assert.equal(result.candidates[0].shortWindow, 'unknown');
  assert.match(describeChoice(result), /A: .*short window unknown/);
});

test('a rising recent rate moves new work to the other agent before reserve', () => {
  const readings = [
    allowance(2, 0.1),
    allowance(1, 0.108),
  ];
  const rate = recentRate({ readings, kind: 'weekly', now: NOW });
  const result = choose(candidate('A', { rate: { weekly: rate, short: 0 } }), candidate('B'));
  assert.equal(result.chosen, 'B');
});

test('a full slot loses, a preferred full slot loses, and a required pin waits for its candidate', () => {
  assert.equal(choose(candidate('A', { freeSlot: false }), candidate('B')).chosen, 'B');
  assert.equal(choose(candidate('A', { freeSlot: false, pin: 'preferred' }), candidate('B')).chosen, 'B');
  const pinned = choose(candidate('A'), candidate('B', { pin: 'required' }));
  assert.equal(pinned.chosen, 'B');
  assert.equal(pinned.candidates[0].skipped, 'required pin selects another candidate');
  const waits = choose(candidate('A'), candidate('B', { pin: 'required', freeSlot: false }));
  assert.equal(waits.chosen, null);
  assert.equal(waits.rule, 'no candidate qualifies');
});

test('too little history default note and every candidate figure are recorded in the reason', () => {
  const result = choose(
    candidate('A', { share: share(0.03, 0.1, 'default', 'history too short; configured default share') }),
    candidate('B', { freeSlot: false }),
  );
  const reason = describeChoice(result);
  assert.match(reason, /A chosen by only qualifying candidate/);
  assert.match(reason, /expected share 3%; history too short; configured default share; recent rate 0%\/h/);
  assert.match(reason, /B: .*full slot; skipped: no free slot/);
});

test('the credit agent takes work only when no plan agent qualifies', () => {
  assert.equal(choose(candidate('A', { pool: 'credit', share: share(0.001) }), candidate('B')).chosen, 'B');
  assert.equal(choose(candidate('A', { pool: 'credit' }), candidate('B', { mayDo: false })).chosen, 'A');
});

test('boundaries and invalid rows refuse unsafe data with a reason', () => {
  const zeroSpare = choose(
    candidate('A', {
      weekly: { used: 0.5, resetsAt: NOW + HOUR },
      rate: { weekly: 0.5, short: 0 },
      share: share(0.0001),
    }),
    candidate('B'),
  );
  assert.equal(zeroSpare.candidates[0].spare, 0);
  assert.equal(zeroSpare.chosen, 'A');
  assert.equal(choose(candidate('A'), candidate('B')).chosen, 'A');
  const invalid = choose(
    candidate('A', { capacity: null }),
    candidate('B', { weekly: { used: '0.2', resetsAt: NOW + HOUR } }),
    candidate('C', { share: share(-0.1) }),
  );
  assert.equal(invalid.chosen, null);
  assert.match(invalid.candidates[0].skipped, /capacity is missing or invalid/);
  assert.match(invalid.candidates[1].skipped, /weekly use is not a number/);
  assert.match(invalid.candidates[2].skipped, /expected weekly share is missing or negative/);
});

test('equal cost uses a preferred pin and then config order only', () => {
  assert.equal(choose(candidate('A'), candidate('B')).chosen, 'A');
  const preferred = choose(candidate('A'), candidate('B', { pin: 'preferred' }));
  assert.equal(preferred.chosen, 'B');
  assert.equal(preferred.rule, 'preferred pin');
});

function share(weekly, short = weekly * 7, source = 'history', note = 'median history') {
  return { weekly, short, source, note };
}

function allowance(hoursAgo, weekly) {
  return {
    at: NOW - hoursAgo * HOUR,
    weekly: { used: weekly, resetsAt: NOW + 100 * HOUR },
    short: { used: 0.1, resetsAt: NOW + 2 * HOUR },
  };
}
