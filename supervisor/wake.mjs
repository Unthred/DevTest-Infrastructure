// Issue #406: start the next job as soon as an agent is free. A finished job (or a verified install) asks for one extra
// reconcile pass instead of leaving the free agent to wait for the 5-minute schedule. Model-free: it only spawns this program.
// The tick lock is untouched, so passes never overlap; the scheduled tick stays as the fallback. API load is bounded: at most
// one pending wake, at most WAKE_MAX_PER_HOUR wakes an hour, and WAKE_MIN_GAP_MS between the end of one tick and a wake.
import fs from 'node:fs';
import path from 'node:path';

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

// reason: 'job-end' | 'install'. An install wake is never merged into a pending job-end wake or rate-capped: that wake would run
// the old code, and the new code must verify the install. `spawnWake(reason)` returns { pid, start } of the detached pass.
export function requestWake({ root, reason, now = Date.now(), spawnWake, alive }) {
  const s = read(root);
  const force = reason === 'install';
  if (!force && s.pending && alive(s.pending)) return { requested: false, why: 'a wake is already pending' };
  const recent = s.started.filter(t => now - t < HOUR);
  if (!force && recent.length >= WAKE_MAX_PER_HOUR) return { requested: false, why: 'wake rate cap reached; the scheduled tick is the fallback' };
  const child = spawnWake(reason);
  write(root, { pending: { pid: child.pid, start: child.start ?? null, reason, at: now }, started: [...recent, now] });
  return { requested: true, reason };
}
export const clearPending = root => { const s = read(root); if (s.pending) write(root, { ...s, pending: null }); };

// What a wake pass does before it runs the normal reconcile: wait until no tick holds the lock, and (except after an install) until
// WAKE_MIN_GAP_MS have passed since the last tick finished. Returns { ready, waitedMs }; ready is false when the lock stayed held.
export async function waitForTurn({ reason, now = () => Date.now(), sleep, tryLock, lastTickAt, lockWaitMs = WAKE_LOCK_WAIT_MS, gapMs = WAKE_MIN_GAP_MS, pollMs = 3000 }) {
  const t0 = now();
  for (;;) {
    const release = tryLock();
    if (release) { release(); break; }
    if (now() - t0 >= lockWaitMs) return { ready: false, waitedMs: now() - t0 };
    await sleep(pollMs);
  }
  if (reason !== 'install') {
    const last = lastTickAt();
    const remaining = Number.isFinite(last) ? gapMs - (now() - last) : 0;
    if (remaining > 0) await sleep(remaining);
  }
  return { ready: true, waitedMs: now() - t0 };
}
