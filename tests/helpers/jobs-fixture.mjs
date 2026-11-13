// Issue #1220: a dashboard view over the two real job records (a blocked rebase of PR #1180 and its completed review) plus a few small
// made-up jobs for the cases the real two do not cover (a job with no reported cost, an older job on another agent). Shared by the unit
// tests and the browser test, which serves the same records from disk.
import fs from 'node:fs';
import { buildView } from '../../supervisor/dashboard.mjs';

export const NOW = 1794490000000;   // shortly after the real review ended
export const REBASE_ID = '60b46719080fc517fd9d569569d1c6cf';
export const REVIEW_ID = '91896f66e3a13601da39343a670fe8ea';
const dir = new URL('../fixtures/jobs-table/', import.meta.url);
const read = name => JSON.parse(fs.readFileSync(new URL(name, dir), 'utf8'));

export const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } });

// Made up, and named as such by the 'fake' id prefix: no reported usage (unknown tokens and cost), and an old codex implement job.
export const extraJobs = () => [
  { id: 'f1'.repeat(16), provider: 'claude', kind: 'implement', issue: 30, branch: 'claude/issue-30-x', status: 'failed', createdAt: NOW - 3600000, updatedAt: NOW - 3000000, attempts: 1, role: 'devtest', model: 'sonnet', effort: 'low' },
  { id: 'c0'.repeat(16), provider: 'codex', kind: 'implement', issue: 2, branch: 'codex/issue-2-z', status: 'completed', createdAt: NOW - 20 * 86400000, updatedAt: NOW - 20 * 86400000 + 600000, attempts: 1,
    usage: { inputTokens: 1000, outputTokens: 500, costUsdEstimate: 0.2 }, model: 'gpt', effort: 'medium' },
];

export function jobRecords() { return [read('job-60b46719.json'), read('job-91896f66.json'), ...extraJobs()]; }
export function stateRecords() {
  const jobs = read('state-jobs.json');
  const rec = read('failcause-60b46719.json');
  return { jobs, failCauses: { records: { [REBASE_ID]: rec }, drafted: {} } };
}

export async function fixtureView({ jobs = jobRecords(), state = stateRecords(), needsYou = null } = {}) {
  const cache = { tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, pulls: [], issues: [{ number: 30, title: 'Thirty', state: 'OPEN', labels: [] }] };
  const view = await buildView({ config: config(), root: '/nonexistent-root', jobs, events: [], state, cache, snapshots: [], now: NOW });
  if (needsYou) view.panels.needsYou = needsYou;
  return view;
}
