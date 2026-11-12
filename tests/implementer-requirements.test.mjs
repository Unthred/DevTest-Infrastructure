import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Team, ciFixPrompt, continuePrompt, fixPrompt, implementPrompt, reviewPrompt } from '../supervisor/team.mjs';
import { afterInstallRows, requirementsTableError } from '../supervisor/requirements-table.mjs';
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
