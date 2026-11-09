// Issue #1119: deliberate skips are healthy; only real errors fail a tick or an install.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { recordTickWithSkips } from '../supervisor/tickrecord.mjs';
import assert from 'node:assert/strict';
import { tickOutcome, readCache } from '../supervisor/dashdata.mjs';

import { DELIBERATE_SKIPS, latchIsOnlyDeliberateSkips, dropStaleLatch, usageLimitSkip, liveTickOutcome } from '../supervisor/tickskips.mjs';

const usage = { what: 'cifix 1117 (codex)', reason: 'not started: codex reached its usage limit (x); it is retried', deliberate: 'usage_limit' };
const real = { what: 'implement 5 (claude)', reason: 'lease conflict' };

test('a tick with only deliberate skips is ok and lists them', () => {
  const out = tickOutcome({ skipped: [usage, ...DELIBERATE_SKIPS.map(k => ({ what: k, reason: 'r', deliberate: k }))] });
  assert.equal(out.status, 'ok');
  assert.equal(out.error, undefined);
  assert.equal(out.skips[0].what, 'cifix 1117 (codex)');
  assert.deepEqual(liveTickOutcome({ skipped: [usage] }), { ok: true, reason: null });
});
test('zero planned actions and no skips is ok', () => {
  assert.deepEqual(tickOutcome({ skipped: [] }), { status: 'ok' });
  assert.deepEqual(tickOutcome({}), { status: 'ok' });
});
test('a mix of a skip and a real error is an error naming only the error', () => {
  const out = tickOutcome({ skipped: [usage, real] });
  assert.equal(out.status, 'error');
  assert.match(out.error, /1 action\(s\) skipped: implement 5 \(claude\): lease conflict/);
  assert.doesNotMatch(out.error, /usage limit/);
  assert.equal(liveTickOutcome({ skipped: [usage, real] }).ok, false);
});
test('an unknown skip reason is an error and is named', () => {
  const out = tickOutcome({ skipped: [{ what: 'x', reason: 'odd', deliberate: 'made_up' }] });
  assert.equal(out.status, 'error');
  assert.match(out.error, /unknown skip reason "made_up"/);
  assert.equal(liveTickOutcome({ skipped: [{ what: 'x', reason: 'odd', deliberate: 'made_up' }] }).ok, false);
});
test('a skip with no kind stays an error', () => {
  assert.equal(tickOutcome({ skipped: [{ what: 'x', reason: 'gh failed' }] }).status, 'error');
});
test('only the real old usage-limit latch text is stale', () => {
  const real = 'live tick failed: not started: codex reached its usage limit (codex job 0ef14bc5 is paused on a usage limit); it is retried when allowance returns';
  assert.equal(latchIsOnlyDeliberateSkips({ reason: real }), true);
  assert.equal(latchIsOnlyDeliberateSkips({ reason: real.slice(0, 80) }), true, 'a reason cut at 160 characters still matches');
  assert.equal(latchIsOnlyDeliberateSkips({ reason: 'live tick failed: lease conflict' }), false);
  assert.equal(latchIsOnlyDeliberateSkips({ reason: 'upgrade script failed: swap: version already installed' }), false);
  assert.equal(latchIsOnlyDeliberateSkips(null), false);
});

test('a latch caused only by usage-limit skips is dropped once and recorded; any other latch stays', () => {
  const make = reason => {
    const calls = [];
    const up = { latch: () => (calls.includes('clear') ? null : { from: 'a', to: 'b', reason }), clearLatch: () => calls.push('clear'), record: r => calls.push(r.result) };
    return { up, calls };
  };
  const stale = make('live tick failed: not started: codex reached its usage limit (x); it is retried');
  assert.equal(dropStaleLatch(stale.up), true);
  assert.deepEqual(stale.calls, ['clear', 'latch_cleared']);
  const kept = make('live tick failed: boom');
  assert.equal(dropStaleLatch(kept.up), false);
  assert.deepEqual(kept.calls, []);
});
test('the usage-limit refusal is a deliberate skip, so the install check passes it', () => {
  const item = usageLimitSkip({ type: 'cifix', pr: 1117, agent: 'codex' }, { reason: 'x' });
  assert.equal(item.deliberate, 'usage_limit');
  assert.match(item.reason, /^not started: codex reached its usage limit/);
  assert.equal(liveTickOutcome({ skipped: [item] }).ok, true);
});

test('the recorded tick lists its deliberate skips and stays ok', t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'tick-skips-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  recordTickWithSkips(root, { now: 1000, ...tickOutcome({ skipped: [usage] }), jobs: [] });
  const tick = readCache(root).tick;
  assert.equal(tick.status, 'ok');
  assert.equal(tick.error, null);
  assert.deepEqual(tick.skips.map(s => s.what), ['cifix 1117 (codex)']);
});
test('a parked agent is a parked_agent skip, and the health view and exit code treat skips as healthy', async () => {
  const parked = usageLimitSkip({ type: 'cifix', pr: 1, agent: 'codex' }, { reason: 'parked: other infrastructure fault', parked: true });
  assert.equal(parked.deliberate, 'parked_agent');
  const { parseReconcileLog } = await import('../supervisor/suphealth.mjs');
  const tick = skipped => parseReconcileLog(`2026-11-09T20:00:00Z rc=0 ${JSON.stringify({ resumed: 0, blocked: 0, team: { skipped } })}\n`)[0];
  const healthy = tick([usage, parked]);
  assert.equal(healthy.status, 'ok');
  assert.deepEqual(healthy.errors, []);
  assert.equal(healthy.skipped.length, 2);
  const mixed = tick([usage, real]);
  assert.equal(mixed.status, 'partial');
  assert.equal(mixed.errors.length, 1);
  assert.equal(tick([{ what: 'x', reason: 'y', deliberate: 'bogus' }]).errors.length, 1);
});
