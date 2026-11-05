// Issue #406: the one place that decides whether a reconcile run may run its pass now, and what follows it. Pure of the pass itself:
// the caller hands in `runPass`, so the same code serves the scheduled fire and every wake, and tests can drive it without a model or GitHub.
//   scheduled fire, lock free  -> run the pass.
//   scheduled fire, lock held  -> set the request flag and end; the holder runs one more pass after it. Held longer than PASS_STALE_MS
//                                 (a hung pass) -> run anyway without the pass lock; the schedule is never stopped by the wake path.
//   wake runner, lock free     -> run the pass.   wake runner, lock held -> end; the holder sees the flag after it releases.
// After a pass that held the lock, a request flag found set (set during the pass, or by the pass itself after an install) starts exactly
// one follow-up pass on the installed code.
import { wakePassLock, passLockAge, queueScheduled, takeRequest, pendingRequest, labelOf, PASS_STALE_MS } from './wake.mjs';

export async function drivePass({ root, wake = null, runPass, spawnFollowUp, now = () => Date.now() }) {
  let release = null, lockFailed = false;
  try { release = wakePassLock(root, now()); } catch { lockFailed = true; }   // a broken lock directory must not stop a scheduled pass
  if (!release && !lockFailed) {
    if (wake) return { ran: false, skipped: 'a pass is running; it will run the requested one after it' };
    if (passLockAge(root, now()) < PASS_STALE_MS) {
      let queued = true;
      try { queueScheduled({ root }); } catch { queued = false; }
      return { ran: false, skipped: queued ? 'a pass is running; one follow-up pass is queued' : 'a pass is running; the follow-up could not be queued' };
    }
    // Hung pass: fall through and run this scheduled pass unprotected by the pass lock.
  }
  let merged = [];
  if (release) { try { merged = takeRequest(root); } catch { /* the flag is left set; the next pass takes it */ } }
  const trigger = wake ? labelOf([wake, ...merged]) : 'schedule';
  let result;
  try { result = await runPass({ trigger, merged }); }
  finally { release?.(); }
  // After the release, never before: a request made while the lock was held is seen here (see the header of wake.mjs).
  let followUp = null;
  if (release) {
    try { const next = pendingRequest(root); if (next) { followUp = labelOf(next.reasons); spawnFollowUp(followUp); } } catch { /* the schedule is the fallback */ }
  }
  return { ran: true, trigger, merged, followUp, result };
}
