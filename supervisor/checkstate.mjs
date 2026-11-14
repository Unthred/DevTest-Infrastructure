// Issue #1375: the judging of a pull request's check rollup, moved out of team.mjs so that the CI rerun code (cirerun.mjs) and
// the team module can both use it without importing each other. team.mjs re-exports every name here.
import { isSecretScanner } from './secret-scanner.mjs';

// Issue #149: judge each check by its latest run on the head. A push followed by a PR description edit starts two runs of the same
// check about 20 s apart; the concurrency group cancels the first. That superseded cancelled run is not a failure.
export const CHECK_OK = ['SUCCESS', 'NEUTRAL', 'SKIPPED'];
// Issue #331: GitHub can leave a check run at status IN_PROGRESS after it has a conclusion and a completed time (seen on PR #329).
// A conclusion plus a completed time is done whatever the status says.
// gh serialises a missing time as the Go zero time 0001-01-01T00:00:00Z, which Date.parse accepts: any year before 2000 is "unknown".
export const realTime = s => { const t = Date.parse(s || ''); return Number.isFinite(t) && new Date(t).getUTCFullYear() >= 2000 ? t : null; };
const hasResult = c => !!c.conclusion && realTime(c.completedAt) !== null;
export const checkDone = c => (c.status ? c.status === 'COMPLETED' || hasResult(c) : !!c.state && c.state !== 'PENDING' && c.state !== 'EXPECTED');
// GitHub-supplied text is never quoted unvalidated: a name outside this pattern is shown as 'a check'.
export const checkLabel = c => { const n = c.name || c.context; return typeof n === 'string' && /^[A-Za-z0-9 ._:()\/-]{1,80}$/.test(n) ? n : 'a check'; };
// Issue #163: a timed-out run is retried like a cancelled one. After the one rerun (`retried`) a further timeout is a real failure.
export const isCancelled = (c, retried = false) => c.conclusion === 'CANCELLED' || (!retried && c.conclusion === 'TIMED_OUT');
export const checkTime = c => { const t = Date.parse(c.startedAt || c.completedAt || ''); return Number.isFinite(t) ? t : null; };
// GitHub updates the pull request's check list a few seconds after a rerun is accepted; until then the old result is still listed.
export const RERUN_SETTLE_MS = 60000;
// The identity of a check on a head: workflow plus name (or status context). Two workflows can each have a check called 'test'.
export const checkKey = (c, i) => `${c.workflowName || ''}\u0000${c.name || c.context || `#${i}`}`;
export function latestChecks(rollup) {
  if (!Array.isArray(rollup)) return [];
  const latest = new Map();
  rollup.forEach((c, i) => {
    const key = checkKey(c, i);
    const prev = latest.get(key), t = checkTime(c), pt = prev && checkTime(prev);
    if (!prev || (t !== null && pt !== null ? t >= pt : true)) latest.set(key, c);   // no timestamps: the later list entry wins
  });
  return [...latest.values()];
}
// Must equal the --limit of listPulls in github.mjs.
export const OPEN_PULLS_CAP = 100;
export function checksState(rollup, retried = false) {
  if (!Array.isArray(rollup) || !rollup.length) return 'none';
  let pending = false;
  for (const c of latestChecks(rollup)) {
    if (!checkDone(c) || isCancelled(c, retried)) { pending = true; continue; }
    if (!CHECK_OK.includes(c.conclusion || c.state)) return 'red';
  }
  return pending ? 'pending' : 'green';
}
// The completed checks of the head that neither succeeded nor were cancelled.
export const failedChecks = (rollup, retried = false) => latestChecks(rollup)
  .filter(c => checkDone(c) && !isCancelled(c, retried) && !CHECK_OK.includes(c.conclusion || c.state));
// Names of completed, non-successful checks, safe to quote in a prompt (GitHub-supplied text is never interpolated unvalidated).
export function failingChecks(rollup, retried = false) {
  const names = [];
  for (const c of failedChecks(rollup, retried)) {
    const name = checkLabel(c);
    if (name !== 'a check' && !names.includes(name)) names.push(name);
  }
  return names.slice(0, 8);
}
export const scannerOnly = names => names.length > 0 && names.every(name => isSecretScanner({ name }));
