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
  assert.match(large.candidates[0].skipped, /^short window cannot cover the job: actual short room 3% is below the job's 10%/);
  const small = choose(candidate('A', { short: almostFull, share: share(0.001, 0.01) }), candidate('B', { share: share(0.05, 0.1) }));
  assert.equal(small.chosen, 'A');
});

test('an unknown short window is named in the row rather than silently skipped', () => {
  const result = choose(candidate('A', { short: null }), candidate('B', { share: share(0.5) }));
  assert.equal(result.chosen, 'A');
  assert.equal(result.candidates[0].shortWindow, 'unknown');
  assert.match(describeChoice(result), /A: .*short window unknown/);
});

test('a malformed short window is refused with its reason instead of a false room', () => {
  const result = choose(candidate('A', { short: { used: 'x', resetsAt: NOW + HOUR } }));
  assert.equal(result.chosen, null);
  assert.equal(result.candidates[0].shortWindow, 'invalid');
  assert.match(result.candidates[0].skipped, /short use is not a number/);
  assert.match(describeChoice(result), /short room unknown; free slot; skipped: short use is not a number/);
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

// Issue #1424, real data of 14 Nov 2026 07:57 UTC.
const SEEN = Date.parse('2026-11-14T07:57:00Z');
const seen = changes => candidate('first', {
  weekly: { used: 0.72, resetsAt: Date.parse('2026-11-19T04:00:00Z') },
  short: { used: 0.25, resetsAt: Date.parse('2026-11-14T11:40:00Z') },
  rate: { weekly: 0.027, short: 0.2386 },
  share: share(0.002, 0.002),
  ...changes,
});
const chooseSeen = (...candidates) => chooseAgent({ candidates, now: SEEN });

test('real data: a negative projected short room no longer refuses a job the window has room for', () => {
  const result = chooseSeen(seen(), candidate('second', { mayDo: false }));
  assert.equal(result.chosen, 'first');
  const row = result.candidates[0];
  assert.ok(Math.abs(row.shortRoom - -0.137) < 0.001, `projected short room ${row.shortRoom}`);
  assert.ok(Math.abs(row.shortActualRoom - 0.75) < 1e-9);
  assert.match(describeChoice(result), /first: .*actual short room 75%; projected short room -13\.7%.*qualifies/);
});

test('boundary: actual short room equal to the job share qualifies, and a missing short reading is treated as before', () => {
  const equal = choose(candidate('A', { short: { used: 0.9, resetsAt: NOW + HOUR }, share: share(0.01, 0.1) }));
  assert.equal(equal.chosen, 'A');
  assert.equal(choose(candidate('A', { short: null })).chosen, 'A');
});

test('invalid: too little actual short room, a window past its reset and a candidate at reserve are refused', () => {
  const full = choose(candidate('A', { short: { used: 0.999, resetsAt: NOW + HOUR }, share: share(0.01, 0.01) }));
  assert.equal(full.chosen, null);
  assert.match(full.candidates[0].skipped, /actual short room 0\.1% is below the job's 1%/);
  assert.equal(choose(candidate('A', { short: { used: 0.1, resetsAt: NOW - HOUR } })).chosen, null);
  assert.equal(choose(candidate('A', { atOrBelowReserve: true, short: { used: 0, resetsAt: NOW + HOUR } })).chosen, null);
});

test('a negative projected spare loses to a positive one and wins when it is the only candidate', () => {
  const over = candidate('A', { weekly: { used: 0.5, resetsAt: NOW + 100 * HOUR }, rate: { weekly: 0.02, short: 0 }, share: share(0.0001) });
  const fine = candidate('B', { share: share(0.05) });
  assert.equal(choose(over, fine).chosen, 'B');
  const alone = choose(over, candidate('B', { mayDo: false }));
  assert.equal(alone.chosen, 'A');
  assert.ok(alone.candidates[0].spare < 0);
});

test('property: a candidate with a free slot, the job type, reserve left and real room in both windows is always chosen', () => {
  let seed = 7;
  const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let i = 0; i < 300; i += 1) {
    const rows = [0, 1, 2].map(n => candidate(`c${n}`, {
      weekly: { used: next() * 0.95, resetsAt: NOW + (1 + next() * 160) * HOUR },
      short: { used: next() * 0.95, resetsAt: NOW + (0.1 + next() * 5) * HOUR },
      rate: { weekly: next() * 0.3, short: next() * 0.5 },
      share: share(next() * 0.04, next() * 0.04),
      freeSlot: next() > 0.3,
      mayDo: next() > 0.3,
    }));
    const roomy = rows.some(r => r.freeSlot && r.mayDo && 1 - r.short.used >= r.share.short);
    if (roomy) assert.notEqual(choose(...rows).chosen, null, JSON.stringify(rows));
  }
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
