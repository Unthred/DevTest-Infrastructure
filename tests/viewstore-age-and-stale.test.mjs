// Issue #613: a prepared copy's age counts from when its build started; a copy older than the last write is never reported as current.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createViewStore } from '../supervisor/viewstore.mjs';

test('age counts from the build start, not from when the build finished', async () => {
  let now = 1000;
  const store = createViewStore({ build: async () => { now += 2000; return { v: 1 }; }, clock: () => now, yieldTo: fn => fn(), refreshMs: 0 });
  const r = await store.get('k', {});
  assert.equal(r.builtAt, 1000);
  assert.equal(r.ageMs, 2000);   // the 2 s build time is included
  store.close();
});

test('a copy older than the last write is marked stale when rebuilds keep losing the race', async () => {
  let now = 0, store;
  const build = async () => { store.invalidate(); return { v: 1 }; };   // a write lands during every build
  store = createViewStore({ build, clock: () => now, yieldTo: fn => fn(), refreshMs: 0 });
  await store.get('k', {});   // first build, no copy yet
  const r = await store.get('k', {});   // copy is behind the write; rounds run out
  assert.equal(r.stale, true);
  store.close();
});

test('a current copy is not stale', async () => {
  const store = createViewStore({ build: async () => ({ v: 1 }), clock: () => 0, yieldTo: fn => fn(), refreshMs: 0 });
  const r = await store.get('k', {});
  assert.equal(r.stale, false);
  store.close();
});

test('reuse counts from the build finish: a slow build does not shorten the reuse window', async () => {
  let now = 0, builds = 0;
  const store = createViewStore({ build: async () => { builds++; now += 2000; return { v: builds }; }, ttlMs: 3000, clock: () => now, yieldTo: fn => fn(), refreshMs: 0 });
  await store.get('k', {});   // build starts at 0, finishes at 2000
  now = 4000;   // 2 s after the finish, 4 s after the start: still inside the reuse window
  await store.get('k', {});
  assert.equal(builds, 1);
  now = 5100;   // more than 3 s after the finish
  await store.get('k', {});
  await new Promise(r => setImmediate(r));
  assert.equal(builds, 2);
  store.close();
});

test('behindWrite is set only when the copy is older than the last write', async () => {
  let now = 0, store, racing = true;
  store = createViewStore({ build: async () => { if (racing) store.invalidate(); return { v: 1 }; }, clock: () => now, yieldTo: fn => fn(), refreshMs: 0 });
  await store.get('k', {});
  const behind = await store.get('k', {});
  assert.equal(behind.behindWrite, true);
  racing = false;
  const ok = await store.get('k', {});
  assert.equal(ok.behindWrite, false);
  now = 60000;
  const old = await store.get('k', {});
  assert.equal(old.stale, true); assert.equal(old.behindWrite, false);
  store.close();
});
