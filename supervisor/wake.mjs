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
// A queued follow-up stands in for a scheduled fire that must not be lost, so it waits for the pass to end however long it runs
// (a dead holder's lock is taken over as stale; at most one follow-up is pending, so waiters never pile up).
export const WAKE_QUEUED_LOCK_WAIT_MS = Infinity;
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
// The program every wake runs: the installed code, never the code of the process that asks (a worker started before an install ends
// after it). Only when no installed copy exists (an unversioned checkout) does it fall back to this code.
export function wakeTarget({ root, self }) {
  const installed = path.join(root, 'current', 'supervisor', 'cli.mjs');
  return fs.existsSync(installed) ? installed : self;
}
// The command lines of a wake pass and of a worker. A registry is passed on only when the operator gave one: a default is resolved by the code
// that runs, so a pass handed to a newer install loads that install's provider manifests, not the old version's (reviewed on PR #525).
export const wakeArgs = ({ target, reason, root, registry }) => [target, 'reconcile', '--wake', reason, '--state-root', root, ...(registry ? ['--registry', registry] : [])];
export const workerArgs = ({ self, id, root, registry, defaultRegistry }) => [self, 'worker', id, '--state-root', root, ...(path.resolve(registry) === path.resolve(defaultRegistry) ? [] : ['--registry', registry])];
// One wake pass at a time, held from the start of the pass to its end.
export const wakePassLock = root => dirLock(root, 'wake-pass.lock');
// The read-modify-write of wake.json runs under a short lock, so two job-end workers cannot both pass the pending check.
function withFileLock(root, fn) {
  let release = null;
  for (let i = 0; i < 300 && !(release = dirLock(root, 'wake-file.lock')); i++) { const end = Date.now() + 10; while (Date.now() < end) { /* brief spin */ } }
  if (!release) throw new Error('wake state is locked');
  try { return fn(); } finally { release(); }
}

// reason: 'job-end' | 'install' | 'queued' (a scheduled run that found a pass running). An install wake is never merged into a pending job-end wake or rate-capped, and a queued follow-up is not rate-capped either: that wake would run
// the old code, and the new code must verify the install. `spawnWake(reason)` returns { pid, start } of the detached pass.
export function requestWake(opts) { return withFileLock(opts.root, () => requestWakeLocked(opts)); }
function requestWakeLocked({ root, reason, now = Date.now(), spawnWake, alive }) {
  const s = read(root);
  const force = reason === 'install';
  const uncapped = force || reason === 'queued';   // a queued follow-up replaces a scheduled fire; the cap must not drop it
  // A queued follow-up is merged only into another queued waiter, which waits however long the pass runs. A pending job-end waiter gives up
  // after WAKE_LOCK_WAIT_MS, so merging a scheduled fire into it would lose the fire when the pass is longer (reviewed on PR #525).
  const mergeable = s.pending && alive(s.pending) && !(reason === 'queued' && s.pending.reason !== 'queued');
  if (!force && mergeable) return { requested: false, why: 'a wake is already pending' };
  const recent = s.started.filter(t => now - t < HOUR);
  if (!uncapped && recent.length >= WAKE_MAX_PER_HOUR) return { requested: false, why: 'wake rate cap reached; the scheduled tick is the fallback' };
  const child = spawnWake(reason);
  write(root, { pending: { pid: child.pid, start: child.start ?? null, reason, at: now }, started: [...recent, now] });
  return { requested: true, reason };
}
// With `pid`, only that waiter's own marker (or one whose process is gone) is cleared: a job-end waiter that gives up must not erase the marker
// of a queued waiter that replaced it.
const markerAlive = p => !!p?.pid && processStart(p.pid) === p.start;
export const clearPending = (root, pid, alive = markerAlive) => withFileLock(root, () => { const s = read(root); if (s.pending && (pid === undefined || s.pending.pid === pid || !alive(s.pending))) write(root, { ...s, pending: null }); });

// What a wake pass does before it runs the normal reconcile: wait until it can take the locks (`tryLock` returns the release the caller holds for the whole pass), and (except after an install) until
// WAKE_MIN_GAP_MS have passed since the last tick finished. Returns { ready, waitedMs, release }; ready is false when the lock stayed held.
export async function waitForTurn({ reason, now = () => Date.now(), sleep, tryLock, lastTickAt, lockWaitMs = reason === 'queued' ? WAKE_QUEUED_LOCK_WAIT_MS : WAKE_LOCK_WAIT_MS, gapMs = WAKE_MIN_GAP_MS, pollMs = 3000 }) {
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
