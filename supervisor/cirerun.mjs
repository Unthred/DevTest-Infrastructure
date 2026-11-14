// Issue #1375: a failed CI check is rerun once before a CI fix job is planned, and a red main is shown to the homeowner.
// The decisions here are pure; the two watch functions carry them out through the team's GitHub adapter.
// Recorded state (team state file): `ciRerun[<pr>:<head>]` holds one rerun per head, `ciRerunStats` counts them, `mainCi` is the red main item.
import { scannerOnly, checksState, latestChecks, checkDone, isCancelled, CHECK_OK, OPEN_PULLS_CAP } from './team.mjs';
import { unparkedPulls } from './controlactions.mjs';

// GitHub updates the pull request's check list a few seconds after a rerun is accepted; until then the old failure is still listed.
export const RERUN_SETTLE_MS = 60000;
const SAFE_NAME = /^[A-Za-z0-9 ._:()\/-]{1,80}$/;
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ERROR']);
const rawState = (team, pr) => checksState(pr.statusCheckRollup, team.retried(pr));
// The completed checks of the head that neither succeeded nor were cancelled.
const failedChecksOf = (team, pr) => latestChecks(pr.statusCheckRollup)
  .filter(c => checkDone(c) && !isCancelled(c, team.retried(pr)) && !CHECK_OK.includes(c.conclusion || c.state));
const keyOf = pr => `${pr.number}:${pr.headRefOid}`;
const safeName = c => { const n = c.name || c.context; return typeof n === 'string' && SAFE_NAME.test(n) ? n : 'a check'; };
const runOf = c => /\/actions\/runs\/(\d+)/.exec(c.detailsUrl || '')?.[1] ?? null;

// True while a requested rerun of this head has not had time to replace the old result: the pull request counts as waiting for CI.
export function rerunHolds(records, pr, now) {
  const r = records?.[keyOf(pr)];
  return !!r && !r.requestFailed && !r.noRun && now - r.at < RERUN_SETTLE_MS;
}

// The check state the planner sees: red while the one rerun of the failed head replaces the old result counts as pending (waiting for CI).
export function heldCiState(team, pr) {
  const raw = rawState(team, pr);
  return raw === 'red' && rerunHolds(team.s.ciRerun, pr, team.clock.now()) ? 'pending' : raw;
}

// What to do for a head whose raw CI state is `ciState`, given the record kept for it. Pure.
export function decideRerun({ ciState, record, failed }) {
  if (!record) return ciState === 'red' && failed.length && !scannerOnly(failed.map(safeName)) ? 'request' : 'none';
  if (record.result || record.requestFailed || record.noRun) return 'none';
  return ciState === 'green' ? 'unreliable' : ciState === 'red' ? 'real' : 'none';
}

// Reruns and their results, kept in the team state and quoted in each tick report, so the saving can be measured.
export const ciRerunStats = state => ({ requested: 0, unreliable: 0, real: 0, requestFailed: 0, ...state.ciRerunStats });
const count = (state, field) => { state.ciRerunStats = { ...ciRerunStats(state), [field]: ciRerunStats(state)[field] + 1 }; };

// Called once per tick, before the plan: the failed-check rerun, then main's CI status, each guarded.
export async function watchCi(team, report, guard, pulls) {
  await guard('ci rerun', () => watchCiRerun(team, report, unparkedPulls(pulls)));
  await guard('main ci', () => watchMainCi(team, report));
  report.ciReruns = ciRerunStats(team.s);
}

async function watchCiRerun(team, report, pulls) {
  const now = team.clock.now(), records = team.s.ciRerun ||= {};
  const open = new Set(pulls.map(keyOf));
  if (pulls.length < OPEN_PULLS_CAP) for (const k of Object.keys(records)) if (!open.has(k)) delete records[k];
  for (const pr of pulls) {
    if (pr.isDraft || !/^[0-9a-f]{40}$/.test(pr.headRefOid || '')) continue;
    const key = keyOf(pr), failed = failedChecksOf(team, pr), record = records[key];
    if (record && now - record.at < RERUN_SETTLE_MS && !record.requestFailed) continue;   // still replacing the old result
    const action = decideRerun({ ciState: rawState(team, pr), record, failed });
    if (action === 'request') await requestRerun(team, report, pr, failed);
    else if (action === 'unreliable' || action === 'real') {
      Object.assign(record, { result: action, settledAt: now });
      count(team.s, action);
      team.save();
    }
  }
}

async function requestRerun(team, report, pr, failed) {
  const runs = [...new Set(failed.map(runOf).filter(Boolean))], jobs = [...new Set(failed.map(safeName))].slice(0, 8);
  const record = team.s.ciRerun[keyOf(pr)] = { at: team.clock.now(), jobs, runs };
  if (!runs.length || !team.gh.rerunFailedJobs) { record.noRun = true; team.save(); return; }   // nothing to rerun: the CI fix is planned as today
  team.save();   // recorded before the call, so a failing or lost request is never repeated for the head
  try {
    const what = `re-ran the failed CI jobs on PR #${pr.number}`;
    const why = `check(s) ${jobs.join(', ')} failed on the current head; one rerun is made before a CI fix job is planned`;
    const sent = await team.unblock(report, { target: pr.number, tk: 'pull', what, why }, async () => {
      for (const r of runs) await team.gh.rerunFailedJobs(r);
      return 'failed jobs rerun requested (once per head)';
    });
    if (sent) count(team.s, 'requested'); else record.requestFailed = true;
  } catch (error) {
    record.requestFailed = true; count(team.s, 'requestFailed');
    const reason = String(error?.message || error).slice(0, 160);
    (report.warnings ||= []).push({ kind: 'ci-rerun', pr: pr.number, warning: `the rerun of the failed CI jobs on PR #${pr.number} could not be requested: ${reason}` });
  }
  team.save();
}

// The status of main from the check runs of its newest commit: red with the failed jobs, green, or pending. Pure.
export function mainCiStatus(runs) {
  const list = Array.isArray(runs) ? runs : [];
  if (!list.length) return { state: 'pending' };
  const failed = list.filter(r => r.status === 'completed' && FAILED.has(String(r.conclusion).toUpperCase()));
  const sha = list.find(r => /^[0-9a-f]{40}$/.test(r.head_sha || ''))?.head_sha ?? null;
  if (failed.length) {
    const at = Math.max(...failed.map(r => Date.parse(r.completed_at || '')).filter(Number.isFinite), 0) || null;
    return { state: 'red', sha, jobs: [...new Set(failed.map(r => safeName({ name: r.name })))].slice(0, 5), at };
  }
  return { state: list.every(r => r.status === 'completed') ? 'green' : 'pending', sha };
}

// One call per tick. The item is one record, so it is raised once and cleared by a later green run.
async function watchMainCi(team, report) {
  if (!team.gh.mainCheckRuns) return;
  let status;
  try { status = mainCiStatus(await team.gh.mainCheckRuns()); }
  catch (error) {
    const reason = String(error?.message || error).slice(0, 160);
    (report.warnings ||= []).push({ kind: 'main-ci', warning: `main's CI status could not be read: ${reason}` });
    return;
  }
  const now = team.clock.now(), held = team.s.mainCi;
  if (status.state === 'green' && held) {
    delete team.s.mainCi;
    team.save();
  } else if (status.state === 'red' && held?.sha !== status.sha) {
    team.s.mainCi = { sha: status.sha, jobs: status.jobs, at: status.at ?? now, since: held?.since ?? now };
    team.save();
  }
}

// The Needs you item for a red main, in the attention-item shape; none when main is not red.
export function mainCiItems(state) {
  const record = state.mainCi;
  if (!record) return [];
  const when = new Date(record.at).toISOString().slice(0, 16).replace('T', ' ');
  return [{ id: 'main-ci-red', ref: null, severity: 'action', since: record.since,
    text: `CI on main failed at commit ${String(record.sha).slice(0, 7)}: ${record.jobs.join(', ') || 'a check'} (${when} UTC)`,
    action: 'Rerun the failed job on main, or merge a fix. It clears when a later run on main is green.' }];
}
