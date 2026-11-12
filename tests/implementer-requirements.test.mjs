import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Team, ciFixPrompt, continuePrompt, fixPrompt, implementPrompt, reviewPrompt } from '../supervisor/team.mjs';
import { afterInstallRows, requirementsTableError } from '../supervisor/requirements-table.mjs';
import { rowRefusal } from '../supervisor/requirements-rows.mjs';
import { markDone } from '../supervisor/afterinstall.mjs';
import { prompt as corePrompt } from '../supervisor/core.mjs';

const HEAD = 'a'.repeat(40);
const valid = `## Requirements check

| Requirement | Status | Evidence |
| --- | --- | --- |
| Opens a PR only after a check | Met | supervisor/team.mjs:1; node --test |
`;

const temp = t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR, 'implementer-requirements-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const pull = body => ({ number: 19, headRefName: 'codex/issue-19-check', headRefOid: HEAD, body });

function team(t, body, { isDraft = false } = {}) {
  const pr = { ...pull(body), isDraft };
  return new Team({
    config: {
      schema_version: 1,
      enabled: true,
      repository: 'o/r',
      repo_path: '/repo',
      worktree_base: '/work',
      access: { mode: 'full', decision: 'D-020' },
      limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
      agents: { codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
      board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }
    },
    root: path.join(temp(t), 'state'),
    gh: {
      getPull: async () => pr,
      listPulls: async () => [pr],
      pullBody: async () => pr.body
    },
    jobs: {},
    git: {}
  });
}

test('valid requirements table accepts the PR; an unmet row names the blocker', async t => {
  assert.equal(requirementsTableError(valid), null);
  const accepted = team(t, valid);
  assert.equal(await accepted.postconditions()({ kind: 'implement', postcondition: { kind: 'pr_opened', branch: 'codex/issue-19-check' } }), true);
  const rejected = team(t, valid.replace('| Met |', '| Not met |'));
  const job = { kind: 'implement', postcondition: { kind: 'pr_opened', branch: 'codex/issue-19-check' } };
  assert.equal(await rejected.postconditions()(job), false);
  assert.match(job.postconditionDetail, /Opens a PR only after a check.*Not met/);
});

test('a homeowner-only row needs the stated reason, and a fix cannot complete without a valid table', async t => {
  const homeowner = valid.replace('| Met |', '| Homeowner-only |').replace('node --test', 'Needs homeowner credentials for the live account');
  assert.equal(requirementsTableError(homeowner), null);
  assert.match(requirementsTableError(homeowner.replace('homeowner credentials', 'a later decision')), /Homeowner-only/);
  const checked = team(t, valid.replace('| Met |', '| Not met |'));
  const job = { kind: 'fix', postcondition: { kind: 'new_head', pr: 19, baseHead: 'b'.repeat(40) } };
  assert.equal(await checked.postconditions()(job), false);
  assert.match(job.postconditionDetail, /Not met/);
});

test('drafts may record unfinished work, but a continue job cannot ready one without a valid table', async t => {
  const incomplete = valid.replace('| Met |', '| Not met |');
  const draft = team(t, incomplete, { isDraft: true });
  const opened = { kind: 'implement', postcondition: { kind: 'pr_opened', branch: 'codex/issue-19-check' } };
  assert.equal(await draft.postconditions()(opened), true);

  const ready = team(t, incomplete);
  const job = { kind: 'continue', postcondition: { kind: 'continued', pr: 19, baseHead: HEAD } };
  assert.equal(await ready.postconditions()(job), false);
  assert.match(job.postconditionDetail, /Not met/);
  assert.equal(await team(t, valid).postconditions()({ kind: 'continue', postcondition: { kind: 'continued', pr: 19, baseHead: HEAD } }), true);
});

test('writer prompts require the table, claim check and real runtime path; reviewers receive it', () => {
  const implement = implementPrompt({ issue: 19, branch: 'codex/issue-19-check' });
  const fix = fixPrompt({ pr: 19, head: HEAD, branch: 'codex/issue-19-check' });
  const ciFix = ciFixPrompt({ pr: 19, head: HEAD, branch: 'codex/issue-19-check', checks: [], checkDetails: [] });
  const continued = continuePrompt({ pr: 19, issue: 19, head: HEAD, branch: 'codex/issue-19-check' });
  const review = reviewPrompt({ pr: 19, head: HEAD, branch: 'codex/issue-19-check', repository: 'o/r', inbox: '/inbox' });
  for (const prompt of [implement, fix, ciFix, continued]) {
    assert.match(prompt, /Requirements check/);
    assert.match(prompt, /every issue requirement/);
    assert.match(prompt, /Check every PR-description claim against the diff/);
    assert.match(prompt, /`Not applicable`, only for a conditional requirement.*\(#N\).*still open or not merged/);
    assert.match(prompt, /real entry point.*parent processes or concurrent passes/);
  }
  assert.match(review, /implementer's `## Requirements check` table/);
});

const afterRow = '| Foreman lists the failed jobs on Tower | After install | Checked by the homeowner on Tower after install |';

test('an After install row passes the post condition and stays visible', async t => {
  const body = `${valid}${afterRow}\n`;
  assert.equal(requirementsTableError(body), null);
  assert.deepEqual(afterInstallRows(body).map(r => r.requirement), ['Foreman lists the failed jobs on Tower']);
  const job = { kind: 'implement', postcondition: { kind: 'pr_opened', branch: 'codex/issue-19-check' } };
  assert.equal(await team(t, body).postconditions()(job), true);
});

test('a PR with only After install rows left counts as delivered, a before-PR Homeowner-only row still fails with the named rule', async t => {
  const onlyAfter = `${valid}${afterRow}\n`;
  assert.equal(await team(t, onlyAfter).postconditions()({ kind: 'implement', postcondition: { kind: 'pr_opened', branch: 'codex/issue-19-check' } }), true);
  const bad = valid.replace('| Met |', '| Homeowner-only |').replace('node --test', 'a later decision') + afterRow + '\n';
  const job = { kind: 'implement', postcondition: { kind: 'pr_opened', branch: 'codex/issue-19-check' } };
  assert.equal(await team(t, bad).postconditions()(job), false);
  assert.match(job.postconditionDetail, /Opens a PR only after a check.*Homeowner-only/);
});

test('refusal text names the row and the allowed statuses and never asks to finish a post install check first', () => {
  const error = requirementsTableError(valid.replace('| Met |', '| Not met |'));
  assert.match(error, /Opens a PR only after a check/);
  assert.match(error, /Allowed statuses: Met, Homeowner-only.*After install/);
  assert.match(error, /set the status to After install/);
  assert.doesNotMatch(error, /finish it before the PR/);
  assert.match(requirementsTableError(`${valid}| Check on Tower | After install | later |\n`), /does not say who checks it/);
});

test('the second attempt prompt carries the refusal and says finished work stays', () => {
  const job = { role: 'r', kind: 'implement', issue: 19, worktree: '/w', scope: 's', allowedActions: ['read'], prompt: 'TASK', incompleteReason: { cause: 'postcondition_not_met', detail: 'requirement "X" is Not met. Allowed statuses: Met.' } };
  const text = corePrompt(job, true);
  assert.match(text, /requirement "X" is Not met/);
  assert.match(text, /do not redo it/);
});

test('the work item template has both lists', () => {
  const doc = fs.readFileSync(new URL('../docs/work-item-template.md', import.meta.url), 'utf8');
  assert.match(doc, /## Wanted \(before the PR\)/);
  assert.match(doc, /## After install \(checked on Tower\)/);
  assert.match(doc, /homeowner \| overseer/);
});

test('a merged and installed PR turns each After install row into a Needs you item until it is done', async () => {
  const { recordAfterInstall, markAfterInstallDone, afterInstallItems } = await import('../supervisor/afterinstall.mjs');
  const steps = {};
  recordAfterInstall(steps, 7, 'a'.repeat(40), `${valid}${afterRow}\n`, 1);
  const ctx = { steps, merged: [{ pr: 7 }], installed: new Set([7]) };
  assert.equal(afterInstallItems({ ...ctx, merged: [] }).length, 0, 'not merged yet');
  assert.equal(afterInstallItems({ ...ctx, installed: new Set() }).length, 0, 'not installed yet');
  const [item] = afterInstallItems(ctx);
  assert.equal(item.id, 'after-install-7');
  assert.match(item.text, /Foreman lists the failed jobs on Tower/);
  assert.match(item.action, /after-install-done 7/);
  recordAfterInstall(steps, 7, 'b'.repeat(40), `${valid}${afterRow}\n`, 2);
  assert.equal(afterInstallItems(ctx).length, 1, 'recording again does not end it');
  assert.equal(markAfterInstallDone(steps, 7), true);
  assert.equal(afterInstallItems(ctx).length, 0);
  assert.equal(markAfterInstallDone(steps, 99), false);
});

test('the dashboard decision table knows the after-install item', async () => {
  const { typeOf } = await import('../supervisor/decisiontable.mjs');
  assert.equal(typeOf('after-install-7'), 'after-install');
});

test('the Homeowner-only refusal points at After install', () => {
  assert.match(rowRefusal('Acceptance on Tower', 'Homeowner-only', 'needs Tower'), /set the status to After install/);
});

test('Not applicable needs evidence naming the open item its condition waits on', () => {
  assert.equal(rowRefusal('Browser test when V2 item 6 is merged', 'Not applicable', 'V2 item 6 (#1148) is still open'), null);
  assert.match(rowRefusal('Browser test when V2 item 6 is merged', 'Not applicable', 'not needed'), /does not name the open item/);
  assert.match(rowRefusal('Browser test', 'Not applicable', '#1148 was merged yesterday'), /does not name the open item/);
});

test('the review path records After install rows and afterInstallDone ends them', async t => {
  const tm = team(t, `${valid}${afterRow}\n`);
  await tm.applyDoneRule(19, HEAD, { verdict: 'PASS', findings: [] });
  assert.equal(tm.s.afterInstallSteps[19].rows.length, 1);
  markDone(tm.s, 19);
  assert.deepEqual(tm.s.afterInstallSteps[19].done, ['Foreman lists the failed jobs on Tower']);
  assert.throws(() => markDone(tm.s, 5), /no After install checks/);
});

test('the dashboard view lists the After install item of a PR once an upgrade record shows it installed', async t => {
  const { afterInstallAttention } = await import('../supervisor/afterinstall-view.mjs');
  const { recordAfterInstall } = await import('../supervisor/afterinstall.mjs');
  const root = temp(t);
  fs.mkdirSync(path.join(root, 'team'));
  const state = { afterInstallSteps: {}, mergeLog: [{ pr: 7 }] };
  recordAfterInstall(state.afterInstallSteps, 7, HEAD, `${valid}${afterRow}\n`, 1);
  const names = { pr: n => ({ text: `PR #${n}` }) };
  const view = () => afterInstallAttention({ state, root, names, config: { repository: 'o/r' } });
  assert.equal(view().length, 0);
  fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), `${JSON.stringify({ at: 1, prs: [7], result: 'verified' })}\n`);
  assert.deepEqual(view().map(i => i.id), ['after-install-7']);
});

test('issue #1184: an acceptance bullet that says after install cannot be marked Homeowner-only, even with a reason', () => {
  for (const req of ['Acceptance: on Tower after install, Needs you shows the outstanding steps', 'Acceptance: on Tower the check runs once installed']) {
    const refusal = rowRefusal(req, 'Homeowner-only', 'needs homeowner approval and credentials');
    assert.match(refusal, /set the status to After install/);
  }
  assert.equal(rowRefusal('Acceptance: on Tower after install, x', 'After install', 'Checked by the overseer'), null);
  assert.equal(rowRefusal('Create the GitHub App', 'Homeowner-only', 'needs homeowner credentials'), null);
});
