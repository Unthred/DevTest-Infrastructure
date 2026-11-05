// A realistic Overview view with a chosen number of rows in each list, for the shared-list tests and the browser check.
// Built through buildView (the real data path), then the panel lists are filled to the wanted size. Fake data only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView } from '../../supervisor/dashboard.mjs';
import { compactIssues } from '../../supervisor/dashdata.mjs';
import { applyAction, readWatchlist } from '../../supervisor/watchlist.mjs';

export const NOW = Date.parse('2026-11-02T20:00:00Z');
const MIN = 60000;
export const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } } });
const issue = (n, state = 'OPEN', body = '', labels = []) => ({ number: n, title: `issue ${n}`, state, body, labels });
const tick = { at: NOW - MIN, status: 'ok', error: null, lastOkAt: NOW - MIN };
export async function overviewView({ needs = 0, warnings = 0, later = 0, next = 0, watching = 0, since = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lists-')); fs.chmodSync(root, 0o700);
  for (let n = 0; n < watching; n++) applyAction(root, { kind: 'issue', number: [30, 5, 2, 3][n % 4], action: 'watch', now: NOW - (n + 1) * MIN });
  const v = await buildView({ watchlist: readWatchlist(root), config: config(), root, jobs: [], events: [], state: {}, cache: { tick, fetchedAt: NOW - MIN, pulls: [], issues: compactIssues([issue(30), issue(5), issue(2), issue(3)]) }, snapshots: [], now: NOW, tz: 'UTC' });
  fs.rmSync(root, { recursive: true, force: true });
  v.panels.needsYou = Array.from({ length: needs }, (_, i) => ({ id: `homeowner-${i}`, severity: 'action', text: `Decision ${i + 1}: approve the plan for item ${100 + i}`, ref: { kind: 'issue', n: 100 + i }, decision: 'Approve or reject on the issue.', tried: i % 3 === 0 ? 'Tried twice.' : '', links: [], command: null, overseer: `note ${i}` }));
  v.panels.warnings = Array.from({ length: warnings }, (_, i) => ({ id: `ci-${i}`, severity: i % 4 === 0 ? 'info' : 'warning', text: `Warning ${i + 1} about pull request ${200 + i}`, ref: { kind: 'pull', n: 200 + i }, overseer: `w ${i}` }));
  v.panels.later = Array.from({ length: later }, (_, i) => ({ number: 300 + i, name: `Parked issue ${i + 1}`, url: `https://example.invalid/i/${300 + i}`, waits: 'a decision', ends: 'when decided' }));
  v.panels.next = Array.from({ length: next }, (_, i) => ({ agent: i % 2 ? 'codex' : 'claude', type: i % 3 ? 'implement' : 'review', ref: 400 + i, name: `Plan ${i}` }));
  for (const r of Object.values(v.since.ranges)) for (const k of ['merged', 'opened']) r[k] = Array.from({ length: since }, (_, i) => ({ text: `${k} item ${i + 1}`, url: `/work/pr/${500 + i}`, at: NOW - (i + 1) * 3600000 }));
  return v;
}
