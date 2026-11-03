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
