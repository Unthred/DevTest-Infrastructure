// Issue #1343: a saved stuck-split record reaches only its own open pull request page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { splitFacts } from '../supervisor/splitstuck-view.mjs';
import { tmpDir } from './helpers/tmp.mjs';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const HEAD = 'a'.repeat(40);
const config = () => ({
  schema_version: 1,
  enabled: true,
  repository: 'o/r',
  repo_path: '/p/r',
  worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' },
  github_app: { app_id: 1, installation_id: 2, key_file: '/nowhere/app.pem' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 4 },
  agents: { codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } },
});
const pull = {
  number: 1139,
  title: 'Split check fixture',
  state: 'OPEN',
  headRefName: 'codex/splitpr-1139',
  headRefOid: HEAD,
  baseRefName: 'main',
  isDraft: false,
  mergeable: 'MERGEABLE',
  labels: ['parked'],
  statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
  reviewDecision: '',
  closingIssuesReferences: [],
};
const record = {
  status: 'filed',
  parked: true,
  reason: '4 fix rounds (limit 4) have not cleared the review findings',
  items: [{ title: 'Capacity team', files: ['supervisor/capacityteam.mjs'] }, { title: 'Issue assignment', files: ['supervisor/issueassign.mjs'] }],
  filed: [2000, 2001],
};
const cache = pulls => ({
  tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 },
  fetchedAt: NOW - 60000,
  pulls,
  issues: [],
});
const viewFor = async (state, pulls = [pull]) => buildView({
  config: config(),
  root: tmpDir('split-stuck-view-'),
  jobs: [],
  events: [],
  state,
  cache: cache(pulls),
  snapshots: [],
  now: NOW,
  register: '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n',
});

test('split facts expose the parking reason and filed item links only for a saved record', () => {
  assert.equal(splitFacts({}, 1139), null);
  assert.deepEqual(splitFacts({ stuckSplits: { 1139: record } }, 1139), {
    reason: record.reason,
    status: 'the split is filed and waits for its items to merge',
    items: [
      { title: 'Capacity team', files: ['supervisor/capacityteam.mjs'], number: 2000 },
      { title: 'Issue assignment', files: ['supervisor/issueassign.mjs'], number: 2001 },
    ],
  });
});

test('the real dashboard view builder renders parked split facts and leaves other or closed pull requests unchanged', async () => {
  const state = { fixAttempts: {}, verdicts: {}, jobs: {}, stuckSplits: { 1139: record } };
  const view = await viewFor(state);
  assert.deepEqual(view.prs[0].split.items.map(item => item.number), [2000, 2001]);
  const html = renderRoute(view, { page: 'pr', id: 1139 }, { query: new URLSearchParams(), pathname: '/work/pr/1139' }).html;
  assert.match(html, /<dt>Parked<\/dt><dd>4 fix rounds/);
  assert.match(html, /<dt>Split items<\/dt><dd><a href="\/work\/issue\/2000">#2000<\/a> Capacity team/);

  const ordinary = await viewFor({ fixAttempts: {}, verdicts: {}, jobs: {}, stuckSplits: {} });
  const ordinaryHtml = renderRoute(ordinary, { page: 'pr', id: 1139 }, { query: new URLSearchParams(), pathname: '/work/pr/1139' }).html;
  assert.equal(ordinary.prs[0].split, null);
  assert.doesNotMatch(ordinaryHtml, /<dt>Parked<\/dt>|<dt>Split items<\/dt>/);

  const closed = await viewFor(state, []);
  assert.deepEqual(closed.prs, []);
  assert.equal(renderRoute(closed, { page: 'pr', id: 1139 }).status, 404);
});
