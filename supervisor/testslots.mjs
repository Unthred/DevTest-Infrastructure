// Issue #448: a limit on how many full test suites run at once on Tower (install-time checks, reviews, jobs). A run takes one of
// `limit` slots (a directory with the owner's pid and start time, so a dead owner frees it) or waits in a first-in-first-out queue.
// What runs and what waits is written to disk, so `ai-supervisor test-slot status`, the team status and the dashboard can show it.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
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

// Incident 2026-11-04: test workers outlived their parent and spun for ten hours. A job now runs in its own process group,
// has a maximum runtime, and on timeout, signal or exit the WHOLE group gets TERM, then KILL, and is checked empty.
export const DEFAULT_MAX_RUNTIME_MS = 2 * 3600 * 1000;
const groupAlive = pgid => { try { process.kill(-pgid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const signalGroup = (pgid, sig) => { try { process.kill(-pgid, sig); } catch { /* group already gone */ } };
const wait = ms => new Promise(r => setTimeout(r, ms));
// TERM, wait up to graceMs, then KILL, wait up to graceMs; resolves true when no member remains.
export async function stopGroup(pgid, { graceMs = 5000, pollMs = 50 } = {}) {
  for (const [sig, ms] of [['SIGTERM', graceMs], ['SIGKILL', graceMs]]) {
    if (!groupAlive(pgid)) return true;
    signalGroup(pgid, sig);
    for (let waited = 0; groupAlive(pgid) && waited < ms; waited += pollMs) await wait(pollMs);
  }
  return !groupAlive(pgid);
}
// Runs cmd in its own session; resolves { code, timedOut, leftover } (leftover = group members that survived KILL).
export async function runInGroup(cmd, { env, maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS, graceMs = 5000, stdio = 'inherit', onSignalTarget = process } = {}) {
  const child = spawn(cmd[0], cmd.slice(1), { stdio, env, detached: true });
  const pgid = child.pid;
  let timedOut = false, stopping = null;
  const stop = () => (stopping ??= stopGroup(pgid, { graceMs }));
  const handlers = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(sig => { const h = () => { stop(); }; onSignalTarget.on(sig, h); return [sig, h]; });
  const timer = pgid ? setTimeout(() => { timedOut = true; stop(); }, maxRuntimeMs) : null;
  const code = await new Promise(resolve => { child.on('error', () => resolve(127)); child.on('exit', (c, s) => resolve(c ?? (s ? 128 : 1))); });
  clearTimeout(timer);
  // the leader is gone; sweep any member it left behind (orphans keep the group id)
  const clean = pgid ? await stop() : true;
  for (const [sig, h] of handlers) onSignalTarget.off(sig, h);
  return { code: timedOut ? 124 : code, timedOut, leftover: !clean };
}
