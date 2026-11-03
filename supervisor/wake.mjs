// Issue #406: start the next job as soon as an agent is free. A finished job (or a verified install) asks for one extra
// reconcile pass instead of leaving the free agent to wait for the 5-minute schedule. Model-free: it only spawns this program.
// A wake pass holds its own single-flight lock for the whole pass (reconcile, upgrade step, team tick) and the team tick still takes
// the tick lock, so passes never overlap each other or a scheduled tick; the scheduled tick stays as the fallback. API load is bounded: at most
// one pending wake, at most WAKE_MAX_PER_HOUR wakes an hour, and WAKE_MIN_GAP_MS between the end of one tick and a wake.
import fs from 'node:fs';
import path from 'node:path';
import { processStart } from './core.mjs';

export const WAKE_MIN_GAP_MS = 20 * 1000;
export const WAKE_MAX_PER_HOUR = 24;
export const WAKE_LOCK_WAIT_MS = 2 * 60 * 1000;
const HOUR = 3600 * 1000;

const wakeFile = root => path.join(root, 'team', 'wake.json');
function read(root) { try { const s = JSON.parse(fs.readFileSync(wakeFile(root), 'utf8')); return { pending: s.pending || null, started: Array.isArray(s.started) ? s.started.filter(Number.isFinite) : [] }; } catch { return { pending: null, started: [] }; } }
function write(root, s) {
  fs.mkdirSync(path.dirname(wakeFile(root)), { recursive: true, mode: 0o700 });
  const tmp = `${wakeFile(root)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, wakeFile(root));
}

// A directory lock owned by this process (stale when the owner is gone). Returns a release function, or null while another live process holds it.
export function dirLock(root, name) {
  const dir = path.join(root, 'team', name);
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner; try { owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch { owner = null; }
    if (owner && processStart(owner.pid) === owner.start) return null;
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { mode: 0o700 });
  }
  fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ pid: process.pid, start: processStart(process.pid) }), { mode: 0o600 });
  return () => fs.rmSync(dir, { recursive: true, force: true });
}
// One wake pass at a time, held from the start of the pass to its end.
export const wakePassLock = root => dirLock(root, 'wake-pass.lock');
// The read-modify-write of wake.json runs under a short lock, so two job-end workers cannot both pass the pending check.
function withFileLock(root, fn) {
  let release = null;
  for (let i = 0; i < 300 && !(release = dirLock(root, 'wake-file.lock')); i++) { const end = Date.now() + 10; while (Date.now() < end) { /* brief spin */ } }
  if (!release) throw new Error('wake state is locked');
  try { return fn(); } finally { release(); }
}

// reason: 'job-end' | 'install'. An install wake is never merged into a pending job-end wake or rate-capped: that wake would run
// the old code, and the new code must verify the install. `spawnWake(reason)` returns { pid, start } of the detached pass.
export function requestWake(opts) { return withFileLock(opts.root, () => requestWakeLocked(opts)); }
function requestWakeLocked({ root, reason, now = Date.now(), spawnWake, alive }) {
  const s = read(root);
  const force = reason === 'install';
  if (!force && s.pending && alive(s.pending)) return { requested: false, why: 'a wake is already pending' };
  const recent = s.started.filter(t => now - t < HOUR);
  if (!force && recent.length >= WAKE_MAX_PER_HOUR) return { requested: false, why: 'wake rate cap reached; the scheduled tick is the fallback' };
  const child = spawnWake(reason);
  write(root, { pending: { pid: child.pid, start: child.start ?? null, reason, at: now }, started: [...recent, now] });
  return { requested: true, reason };
}
export const clearPending = root => withFileLock(root, () => { const s = read(root); if (s.pending) write(root, { ...s, pending: null }); });

// What a wake pass does before it runs the normal reconcile: wait until it can take the locks (`tryLock` returns the release the caller holds for the whole pass), and (except after an install) until
// WAKE_MIN_GAP_MS have passed since the last tick finished. Returns { ready, waitedMs, release }; ready is false when the lock stayed held.
export async function waitForTurn({ reason, now = () => Date.now(), sleep, tryLock, lastTickAt, lockWaitMs = WAKE_LOCK_WAIT_MS, gapMs = WAKE_MIN_GAP_MS, pollMs = 3000 }) {
  const t0 = now();
  let release = null;
  for (;;) {
    release = tryLock();
    if (release) break;
    if (now() - t0 >= lockWaitMs) return { ready: false, waitedMs: now() - t0 };
    await sleep(pollMs);
  }
  if (reason !== 'install') {
    const last = lastTickAt();
    const remaining = Number.isFinite(last) ? gapMs - (now() - last) : 0;
    if (remaining > 0) await sleep(remaining);
  }
  return { ready: true, waitedMs: now() - t0, release };
}
