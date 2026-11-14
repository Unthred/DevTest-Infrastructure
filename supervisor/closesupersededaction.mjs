// Issue #1337: the approved inbox action close_superseded. It closes a pull request or an issue with a comment naming what replaces it, after
// saving a pull request's branch under saved/. Every check comes first and a refusal (a SupervisorError, so the item ends failed with its
// reason) happens before the first write; then the branch is saved, then the comment is posted once, then the item is closed.
// This module imports nothing from the team module: the team passes itself in.
import { SupervisorError } from './core.mjs';
import { liveJobsFor } from './livejobs.mjs';
import { SAVED_PREFIX } from './ghclose.mjs';

export const MAX_SUPERSEDERS = 5;
const SHA = /^[0-9a-f]{40}$/;
const BRANCH_CHARS = 50;
const refuse = text => { throw new SupervisorError(text); };

// "12, 13" -> [12, 13]. Repeats count once.
export function parseSuperseders(text, self) {
  const nums = [...new Set(String(text ?? '').split(',').map(part => part.trim()).filter(Boolean).map(Number))];
  if (!nums.length || nums.some(n => !Number.isSafeInteger(n) || n < 1)) refuse('superseded_by must list the superseding issue or pull request numbers, e.g. "12, 13"');
  if (nums.length > MAX_SUPERSEDERS) refuse(`superseded_by lists more than ${MAX_SUPERSEDERS} items`);
  if (nums.includes(self)) refuse(`#${self} cannot supersede itself`);
  return nums;
}

// pr-<number>-<branch, made safe and cut to 50 characters>-<7 character commit>, under the saved prefix.
export function savedBranchName(pr) {
  const branch = String(pr.headRefName).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, BRANCH_CHARS);
  return `${SAVED_PREFIX}pr-${pr.number}-${branch}-${pr.headRefOid.slice(0, 7)}`;
}

async function exists(gh, n) {
  const found = async read => { try { return Boolean(await read(n)); } catch { return false; } };
  return (await found(x => gh.getPull(x))) || (await found(x => gh.getIssue(x)));
}

// The open target: a pull request or an issue. Throws when it is neither.
async function openTarget(gh, n) {
  const pr = (await gh.listPulls()).find(p => p.number === n);
  if (pr) return { pr };
  const issue = (await gh.listIssues()).find(i => i.number === n && String(i.state).toUpperCase() === 'OPEN');
  return issue ? { issue } : refuse(`#${n} is not open; nothing changed`);
}

async function checkAll(team, n, by) {
  const nums = parseSuperseders(by, n);
  const found = await openTarget(team.gh, n);
  const missing = [];
  for (const x of nums) if (!(await exists(team.gh, x))) missing.push(`#${x}`);
  if (missing.length) refuse(`superseding ${missing.join(', ')} not found as an issue or pull request; nothing changed`);
  const live = await liveJobsFor(n, { jobs: team.jobs, records: team.s.jobs });
  if (live.length) refuse(`#${n} has a running job (${live.join(', ')}); stop it first; nothing changed`);
  if (found.pr && !SHA.test(found.pr.headRefOid)) refuse(`PR #${n} has no usable head to save; nothing changed`);
  return { nums, ...found };
}

// Returns null for every other action, so the team's inbox pass can try it before its own switch.
export const closeSupersededApproved = (team, item) => (item.action === 'close_superseded' ? closeSuperseded(team, item) : null);

export async function closeSuperseded(team, { target, superseded_by: by, reason }) {
  const n = Number(target);
  const { nums, pr } = await checkAll(team, n, by);
  const what = pr ? 'pull request' : 'issue';
  const names = nums.map(x => `#${x}`).join(', ');
  let kept = '';
  if (pr) {
    const name = savedBranchName(pr);
    await team.gh.saveBranch(name, pr.headRefOid);
    kept = ` Its branch is kept as \`${name}\`.`;
  }
  const marker = `Closed as superseded by ${names}.`;
  if (!(await team.gh.hasComment(n, marker))) await team.gh.comment(n, `${marker}${kept} Reason: ${reason}`);
  await team.gh.closeItem(n, pr ? 'pull' : 'issue');
  team.logUnblock({}, { target: n, tk: pr ? 'pull' : 'issue', what: `closed the ${what} as superseded by ${names}`, why: `homeowner approved on the dashboard: ${reason}`, result: kept ? 'branch saved, closed' : 'closed' });
  return `${what} #${n} closed, superseded by ${names}${kept ? '; branch saved' : ''}`;
}
