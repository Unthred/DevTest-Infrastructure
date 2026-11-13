// Issue #1224: a queue of 21 items shaped like the real one on 12 Nov 2026, for the Work table tests and the browser check.
// Issue #1169 is rank 17 of 21 and held because #1157 is still open; PR #1180 is stopped by the retry cap; #1155 has a running job;
// #1171 needs the homeowner; PR #1178 waits for a review; PR #1179 was merged today. Fake titles; the data path is the real one
// (buildView over a cache, team state and job records), so the rows are what the dashboard builds from real files.
import fs from 'node:fs';
import path from 'node:path';
import { buildView } from '../../supervisor/dashboard.mjs';
import { compactIssues, compactPulls } from '../../supervisor/dashdata.mjs';
import { STATE_TEXT } from '../../supervisor/dependencies.mjs';

const HOUR = 3600000, MIN = 60000, DAY = 24 * HOUR;
// "Finished today" must stay today when the suite runs just after midnight UTC: two hours ago, or half the day so far if less.
const finishedAgo = now => Math.max(MIN, Math.min(2 * HOUR, (now % DAY) / 2));
export const HEAD = n => String(n).repeat(40).slice(0, 40);
export const JOB_ID = 'a'.repeat(32);
export const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, max_same_cause_attempts: 3 },
  agents: {
    claude: { provider: 'claude', branch_prefix: 'claude/', issues: [1153, 1154, 1155, 1156, 1157, 1158, 1159, 1160, 1161, 1162, 1169, 1170] },
    codex: { provider: 'codex', branch_prefix: 'codex/', issues: [1163, 1164, 1165, 1166, 1167, 1168, 1171] }
  }
});

export function workData(now) {
  const iso = ms => new Date(ms).toISOString();
  const issue = (number, extra = {}) => ({ number, title: `Work item ${number}`, state: 'OPEN', body: '', labels: [], createdAt: iso(now - 5 * DAY), ...extra });
  const open = [];
  for (let n = 1153; n <= 1168; n++) open.push(issue(n));
  open.push(issue(1169, { title: 'Table view of the queue', body: 'Depends on: #1157', labels: ['v2-ui'] }));
  open.push(issue(1170, { labels: ['v2-ui', 'docs'] }));
  open.push(issue(1171, { labels: ['needs-homeowner'] }));
  const closed = [issue(1149, { state: 'CLOSED', closedAt: iso(now - 4 * DAY) }), issue(1150, { state: 'CLOSED', closedAt: iso(now - 3 * DAY) }),
    issue(1152, { state: 'CLOSED', closedAt: iso(now - finishedAgo(now)) })];
  const green = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  const red = [{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }];
  const pr = (number, branch, checks) => ({ number, title: `Pull request ${number}`, headRefName: branch, headRefOid: HEAD(number % 10), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',
    statusCheckRollup: checks, createdAt: iso(now - 2 * DAY), url: `https://github.com/o/r/pull/${number}`, labels: [], closingIssuesReferences: [] });
  const pulls = [pr(1178, 'codex/issue-1150-x', green), pr(1180, 'claude/issue-1149-x', red)];
  const cache = { tick: { at: now - MIN, status: 'ok', error: null, lastOkAt: now - MIN }, fetchedAt: now - MIN, pulls: compactPulls(pulls), issues: compactIssues([...open, ...closed]),
    merged: [{ number: 1179, title: 'Pull request 1179', mergedAt: iso(now - finishedAgo(now)), headRefName: 'claude/issue-1152-x', closingIssuesReferences: [{ number: 1152 }] }], mergedNumbers: [1179],
    dependencies: { evaluatedAt: now - MIN, installed: null, issues: { 1169: { dependsOn: [{ number: 1157, state: 'open' }], malformed: null, line: 'Depends on: #1157', cycle: null,
      met: false, reasons: [`#1157 ${STATE_TEXT.open}`], since: now - 4 * HOUR } } } };
  const job = { id: JOB_ID, provider: 'claude', kind: 'implement', issue: 1155, branch: 'claude/issue-1155-x', status: 'running', createdAt: now - 20 * MIN, updatedAt: now - 1000,
    lastProgress: now - 1000, attempts: 1, usage: { inputTokens: 12000, outputTokens: 3000, costUsdEstimate: 0.42 } };
  const state = {
    jobs: { [JOB_ID]: { kind: 'implement', agent: 'claude', model: 'sonnet', issue: 1155 } },
    sameCause: { 'fix:1180': { cause: 'ci-failed', count: 3, head: HEAD(0), at: now - 3 * HOUR, raised: false } },
    verdicts: {}, fixAttempts: { [`1180:${HEAD(0)}`]: 3 },
    mergeLog: [{ pr: 1179, issue: 1152, agent: 'claude', mergedAt: now - finishedAgo(now) }]
  };
  return { cache, state, jobs: [job] };
}

export async function workView(now = Date.parse('2026-11-12T12:00:00Z')) {
  const { cache, state, jobs } = workData(now);
  return buildView({ config: config(), root: '/nonexistent-root', jobs, events: [], state, cache, snapshots: [], now, tz: 'UTC' });
}

// The same data as the files the dashboard reads, for the real request handler.
export function writeStateRoot(root, now = Date.now()) {
  const { cache, state, jobs } = workData(now);
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify(state));
  for (const j of jobs) fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j));
}
