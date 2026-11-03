// Issue #473: the app bar's next-tick countdown has three states (scheduled, running, overdue) and never says "due now".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView, tickCountdown, runningTickSince } from '../supervisor/dashboard.mjs';
import { renderPage } from '../supervisor/dashrender.mjs';
import { tickLock } from '../supervisor/team.mjs';

const MIN = 60000, T0 = Date.UTC(2026, 10, 3, 22, 0, 0);   // a cron slot
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
const bar = html => html.slice(html.indexOf('class="statusbar"'), html.indexOf('<nav class="nav"'));
const page = async (root, lastAt, now) => renderPage(await buildView({ config, root, jobs: [], events: [], state: { jobs: {} }, cache: { tick: { at: lastAt, status: 'ok', lastOkAt: lastAt }, pulls: [], issues: [] }, snapshots: [], now }));
const emptyRoot = t => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-')); t.after(() => fs.rmSync(r, { recursive: true, force: true })); return r; };

test('scheduled: counts down to the next 5 minute slot after the last tick', () => {
  const c = tickCountdown({ lastAt: T0 + 11 * 1000, now: T0 + 2 * MIN });
  assert.deepEqual(c, { state: 'scheduled', at: T0 + 5 * MIN, lastAt: T0 + 11 * 1000 });
});
test('overrun: a tick that ran past the slot leaves the next slot, not last tick + 5 minutes', () => {
  // tick recorded at 22:01, slot 22:05 was skipped because it ran long; at 22:08 the next slot is 22:10 and nothing is overdue
  assert.equal(tickCountdown({ lastAt: T0 + MIN, now: T0 + 8 * MIN }).state, 'overdue');
  assert.equal(tickCountdown({ lastAt: T0 + MIN, now: T0 + 8 * MIN }).at, T0 + 5 * MIN);
});
test('skipped tick: overdue measured from the missed slot', () => {
  const c = tickCountdown({ lastAt: T0 + 11 * 1000, now: T0 + 9 * MIN });
  assert.deepEqual(c, { state: 'overdue', at: T0 + 5 * MIN, lastAt: T0 + 11 * 1000 });
});
test('running wins over both other states', () => {
  assert.equal(tickCountdown({ lastAt: T0, runningSince: T0 + 5 * MIN, now: T0 + 9 * MIN }).state, 'running');
  assert.equal(tickCountdown({ lastAt: T0, runningSince: T0 + 5 * MIN, now: T0 + 6 * MIN }).state, 'running');
  assert.equal(tickCountdown({ lastAt: undefined, now: T0 }), null);
});

test('app bar: scheduled shows "in m:ss"', async t => {
  const html = bar(await page(emptyRoot(t), T0 + 11000, T0 + 2 * MIN));
  assert.match(html, /data-tick-state="scheduled"><span data-countdown="\d+">in 3:00</);
});
test('app bar: skipped tick shows overdue with the last tick time, not "due now"', async t => {
  const html = bar(await page(emptyRoot(t), T0 + 11000, T0 + 9 * MIN));
  assert.match(html, /overdue by 4:00<\/span>, last tick <time class="lt" datetime="2026-11-03T22:00:11.000Z"/); assert.doesNotMatch(html, /due now/);
});
test('app bar: a live tick lock shows running since, even when the tick overruns the interval', async t => {
  const root = emptyRoot(t), release = tickLock(root);
  assert.equal(typeof release, 'function');
  const html = bar(await page(root, T0, T0 + 12 * MIN));
  assert.match(html, /tick running since <time class="lt"/); assert.doesNotMatch(html, /due now|overdue/);
  release();
  assert.match(bar(await page(root, T0, T0 + 12 * MIN)), /overdue by 7:00/);
});
test('a stale lock (owner process gone) is not a running tick', async t => {
  const root = emptyRoot(t), dir = path.join(root, 'team', 'tick.lock');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: 2 ** 22 - 1, start: 'gone', at: T0 }));
  assert.equal(runningTickSince(root), null);
  assert.equal(runningTickSince(path.join(root, 'missing')), null);
});
test('the client script never writes "due now"', () => {
  const js = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(js, /due now/); assert.match(js, /overdue by/);
});
