// Issue #448: a limit on how many full test suites run at once on Tower (install-time checks, reviews, jobs). A run takes one of
// `limit` slots (a directory with the owner's pid and start time, so a dead owner frees it) or waits in a first-in-first-out queue.
// What runs and what waits is written to disk, so `ai-supervisor test-slot status`, the team status and the dashboard can show it.
import fs from 'node:fs';
import path from 'node:path';
import { processStart } from './core.mjs';

export const DEFAULT_TEST_SLOTS = 2;
const dirOf = root => path.join(root, 'team', 'test-slots');
const alive = o => Boolean(o) && processStart(o.pid) === o.start;
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const label = s => String(s || 'test run').replace(/[^\x20-\x7e]/g, '').slice(0, 80);

// Who holds a slot and who waits. Entries whose owner process is gone are ignored (and removed by the next acquire).
export function testSlotStatus(root, limit = DEFAULT_TEST_SLOTS, now = Date.now()) {
  const dir = dirOf(root), running = [], waiting = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (/^slot-\d+$/.test(name)) { const o = readJson(path.join(dir, name, 'owner.json')); if (alive(o)) running.push({ slot: name, pid: o.pid, label: o.label, since: o.since }); }
  }
  const wdir = path.join(dir, 'waiting');
  for (const name of fs.existsSync(wdir) ? fs.readdirSync(wdir) : []) {
    const w = readJson(path.join(wdir, name)); if (alive(w)) waiting.push({ id: name, pid: w.pid, label: w.label, since: w.since });
  }
  waiting.sort((a, b) => a.since - b.since || a.id.localeCompare(b.id));
  return { limit, running: running.sort((a, b) => a.since - b.since), waiting, longestWaitMs: waiting.length ? Math.max(0, now - waiting[0].since) : 0 };
}
export const testSlotLine = st => `test runs: ${st.running.length} of ${st.limit} running${st.waiting.length ? `, ${st.waiting.length} waiting (longest ${Math.round(st.longestWaitMs / 1000)} s): ${st.waiting.slice(0, 5).map(w => w.label).join('; ')}` : ', none waiting'}`;

// Resolves to a release function once a slot is held. `timeoutMs` bounds the wait (then it resolves to null: the caller reports
// "waited too long" instead of running anyway). The limit is never bypassed.
export async function acquireTestSlot(root, { limit = DEFAULT_TEST_SLOTS, label: name, sleep = ms => new Promise(r => setTimeout(r, ms)), pollMs = 1000, timeoutMs = 3600000, now = () => Date.now() } = {}) {
  const dir = dirOf(root), wdir = path.join(dir, 'waiting');
  fs.mkdirSync(wdir, { recursive: true, mode: 0o700 });
  const start = now(), me = `${String(start).padStart(15, '0')}-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`;
  const owner = { pid: process.pid, start: processStart(process.pid), label: label(name), since: start };
  fs.writeFileSync(path.join(wdir, me), JSON.stringify(owner), { mode: 0o600 });
  const leave = () => fs.rmSync(path.join(wdir, me), { force: true });
  try {
    for (;;) {
      const st = testSlotStatus(root, limit, now());
      for (const name2 of fs.readdirSync(wdir)) if (!alive(readJson(path.join(wdir, name2)))) fs.rmSync(path.join(wdir, name2), { force: true });
      const ahead = st.waiting.findIndex(w => w.id === me);
      if (ahead >= 0 && ahead < limit - st.running.length) {
        for (let i = 0; i < limit; i++) {
          const slot = path.join(dir, `slot-${i}`);
          try { fs.mkdirSync(slot, { mode: 0o700 }); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            if (alive(readJson(path.join(slot, 'owner.json')))) continue;
            fs.rmSync(slot, { recursive: true, force: true }); try { fs.mkdirSync(slot, { mode: 0o700 }); } catch { continue; }
          }
          fs.writeFileSync(path.join(slot, 'owner.json'), JSON.stringify(owner), { mode: 0o600 });
          leave();
          let released = false;
          return () => { if (!released) { released = true; fs.rmSync(slot, { recursive: true, force: true }); } };
        }
      }
      if (now() - start >= timeoutMs) { leave(); return null; }
      await sleep(pollMs);
    }
  } catch (error) { leave(); throw error; }
}
// Runs `fn` while holding a slot; `fn` is not called when the wait times out.
export async function withTestSlot(root, opts, fn) {
  const release = await acquireTestSlot(root, opts);
  if (!release) return { ok: false, environmental: true, reason: `waited more than ${Math.round((opts.timeoutMs ?? 3600000) / 60000)} minutes for a free test slot` };
  try { return await fn(); } finally { release(); }
}
