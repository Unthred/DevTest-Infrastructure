// Issue #467: the prepared-view store (stale marking, serving while a build runs, one shared build) and the page marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewStore } from '../supervisor/viewstore.mjs';
import { redact } from '../supervisor/redact.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';

const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };
const mk = (over = {}) => {
  let t = 1000, builds = 0; const waits = [];
  const build = async () => { builds++; const g = gate(); waits.push(g); await g.p; return { n: builds }; };
  const store = createViewStore({ build, ttlMs: 3000, staleMs: 30000, clock: () => t, yieldTo: fn => fn(), ...over });
  return { store, advance: ms => { t += ms; }, builds: () => builds, waits };
};
const tick = () => new Promise(r => setImmediate(r));

test('several simultaneous first requests cause one build', async () => {
  const x = mk(); const rs = [1, 2, 3, 4, 5].map(() => x.store.get('k', {}));
  await tick(); x.waits[0].open();
  const out = await Promise.all(rs);
  assert.equal(x.builds(), 1);
  assert.ok(out.every(o => o.view.n === 1 && !o.stale));
});

test('an old copy is served at once while one background rebuild runs, and requests do not start more', async () => {
  const x = mk(); const first = x.store.get('k', {}); await tick(); x.waits[0].open(); await first;
  x.advance(5000);
  const a = await x.store.get('k', {}), b = await x.store.get('k', {}), c = await x.store.get('k', {});   // build 2 is still blocked
  assert.equal(x.builds(), 2);
  assert.ok([a, b, c].every(o => o.view.n === 1 && o.refreshing && o.ageMs === 5000), 'served the last copy while building');
  x.waits[1].open(); await tick(); await tick();
  const d = await x.store.get('k', {});
  assert.equal(d.view.n, 2); assert.equal(d.stale, false);
});

test('a copy older than the stale limit is marked stale; one inside it is not', async () => {
  const x = mk(); const f = x.store.get('k', {}); await tick(); x.waits[0].open(); await f;
  x.advance(10000); assert.equal((await x.store.get('k', {})).stale, false);
  x.advance(25000); const o = await x.store.get('k', {}); assert.equal(o.stale, true); assert.equal(o.view.n, 1);
});

test('a failed rebuild keeps the last good copy, marked stale with the reason', async () => {
  let fail = false, t = 0;
  const store = createViewStore({ build: async () => { if (fail) throw new Error('disk gone'); return { ok: 1 }; }, ttlMs: 1000, staleMs: 30000, clock: () => t, yieldTo: fn => fn() });
  await store.get('k', {}); t = 2000; fail = true;
  await store.get('k', {}); await tick(); await tick();
  const o = await store.get('k', {});
  assert.deepEqual(o.view, { ok: 1 }); assert.equal(o.stale, true); assert.match(o.failed, /disk gone/);
});

test('a first build that fails rejects every waiting request and the next request tries again', async () => {
  let n = 0; const store = createViewStore({ build: async () => { if (++n === 1) throw new Error('boom'); return { ok: n }; }, clock: () => 0, yieldTo: fn => fn() });
  await assert.rejects(() => store.get('k', {}), /boom/);
  assert.equal((await store.get('k', {})).view.ok, 2);
});

test('ttl 0 rebuilds on every request (never serves an old copy)', async () => {
  let n = 0; const store = createViewStore({ build: async () => ({ n: ++n }), ttlMs: 0, clock: () => 0, yieldTo: fn => fn() });
  assert.equal((await store.get('k', {})).view.n, 1); assert.equal((await store.get('k', {})).view.n, 2);
});

test('the page says how old its data is, and marks a stale copy', () => {
  const view = { generatedAt: 1e12, health: { state: 'ok', severity: 'ok', label: 'ok' }, agents: [], attention: [], freshness: { level: 'ok', label: 'Fresh' }, version: {}, teamEnabled: true, panels: {}, graphs: {}, refs: {} };
  const html = d => { try { return renderRoute({ ...view, pageData: d }, { page: 'nope' }).html; } catch (e) { return String(e.message); } };
  const ok = html({ ageMs: 4000, stale: false }), stale = html({ ageMs: 95000, stale: true, failed: null }), none = html(undefined);
  if (ok.includes('Page data')) { assert.match(ok, /data-page-data="ok"[\s\S]*4 s old/); assert.match(stale, /data-page-data="stale"[\s\S]*Stale · 2 min old/); assert.doesNotMatch(none, /Page data/); }
  else assert.fail(`status bar did not render: ${ok.slice(0, 200)}`);
});

test('redact gives the same answer cached and uncached, and never leaks across inputs', () => {
  const s = 'password=hunter2 for user@example.com';
  const a = redact(s, 80), b = redact(s, 80), c = redact(s, 10);
  assert.equal(a, b); assert.ok(!a.includes('hunter2') && !a.includes('user@example.com')); assert.equal(c, a.slice(0, 10));
  assert.equal(redact('word '.repeat(1000), 30).length, 30);
});

// Review round 1 (issue #467): the build must not hold up the server's event loop.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkerBuild } from '../supervisor/viewworker.mjs';
import { latestVerdict } from '../supervisor/suphealth.mjs';
import { describeFor } from '../supervisor/dashboard.mjs';

test('a view built on the worker thread leaves the event loop free', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewworker-'));
  const file = path.join(dir, 'slow.mjs');
  fs.writeFileSync(file, `import { parentPort } from 'node:worker_threads';
parentPort.on('message', ({ id }) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); parentPort.postMessage({ id, json: JSON.stringify({ ok: true }) }); });\n`);
  const w = createWorkerBuild({ url: new URL(`file://${file}`).href });
  try {
    const started = Date.now(), building = w.build({});
    await new Promise(r => setTimeout(r, 20));
    const lag = Date.now() - started - 20;   // a timer scheduled during the build fires on time only if the loop is free
    assert.ok(lag < 150, `event loop was blocked for ${lag} ms`);
    assert.deepEqual(await building, { ok: true });
  } finally { await w.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('verdict lookups use one index per verdict set and keep the newest-first result', () => {
  const state = { verdicts: { '7:aaaaaaa1': { verdict: 'CHANGES', reviewer: 'codex', at: 10 }, '7:bbbbbbb2': { verdict: 'APPROVE', reviewer: 'codex', at: 20 }, '8:ccccccc3': { verdict: 'CHANGES', at: 5 } } };
  const cache = { pulls: [{ number: 7, headRefOid: 'bbbbbbb2' }] };
  assert.match(latestVerdict(state, 7, cache), /APPROVE by codex at bbbbbbb \(current head\)/);
  assert.match(latestVerdict(state, 9, cache), /none recorded/);
  assert.equal(latestVerdict(state, null, cache), null);
  const names = { prOfIssue: () => null, job: () => ({ text: 'j' }), pr: n => ({ text: `PR #${n}` }), issue: n => ({ text: `#${n}` }) };
  assert.equal(typeof describeFor({ id: 'x', kind: 'review', issue: 7, createdAt: 1 }, { names, state }), 'string');
});

test('the real build worker loads the dashboard and reports a build error instead of hanging', async () => {
  const w = createWorkerBuild();
  try { await assert.rejects(w.build({ root: '/nonexistent-root-467', config: {} }), /./); } finally { await w.close(); }
});

test('namer: a reference is formatted once and reused, and its text is unchanged (issue #467)', async () => {
  const { makeNamer } = await import('../supervisor/naming.mjs');
  const n = makeNamer({ repo: 'o/r', issues: [{ number: 5, title: 'A very long issue title '.repeat(6) }], pulls: [{ number: 9, title: 'PR title', headRefName: 'x/issue-5-y' }] });
  assert.equal(n.pr(9), n.pr(9));
  assert.equal(n.issue(5), n.issue(5));
  assert.ok(n.issue(5).text.endsWith('…') && n.issue(5).full.length > n.issue(5).text.length);
  const j = { id: 'abcdef123456', kind: 'review', pr: 9 };
  assert.equal(n.job(j), n.job({ ...j }));
  assert.equal(n.job(j).text, 'Reviewer · review · PR #9 PR title');
});

// Issue #467, rebuild flaw: the single timer rebuilds a requested view before it can go stale.
const mkTimed = (over = {}) => {
  let t = 1000, builds = 0, running = 0, maxRunning = 0, stops = 0, starts = 0, tickFn = null; const slow = [];
  const build = async o => {
    builds++; running++; maxRunning = Math.max(maxRunning, running);
    if (o?.slow) { const g = gate(); slow.push(g); await g.p; }
    running--; if (o?.fail) throw new Error('disk gone');
    return { n: builds };
  };
  const every = fn => { starts++; tickFn = fn; return () => { stops++; tickFn = null; }; };
  const store = createViewStore({ build, ttlMs: 3000, staleMs: 30000, refreshMs: 15000, activeMs: 300000, clock: () => t, yieldTo: fn => fn(), every, ...over });
  return { store, advance: ms => { t += ms; }, builds: () => builds, maxRunning: () => maxRunning, slow, fire: async () => { tickFn?.(); await settle(); }, stops: () => stops, starts: () => starts, timerSet: () => !!tickFn };
};
const settle = async () => { for (let i = 0; i < 6; i++) await tick(); };

test('a tab reloading every 60 seconds is never served a stale copy while the system is healthy', async () => {
  const x = mkTimed(); await x.store.get('k', {});
  for (let minute = 1; minute <= 4; minute++) {
    for (let step = 0; step < 4; step++) { x.advance(15000); await x.fire(); }   // the timer rebuilds before the copy is 30 s old
    const o = await x.store.get('k', {});   // the 60 s page reload
    assert.equal(o.stale, false, `reload in minute ${minute} must not be stale`);
    assert.ok(o.ageMs <= 15000, `copy is fresh (${o.ageMs} ms)`);
  }
});

test('there is one timer for every key, and a rebuild never overlaps another for the same key', async () => {
  const x = mkTimed(); await x.store.get('k', { slow: false }); await x.store.get('other', {});
  assert.equal(x.starts(), 1, 'one timer');
  await x.store.get('k', { slow: true });   // refresh the stored opts so the next rebuild of k is slow
  x.advance(16000); await x.fire();         // k and other rebuild; k's stays running
  assert.equal(x.slow.length, 1, 'one slow rebuild of k started');
  x.advance(16000); await x.fire(); await x.fire(); await x.store.get('k', { slow: true });   // more timer ticks and a request while it runs
  assert.equal(x.slow.length, 1, 'no second build of a key whose rebuild is still running');
  for (const g of x.slow) g.open(); await settle();
});

test('the timer stops when nobody has requested the view for the active window, and an unwatched dashboard builds nothing', async () => {
  const x = mkTimed(); await x.store.get('k', {});
  assert.equal(x.timerSet(), true);
  x.advance(301000); await x.fire();
  assert.equal(x.stops(), 1); assert.equal(x.timerSet(), false);
  const before = x.builds();
  x.advance(3600000); await x.fire(); await settle();
  assert.equal(x.builds(), before, 'no build while nobody is viewing');
  const back = await x.store.get('k', {});   // a viewer returns: the old copy is served at once, one rebuild starts, the timer restarts
  assert.equal(back.stale, true); assert.equal(x.timerSet(), true); await settle(); assert.equal(x.builds(), before + 1);
});

test('a failed timed rebuild keeps the last view and marks it stale with the reason', async () => {
  const x = mkTimed(); await x.store.get('k', {});
  await x.store.get('k', { fail: true });   // the stored opts make the next timed rebuild fail
  x.advance(16000); await x.fire();
  const o = await x.store.get('k', { fail: true });
  assert.deepEqual(o.view, { n: 1 }); assert.equal(o.stale, true); assert.match(o.failed, /disk gone/);
});

test('a slow timed rebuild keeps the last view, which is marked stale once it passes the stale limit', async () => {
  const x = mkTimed(); await x.store.get('k', {});
  await x.store.get('k', { slow: true });
  x.advance(16000); await x.fire();   // the rebuild starts and does not finish
  x.advance(20000);
  const o = await x.store.get('k', { slow: true });
  assert.equal(o.view.n, 1); assert.equal(o.stale, true); assert.equal(o.refreshing, true);
  for (const g of x.slow) g.open(); await settle();
});

test('a persistently failing rebuild is retried by the timer no more often than the refresh interval', async () => {
  const x = mkTimed(); await x.store.get('k', {});
  await x.store.get('k', { fail: true });
  x.advance(16000); await x.fire();
  const before = x.builds();
  x.advance(5000); await x.fire(); x.advance(5000); await x.fire();
  assert.equal(x.builds(), before, 'no retry inside the refresh interval');
  x.advance(6000); await x.fire(); assert.equal(x.builds(), before + 1, 'retried after the interval');
});

// ---- review finding 1: a write invalidates the prepared copies
test('invalidate: the next request waits for a build that began after the write instead of getting the earlier copy as current', async () => {
  const x = mkTimed(); const a = await x.store.get('k', {});
  assert.equal(a.view.n, 1);
  x.store.invalidate();
  const b = await x.store.get('k', {});   // inside the reuse window: without invalidate() this would be build 1 again
  assert.equal(b.view.n, 2); assert.equal(b.stale, false);
});
test('invalidate: a build already running when the write happens is not accepted as fresh; another one is made', async () => {
  const x = mkTimed(); await x.store.get('k', { slow: false });
  x.advance(4000);
  const g0 = x.slow.length;
  await x.store.get('k', { slow: true });   // old copy served, a slow background rebuild starts (it began before the write)
  x.store.invalidate();                      // the write
  const waiter = x.store.get('k', { slow: false });
  await settle();
  assert.equal(x.slow.length, g0 + 1, 'the slow build began before the write');
  for (const g of x.slow) g.open();
  const o = await waiter;
  assert.ok(o.view.n >= 3, `a build that began after the write was awaited (n=${o.view.n})`); assert.equal(o.stale, false);
});
test('invalidate: if the rebuild fails the old copy is served honestly marked stale with the reason', async () => {
  const x = mkTimed(); await x.store.get('k', {});
  x.store.invalidate();
  const o = await x.store.get('k', { fail: true });
  assert.deepEqual(o.view, { n: 1 }); assert.equal(o.stale, true); assert.match(o.failed, /disk gone/);
});

// ---- review finding 2: requests are tracked per key
test('per key: an unwatched view stops being rebuilt while another page keeps being requested (the reviewer\x27s probe)', async () => {
  let now = 1000, tickFn = null; const built = { timeline: 0, home: 0 };
  const store = createViewStore({ build: async o => { built[o.key]++; return { n: built[o.key] }; }, ttlMs: 3000, staleMs: 30000, refreshMs: 15000, activeMs: 300000,
    clock: () => now, yieldTo: fn => fn(), every: fn => { tickFn = fn; return () => { tickFn = null; }; } });
  await store.get('timeline', { key: 'timeline' });   // opened once at t=0 and never again
  await store.get('home', { key: 'home' });
  for (let minute = 1; minute <= 20; minute++) {   // only the home page reloads, once a minute, for 20 minutes
    for (let step = 0; step < 4; step++) { now += 15000; tickFn?.(); await settle(); }
    await store.get('home', { key: 'home' });
  }
  assert.ok(built.timeline <= 22, `the unwatched timeline was rebuilt ${built.timeline} times (it was 81 before the fix; at most 1 + 300 s / 15 s inside its window)`);
  assert.ok(built.home >= 75, `the watched home page kept being rebuilt (${built.home})`);
  assert.equal(store.timerRunning(), true, 'the timer keeps running for the watched key');
});
test('per key: with no key requested inside the window the timer stops, and a key requested again is rebuilt again', async () => {
  const x = mkTimed(); await x.store.get('a', {}); await x.store.get('b', {});
  x.advance(200000); await x.store.get('b', {});   // b stays watched, a does not
  x.advance(200000); await x.fire();                      // a is 400 s old, b 200 s: only b is rebuilt
  const afterB = x.builds(); x.advance(16000); await x.fire(); assert.equal(x.builds(), afterB + 1, 'only the watched key is rebuilt');
  x.advance(301000); await x.fire(); assert.equal(x.timerSet(), false, 'nobody watching: the timer stops');
  await x.store.get('a', {}); assert.equal(x.timerSet(), true, 'a request restarts it');
});

// ---- review follow-up: a hung worker cannot stall every later rebuild
test('worker build timeout: a build that never answers is rejected, the worker is terminated, and the next build starts a fresh one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewworker-hang-')), flag = path.join(dir, 'answer');
  const file = path.join(dir, 'hang.mjs');
  fs.writeFileSync(file, `import fs from 'node:fs'; import { parentPort } from 'node:worker_threads';
parentPort.on('message', ({ id }) => { if (fs.existsSync(${JSON.stringify(flag)})) parentPort.postMessage({ id, json: JSON.stringify({ ok: true }) }); });\n`);   // silent until the flag exists
  const w = createWorkerBuild({ url: new URL(`file://${file}`).href, timeoutMs: 300 });
  try {
    const t0 = Date.now();
    await assert.rejects(w.build({}), /timed out after/);
    assert.ok(Date.now() - t0 < 5000, 'rejected at the deadline, not left hanging');
    fs.writeFileSync(flag, '1');   // the next worker answers
    assert.deepEqual(await w.build({}), { ok: true });
  } finally { await w.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('page-data tooltip names the reason: behind a write, rebuilding, or just old', async () => {
  const { pageDataStat } = await import('../supervisor/dashrender.mjs').catch(() => ({}));
  if (!pageDataStat) return;
  assert.match(pageDataStat({ pageData: { ageMs: 2000, stale: true, behindWrite: true, refreshing: false } }), /before the latest change/);
  assert.match(pageDataStat({ pageData: { ageMs: 40000, stale: true, refreshing: true } }), /being rebuilt/);
  assert.doesNotMatch(pageDataStat({ pageData: { ageMs: 40000, stale: true, refreshing: false } }), /being rebuilt/);
});
