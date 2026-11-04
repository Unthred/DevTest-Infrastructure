// Issue #473: the app bar's next-tick countdown has three states (scheduled, running, overdue) and never says "due now".
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { buildView, TICK_GRACE_MS, tickCountdown, runningTickSince } from '../supervisor/dashboard.mjs';
import { renderPage } from '../supervisor/dashrender.mjs';
import { tickLock } from '../supervisor/team.mjs';
import { handler } from '../supervisor/dashserver.mjs';

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
test('overrun: a tick recorded after the skipped slot leaves the next slot, not last tick + 5 minutes', () => {
  // slot 22:05 was skipped while a tick ran long and recorded at 22:06; at 22:08 the next slot is 22:10 and nothing is overdue
  assert.deepEqual(tickCountdown({ lastAt: T0 + 6 * MIN, now: T0 + 8 * MIN }), { state: 'scheduled', at: T0 + 10 * MIN, lastAt: T0 + 6 * MIN });
});
test('crossing zero: just after the slot the state is starting, overdue only after the grace period', () => {
  const last = T0 + 11000;
  assert.equal(tickCountdown({ lastAt: last, now: T0 + 5 * MIN + 1000 }).state, 'starting');
  assert.equal(tickCountdown({ lastAt: last, now: T0 + 5 * MIN + TICK_GRACE_MS - 1 }).state, 'starting');
  assert.equal(tickCountdown({ lastAt: last, now: T0 + 5 * MIN + TICK_GRACE_MS }).state, 'overdue');
  assert.equal(tickCountdown({ lastAt: last, runningSince: T0 + 5 * MIN + 2000, now: T0 + 5 * MIN + 3000 }).state, 'running');
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
  // the client must not claim overdue the moment the slot passes: grace first, and it re-reads the server's Next stat
  assert.match(js, /TICK_GRACE_MS/); assert.match(js, /refreshNext\(\)/); assert.match(js, /tick due, starting/);
});
// Runs the real tick code from app.js (the block between the two markers) against a small stand-in DOM, so the running -> scheduled
// change is executed, not just grepped for.
function tickHarness({ fragments, start }) {
  const js = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
  const code = js.slice(js.indexOf('const fmt = '), js.indexOf('tickClock(); setInterval'));
  assert.ok(code.includes('async function refreshNext'));
  const mk = html => { const state = /data-tick-state="(\w+)"/.exec(html)[1]; return { state, html, running: /data-running/.test(html), countdown: /data-countdown="(\d+)"/.exec(html)?.[1], dataset: {}, parentElement: null, textContent: '', replaceWith: x => { bar.el = x; } }; };
  const bar = { el: mk(start) }, localized = [], urls = []; let now = T0;
  const bind = el => { if (el.countdown) el.dataset.countdown = el.countdown; return el; };
  bind(bar.el);
  const ctx = {
    Date: { now: () => now }, location: { href: 'http://x/watch/1' },
    $$: sel => (sel === '.statusbar [data-running]' ? (bar.el.running ? [bar.el] : []) : sel === '[data-countdown]' ? (bar.el.countdown ? [bar.el] : []) : []),
    document: { querySelector: () => bar.el, importNode: e => e },
    DOMParser: class { parseFromString(text) { return { querySelector: () => (/data-tick-state/.test(text) ? bind(mk(text)) : null) }; } },
    fetch: async url => { urls.push(url); return { ok: true, text: async () => fragments.shift() }; },
    localizeTimes: el => localized.push(el),
  };
  vm.runInNewContext(`${code.replace(/^const fmt/, 'var fmt')}; this.tickClock = tickClock;`, ctx);
  return { bar, ctx, localized, urls, advance: ms => { now += ms; } };
}
test('browser run: a running bar re-reads only the Next fragment and turns scheduled; the new time is localized; polls are throttled', async () => {
  const sched = `<b data-tick-state="scheduled"><span data-countdown="${T0 + 5 * MIN}">in 5:00</span><span data-after hidden>, last tick <time data-local>x</time></span></b>`;
  const h = tickHarness({ start: '<b data-tick-state="running" data-running>tick running since <time data-local>x</time></b>', fragments: [sched, sched] });
  h.advance(60000); h.ctx.tickClock(); await new Promise(r => setImmediate(r));
  assert.deepEqual(h.urls, ['/api/next']);                       // the small endpoint, never the page itself
  assert.equal(h.bar.el.state, 'scheduled'); assert.equal(h.bar.el.running, false);
  assert.deepEqual(h.localized, [h.bar.el]);                     // the swapped-in element gets the browser's time zone
  h.advance(1000); h.ctx.tickClock(); await new Promise(r => setImmediate(r));
  assert.equal(h.urls.length, 1);                                // scheduled and not yet due: no more polling
});
test('browser run: a bar that stays running keeps polling, at most every 10 seconds', async () => {
  const run = '<b data-tick-state="running" data-running>tick running since <time data-local>x</time></b>';
  const h = tickHarness({ start: run, fragments: [run, run, run] });
  h.advance(1000); h.ctx.tickClock(); await new Promise(r => setImmediate(r));
  h.advance(1000); h.ctx.tickClock(); await new Promise(r => setImmediate(r));
  assert.equal(h.urls.length, 1);
  h.advance(10000); h.ctx.tickClock(); await new Promise(r => setImmediate(r));
  assert.equal(h.urls.length, 2);
});
test('/api/next serves just the Next element', async t => {
  const root = emptyRoot(t);
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: T0, status: 'ok', lastOkAt: T0 }, fetchedAt: T0, delivered: [], pulls: [], issues: [] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => T0 + 2 * MIN }));
  const get = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: b })); }).on('error', reject));
  const ok = await get('/api/next');
  assert.equal(ok.status, 200); assert.match(ok.type, /text\/html/);
  assert.match(ok.body, /^<b data-tick-state="scheduled"><span data-countdown="\d+">in 3:00</); assert.doesNotMatch(ok.body, /<html|<header|<main/);
  assert.equal((await get('/api/nope')).status, 404);
});
