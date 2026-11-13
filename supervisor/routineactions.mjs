// Issue #1157: the routine-tier ways out of a stopped item that issue #1111 named: one more fix round, closing as superseded, and resuming a
// tripped breaker. Each runs only as an approved inbox action (the homeowner's click on a decision card, or an approved overseer proposal), so
// who, when and why are in the item's status and in the unblock log. A refusal throws a SupervisorError and the item ends 'failed' with the
// reason and nothing changed. The team module only calls the five entry points below.
import { SupervisorError } from './core.mjs';
import { agentOfBranch } from './team.mjs';
import * as breaker from './breaker.mjs';
import { closeWrites } from './ghclose.mjs';
import { unparkApproved, depsOf, liveJobsFor } from './controlactions.mjs';

const SHA = /^[0-9a-f]{40}$/;
const WRITING = new Set(['fix', 'cifix']);
const MAX_SUPERSEDERS = 5;
export const ROUTINE_ACTIONS = new Set(['extra_fix_round', 'close_superseded', 'resume_breaker', 'unpark']);
const refuse = text => { throw new SupervisorError(text); };
const logOf = (team, e) => team.logUnblock({}, { tk: 'pull', ...e });
const approvedWhy = reason => `homeowner approved on the dashboard: ${reason}`;
const openPull = async (team, n) => (await team.gh.listPulls()).find(p => p.number === n) ?? null;

// ---- extra_fix_round -------------------------------------------------------------------------------------------------------------------
// The grant is one record per pull request: { head, agent, spent, by, at, why }. It names one head, so a new head ends it by itself.
const grantOf = (team, pr) => {
  const g = (team.s.extraFix ||= {})[pr.number];
  return g && g.head === pr.headRefOid && !g.spent ? g : null;
};
// The open grant for this pull request's current head, or null. The planner lets exactly this fix job past the fix limit and the churn stop.
export const openExtraFix = (team, pr) => grantOf(team, pr);
// Called when a fix or CI fix job starts: an open grant for that head and worker is used up whether or not the job's fix lands, so the limits
// apply again straight after.
export function spendExtraFix(team, act) {
  const g = team.s.extraFix?.[act.pr];
  if (g && !g.spent && g.head === act.head && g.agent === act.agent) g.spent = true;
}

async function fixJobRunning(team, n) {
  const ids = Object.keys(team.s.jobs).filter(id => WRITING.has(team.s.jobs[id].kind) && team.s.jobs[id].pr === n);
  const live = [];
  for (const id of ids) {
    const job = await team.jobs.get(id).catch(() => null);
    if (job && !['completed', 'failed', 'blocked', 'stopped'].includes(job.status)) live.push(id.slice(0, 8));
  }
  return live;
}
// D-011: each agent works only on its own branch in its own worktree, so the worker of a fix round is the branch's author. A requested worker is
// accepted only when it is that author; another agent would have to write inside the author's worktree. The author may still be refused by the
// writer rules (an Opus writer, or a model that would leave no independent reviewer).
function chooseFixer(team, pr, requested) {
  const author = agentOfBranch(team.c, pr.headRefName);
  if (requested && requested !== author) refuse(`${requested} cannot write this fix: PR #${pr.number} is ${author}'s branch and each agent works only in its own worktree (D-011)`);
  if (!team.c.agents[author]) refuse(`${author} is not a configured worker`);
  if (team.limitedOf(author)?.out) refuse(`${author} is out of allowance`);
  const refusal = team.modelFor({ agent: author, pr: pr.number, branch: pr.headRefName, head: pr.headRefOid, key: `wb:${pr.number}` }, 'fix', {}, true).writeRefusal;
  if (refusal) refuse(`${author} may not write this fix: ${refusal}`);
  return author;
}

export async function extraFixRound(team, { target, model, reason }) {
  const n = Number(target), pr = await openPull(team, n);
  if (!pr) refuse(`PR #${n} is not open; nothing changed`);
  if (!agentOfBranch(team.c, pr.headRefName) || !SHA.test(pr.headRefOid)) refuse(`PR #${n} is not a Foreman pull request with a usable head`);
  const rejected = team.s.verdicts[`${n}:${pr.headRefOid}`]?.verdict === 'CHANGES' || team.ciState(pr) === 'red';
  if (!rejected) refuse(`PR #${n} has no CHANGES verdict or red CI on its current head; nothing to fix`);
  const running = await fixJobRunning(team, n);
  if (running.length) refuse(`PR #${n} has a fix job running (${running.join(', ')})`);
  const prior = (team.s.extraFix ||= {})[n];
  if (prior?.head === pr.headRefOid) refuse(`PR #${n} already had its extra fix round at this head${prior.spent ? '' : ' and it has not started yet'}`);
  const agent = chooseFixer(team, pr, model);
  team.s.extraFix[n] = { head: pr.headRefOid, agent, spent: false, why: reason, at: team.clock.now() };
  team.save();
  logOf(team, { target: n, what: `allowed one more fix round on ${agent}`, why: approvedWhy(reason), result: `granted at ${pr.headRefOid.slice(0, 7)}` });
  return `PR #${n} may have one more fix job at ${pr.headRefOid.slice(0, 7)}, written by ${agent}; the fix limit and churn stop apply again after it`;
}

// ---- close_superseded ------------------------------------------------------------------------------------------------------------------
export function parseSuperseders(text, self) {
  const nums = [...new Set(String(text ?? '').split(/[\s,#]+/).filter(Boolean).map(Number))];
  if (!nums.length || nums.some(x => !Number.isSafeInteger(x) || x < 1)) refuse('superseded_by must list the superseding issue or pull request numbers, e.g. "12, 13"');
  if (nums.length > MAX_SUPERSEDERS) refuse(`superseded_by lists more than ${MAX_SUPERSEDERS} items`);
  if (nums.includes(self)) refuse(`#${self} cannot supersede itself`);
  return nums;
}
async function exists(team, n) {
  const found = async fn => { try { return !!(await fn(n)); } catch { return false; } };
  return (await found(x => team.gh.getPull(x))) || (await found(x => team.gh.getIssue(x)));
}
const writesOf = team => (team.gh.saveBranch && team.gh.closeItem ? team.gh : closeWrites(team.c.repository));

export async function closeSuperseded(team, { target, superseded_by: by, reason }) {
  const n = Number(target), nums = parseSuperseders(by, n), pr = await openPull(team, n);
  const issue = pr ? null : (await team.gh.listIssues()).find(i => i.number === n && i.state === 'OPEN');
  if (!pr && !issue) refuse(`#${n} is not open; nothing changed`);
  const missing = [];
  for (const x of nums) if (!(await exists(team, x))) missing.push(`#${x}`);
  if (missing.length) refuse(`superseding ${missing.join(', ')} not found; nothing changed`);
  const live = await liveJobsFor(n, { jobs: team.jobs, records: team.s.jobs });
  if (live.length) refuse(`#${n} has a running job (${live.join(', ')}); stop it first`);
  const w = writesOf(team), what = pr ? 'pull request' : 'issue';
  let saved = '';
  if (pr) {
    if (!SHA.test(pr.headRefOid)) refuse(`PR #${n} has no usable head to save`);
    const name = `saved/pr-${n}-${String(pr.headRefName).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 50)}-${pr.headRefOid.slice(0, 7)}`;
    await w.saveBranch(name, pr.headRefOid);
    saved = ` Its branch is kept as \`${name}\`.`;
  }
  const names = nums.map(x => `#${x}`).join(', ');
  const marker = `Closed as superseded by ${names}.`;
  if (!(await team.gh.hasComment(n, marker))) await team.gh.comment(n, `${marker}${saved} Reason: ${reason}`);
  await w.closeItem(n, pr ? 'pull' : 'issue');
  logOf(team, { target: n, tk: pr ? 'pull' : 'issue', what: `closed the ${what} as superseded by ${names}`, why: approvedWhy(reason), result: saved ? 'branch saved, closed' : 'closed' });
  return `${what} #${n} closed, superseded by ${names}${saved ? '; branch saved' : ''}`;
}

// ---- resume_breaker --------------------------------------------------------------------------------------------------------------------
// Clears the scope as `team breaker resume` does and records who and why on the resume entry the breaker keeps
// (no unblock-log row: it has no pull request or issue to link).
export function resumeBreaker(team, { target, reason }) {
  const cleared = breaker.resume(team.s.breaker, target, team.clock.now());
  if (!cleared.length) refuse(`no breaker halt for ${target} (it was already resumed or never tripped); nothing changed`);
  const entry = team.s.breaker.resumes.at(-1);
  entry.by = 'homeowner (approved on the dashboard)';
  entry.why = reason;
  team.save();
  return `circuit breaker resumed: ${cleared.join(', ')}`;
}

// The routine actions the team applies; returns the outcome text. Unknown names are the caller's.
export async function applyRoutine(team, item) {
  if (item.action === 'extra_fix_round') return extraFixRound(team, item);
  if (item.action === 'close_superseded') return closeSuperseded(team, item);
  if (item.action === 'resume_breaker') return resumeBreaker(team, item);
  return unparkApproved(Number(item.target), depsOf(team));   // issue #1115
}
