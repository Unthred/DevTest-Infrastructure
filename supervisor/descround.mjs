// Issue #1226: a blocking finding that is only about the pull request description is answered by editing the description (a
// "description round"), not by a fix round that starts a fresh code session and pushes a new head. A description round pushes no
// commit, is counted apart from fix rounds, and ends by asking for a new review of the same head.
import crypto from 'node:crypto';
import { tablePostcondition } from './requirements-table.mjs';

export const FINDING_SCOPES = ['code', 'tests', 'description'];
export const DESCRIPTION_ROUND_LIMIT = 2;   // per pull request, in addition to the fix rounds (the fix limit is the homeowner's and is not changed here)

// A finding without a scope is a code finding: only an explicit "description" can take the cheap path.
export const findingScope = finding => (FINDING_SCOPES.includes(finding?.scope) ? finding.scope : 'code');

// A finding is exactly {kind, text} with an optional scope from FINDING_SCOPES.
export function hasFindingKeys(f) {
  const keys = Object.keys(f);
  return keys.length === (f.scope === undefined ? 2 : 3) && (f.scope === undefined || FINDING_SCOPES.includes(f.scope));
}

export function isDescriptionOnly(verdict) {
  if (verdict?.verdict !== 'CHANGES') return false;
  const blocking = (verdict.findings || []).filter(f => f.kind === 'blocking');
  return blocking.length > 0 && blocking.every(f => findingScope(f) === 'description');
}

export const descriptionRoundsOf = (state, pr) => Number(state.descRounds?.[pr]) || 0;

// Pure decision: { start, reason }. A refused third round is not a code round either; the existing fix loop then applies as before.
export function planDescriptionRound({ verdict, rounds, limit = DESCRIPTION_ROUND_LIMIT }) {
  if (!isDescriptionOnly(verdict)) return { start: false, reason: 'a blocking finding is about code or tests' };
  if (rounds >= limit) return { start: false, reason: `${rounds} description rounds already used (limit ${limit})` };
  return { start: true, reason: 'every blocking finding is about the description only' };
}

export function descriptionRoundFor(team, pr) {
  const verdict = team.s.verdicts[`${pr.number}:${pr.headRefOid}`];
  return planDescriptionRound({ verdict, rounds: descriptionRoundsOf(team.s, pr.number) }).start;
}

const bodyHash = body => crypto.createHash('sha256').update(String(body ?? '')).digest('hex');

export const descriptionPrompt = job => `${job.common}\n\nTask: description round on pull request #${job.pr} (head ${job.head}, branch ${job.branch}). `
  + 'The reviewer found that the only blocking problems are in the pull request description, not in the code or tests. '
  + `Read the verdict findings on the PR (gh pr view ${job.pr} --comments) and fix the description only: gh pr edit ${job.pr} --body-file <file>. `
  + 'Do not change, commit or push any file, and do not push a branch. Check every number and claim you touch against the diff and quote sizes, '
  + 'line counts and test counts from the output of node tools/ci/check-size.mjs and the test run, never from memory. '
  + `Keep the visible \`## Requirements check\` table with exactly \`Requirement | Status | Evidence\` columns and one row for every issue requirement. `
  + 'As the very last step save the description and the issue body to files in $TMPDIR and run '
  + '`node tools/check-requirement-cites.mjs --body <description file> --issue <issue file>`; fix everything it lists. '
  + 'The post-condition is an edited description on the same head. The dispatcher then asks for a new review of this head.';

// The scope, permissions, prompt and post-condition of a fix job; a description round has its own (it pushes nothing).
export async function roundSpec(team, act, common, fixPromptText) {
  if (!act.description) {
    return { scope: `Fix the CHANGES verdict on PR #${act.pr}`, allowed_actions: ['read', 'edit', 'test', 'push_feature_branch', 'update_issue'],
      prompt: fixPromptText, postcondition: { kind: 'new_head', pr: act.pr, baseHead: act.head } };
  }
  const bodyBefore = await team.gh.pullBody(act.pr);
  return { scope: `Description round on PR #${act.pr} (edit the pull request description only)`, allowed_actions: ['read', 'test', 'update_issue'],
    prompt: descriptionPrompt({ common, pr: act.pr, head: act.head, branch: act.branch }),
    postcondition: { kind: 'description_edited', pr: act.pr, baseHead: act.head, bodyHash: bodyHash(bodyBefore) } };
}

export function countRound(state, act) {
  if (!act.description) { state.fixAttempts[act.key] = (state.fixAttempts[act.key] || 0) + 1; return; }
  state.descRounds ||= {};
  state.descRounds[act.pr] = descriptionRoundsOf(state, act.pr) + 1;
}

// Post-condition: the same head, an edited body, and a body that still passes the requirements table and cite gate.
export async function descriptionEdited(team, p, job) {
  const pr = await team.gh.getPull(p.pr);
  if (!pr || pr.headRefOid !== p.baseHead) { job.postconditionDetail = 'a description round must not move the head'; return false; }
  if (bodyHash(await team.gh.pullBody(p.pr)) === p.bodyHash) { job.postconditionDetail = 'the pull request description was not edited'; return false; }
  return tablePostcondition(p, job, pr, team.gh.pullBody, team.gh);
}

// After a completed round the head's CHANGES verdict is archived and set aside, so the same head is reviewed again. Idempotent.
export async function finishDescriptionRound(team, id, j, report) {
  const key = `${j.pr}:${j.head}`;
  const verdict = team.s.verdicts[key];
  const pr = await team.gh.getPull(j.pr);
  if (verdict?.verdict !== 'CHANGES' || !isDescriptionOnly(verdict) || pr?.headRefOid !== j.head) return;
  team.archiveVerdict(key, verdict);
  delete team.s.verdicts[key];
  for (const k of Object.keys(team.s.reviewAttempts)) if (k.startsWith(`${key}:`)) delete team.s.reviewAttempts[k];
  team.save();
  (report.notified ||= []).push({ pr: j.pr, descriptionRound: id });
  await team.postNotice(j.pr, `description-round pr=${j.pr} head=${j.head} job=${id}`,
    `**Description round done.** Every blocking finding at \`${j.head}\` was about the description only, `
    + 'so the description was edited and no commit was pushed. '
    + `A new review of the same head follows. Description rounds used: ${descriptionRoundsOf(team.s, j.pr)} of ${DESCRIPTION_ROUND_LIMIT}.`);
}
