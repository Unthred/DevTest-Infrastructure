import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../../supervisor/team.mjs';
import { stateRoot } from '../../supervisor/core.mjs';
import { blocks } from '../../supervisor/breaker.mjs';

const REGISTER = '## D-020 — full access\n- Status: homeowner-approved\n';

const configFor = state => ({
  schema_version: 1,
  enabled: true,
  repository: 'owner/repository',
  repo_path: '/repository',
  worktree_base: '/worktrees',
  access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2, rebaser: 1 }, overall: 3, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: {
    claude: { provider: 'claude', branch_prefix: 'claude/', issues: state.issues.filter(issue => issue.agent === 'claude').map(issue => issue.number) },
    codex: { provider: 'codex', branch_prefix: 'codex/', issues: state.issues.filter(issue => issue.agent === 'codex').map(issue => issue.number) },
  },
  board: {
    owner: 'owner',
    number: 1,
    project_id: 'project',
    status_field_id: 'status',
    options: { in_progress: 'in-progress', in_review: 'in-review', done: 'done' },
  },
  breaker: { enabled: true, window_hours: 6, same_cause_jobs: 3, cause_cost_usd: 5, global_cost_usd: 15, fix_issues: [] },
});

const copy = value => structuredClone(value);

export function createPlannerWorld(t, state) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planner-invariants-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pulls = copy(state.pulls);
  const issues = copy(state.issues);
  const gh = {
    listPulls: async () => pulls,
    listIssues: async () => issues,
    listMergedPulls: async () => [],
    getPull: async number => pulls.find(pull => pull.number === number) || null,
  };
  const activeJobs = copy(state.activeJobs || []);
  const jobs = { listActive: async () => activeJobs };
  const git = { worktreeFor: async () => null };
  const team = new Team({
    config: configFor(state),
    root: stateRoot(path.join(directory, 'state')),
    gh,
    jobs,
    git,
    register: REGISTER,
    clock: { now: () => 1000 },
    limitedOf: () => ({ out: false }),
  });
  team.s.verdicts = copy(state.verdicts || {});
  Object.assign(team.s.jobs, copy(state.jobRecords || {}));
  if (state.breaker) team.s.breaker = { ...team.s.breaker, ...copy(state.breaker) };
  return { team, pulls, issues };
}

const branchIssue = branch => Number(/\/issue-(\d+)(?:\D|$)/.exec(branch || '')?.[1]);

export function invariantViolations({ plan, pulls, issues, breaker }) {
  const pullByNumber = new Map(pulls.map(pull => [pull.number, pull]));
  const issueByNumber = new Map(issues.map(issue => [issue.number, issue]));
  const violations = [];
  const latestVerdict = action => {
    const pull = pullByNumber.get(action.pr);
    return pull ? breaker.verdicts?.[`${pull.number}:${pull.headRefOid}`] : null;
  };
  for (const action of plan) {
    const verdict = latestVerdict(action);
    if (action.type === 'merge' && verdict?.verdict === 'CHANGES') violations.push({ invariant: 'merge-current-changes', action });
    if (blocks(breaker.breaker, breaker.config.breaker, action)) violations.push({ invariant: 'breaker-halt', action });
    const pull = pullByNumber.get(action.pr);
    const issueNumber = action.issue ?? branchIssue(pull?.headRefName);
    const issue = issueByNumber.get(issueNumber);
    if (pull?.labels?.includes('parked') || issue?.labels?.includes('parked')) violations.push({ invariant: 'parked', action });
  }
  const counts = new Map();
  for (const action of plan) if (action.pr != null) counts.set(action.pr, (counts.get(action.pr) || 0) + 1);
  for (const [pr, count] of counts) if (count > 1) violations.push({ invariant: 'one-action-per-pr', pr, count });
  return violations;
}

export function assertPlanInvariants(context) {
  const violations = invariantViolations(context);
  assert.deepEqual(violations, [], `planner invariant failed; seed=${context.seed ?? 'fixture'} state=${JSON.stringify(context.state)}`);
}

export const validPlan = () => [{ type: 'implement', issue: 1 }];
