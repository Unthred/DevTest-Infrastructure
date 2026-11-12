// Issue #1222: the data of 12 Nov 2026 as a throwaway supervisor root, shared by the page test and the browser check:
// claude idle for 3 hours with planned fix PR #1180 and fix PR #1175 (no recorded reason on #1175), a rebase of #1180 held by its retry cap,
// codex paused on job db849b9f two hours past its resume time, with the message its resume check recorded.
import fs from 'node:fs';
import path from 'node:path';

export const NOW = Date.UTC(2026, 10, 12, 8, 0);
const H = 3600000;
export const JOB_ID = `db849b9f${'0'.repeat(24)}`;

export const config = root => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  inbox: { dir: path.join(root, 'inbox') }, github_app: { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: Object.fromEntries(['claude', 'codex'].map(n => [n, { provider: n, branch_prefix: `${n}/`, issues: [] }])) });

const pull = (number, title, labels = []) => ({ number, title, headRefName: `claude/issue-${number}-x`, headRefOid: 'a'.repeat(40), isDraft: false, labels, statusCheckRollup: [] });
export const planned = () => [
  { type: 'fix', agent: 'claude', ref: 1180, outcome: 'held', kind: 'slot', reason: 'slot full: the implementer slot is taken' },
  { type: 'fix', agent: 'claude', ref: 1175, outcome: 'held', kind: 'unexplained', reason: 'planned but neither started nor held, and no reason was recorded' },
  { type: 'rebase', agent: 'claude', ref: 1180, outcome: 'held', kind: 'retry_cap', reason: 'retry cap: 3 attempts with the same cause; needs the homeowner' }];
export const jobRecord = (id, provider, extra) => ({ id, provider, kind: 'implement', status: 'completed', createdAt: NOW - 4 * H, updatedAt: NOW - 3 * H, ...extra });

// Writes the root. `extraJobs` are added to the job records (for example a running job).
export function writeRoot(root, extraJobs = []) {
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000,
    pulls: [pull(1180, 'Fix the foo'), pull(1175, 'Fix the bar')], issues: [], planned: planned() }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
  const jobs = [jobRecord('c'.repeat(32), 'claude'),
    jobRecord(JOB_ID, 'codex', { status: 'paused_limit', createdAt: NOW - 5 * H, updatedAt: NOW - 3 * H, nextAttemptAt: NOW - 2 * H,
      resumeCheck: { message: 'resume check threw: lease file unreadable', firstAt: NOW - 2 * H, lastAt: NOW - 60000, count: 7 } }), ...extraJobs];
  for (const j of jobs) fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j));
}
