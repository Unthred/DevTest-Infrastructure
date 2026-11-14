// Issue #1334: a pull request the churn rule stopped below the fix limit gets a churn card instead of a needs-homeowner card.
// Goes through the real view builder, the Needs you consolidation and the decision cards the dashboard server attaches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView } from '../supervisor/dashboard.mjs';
import { withDecisionCards } from '../supervisor/decisioncards.mjs';
import { churnStopped } from '../supervisor/needsyou.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = 1_800_000_000_000;
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n\n## D-021 — y\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n';
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, review: { model: 'opus', effort: 'medium' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pull = head => ({ number: 1146, title: 't', headRefName: 'claude/issue-1100-x', headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE',
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], labels: ['needs-homeowner'], reviewDecision: '', closingIssuesReferences: [], url: 'https://github.com/o/r/pull/1146' });

async function needsYou(t, { fixes, notified, verdictHead = H(1), head = H(1) }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'churn-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const pulls = [pull(head)], cfg = { ...config(), github_app: { app_id: 1, installation_id: 2, key_file: '/k/app.pem' } };
  const state = { fixAttempts: { [`1146:${H(1)}`]: fixes }, verdicts: { [`1146:${verdictHead}`]: { verdict: 'CHANGES', reviewer: 'opus' } }, notified, jobs: {} };
  const view = await buildView({ config: cfg, root, jobs: [], events: [], state, register: REGISTER,
    cache: { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls, issues: [] }, snapshots: [], now: NOW });
  return withDecisionCards(view, cfg, { pulls }).panels.needsYou.filter(a => a.ref?.n === 1146);
}

test('churn stopped below the fix limit raises one churn card with action severity and the table controls', async t => {
  const items = await needsYou(t, { fixes: 2, notified: { [`churn:1146:${H(1)}`]: NOW } });
  assert.deepEqual(items.map(a => a.id.split('-')[0]), ['churn']);
  const [card] = items;
  assert.equal(card.id, 'churn-1146');
  assert.equal(card.severity, 'action');
  assert.match(card.text, /different blocking findings.*no further fix jobs/);
  assert.match(card.action, /Choose one:/);
  assert.equal(card.card.type, 'churn');
  assert.deepEqual(card.card.controls.map(c => c.action), ['park']);
});

test('at the fix limit only the fix limit card is raised', async t => {
  const items = await needsYou(t, { fixes: 3, notified: { [`churn:1146:${H(1)}`]: NOW } });
  assert.deepEqual(items.map(a => a.id), ['fixlimit-1146']);
});

test('without the churn marker the needs-homeowner card stays', async t => {
  const items = await needsYou(t, { fixes: 2, notified: {} });
  assert.deepEqual(items.map(a => a.id), ['homeowner-pr-1146']);
});

test('a marker for an older head gives no churn card', async t => {
  const items = await needsYou(t, { fixes: 2, head: H(2), verdictHead: H(2), notified: { [`churn:1146:${H(1)}`]: NOW } });
  assert.deepEqual(items.map(a => a.id), ['homeowner-pr-1146']);
});

test('churnStopped needs both the marker for the current head and a CHANGES verdict', () => {
  const pr = { number: 5, headRefOid: H(3) };
  const state = { notified: { [`churn:5:${H(3)}`]: 1 } };
  assert.equal(churnStopped(state, pr, 'CHANGES'), true);
  assert.equal(churnStopped(state, pr, 'PASS'), false);
  assert.equal(churnStopped(state, pr, undefined), false);
  assert.equal(churnStopped({}, pr, 'CHANGES'), false);
});
