// Issue #1378: the Queued items tile counts each pull request once. The view comes from the real dashboard view builder, from fixture
// state shaped like the queues of 13 Nov 2026 22:45 UTC: 17 pull request entries, 8 review entries and 1 issue, 18 distinct items.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView } from '../supervisor/dashboard.mjs';
import { queueSplit, renderRoute } from '../supervisor/dashrender.mjs';

const NOW = Date.UTC(2026, 10, 13, 22, 45, 0);
const H = n => String(n).repeat(40).slice(0, 40);
const RED = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
const GREEN = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const PENDING = [{ status: 'IN_PROGRESS', conclusion: null }];
const agent = (provider, issues = []) => ({ provider, branch_prefix: `${provider}/`, issues });
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: agent('claude', [9000]), codex: agent('codex'), gemini: agent('gemini') },
};
const pull = (number, over = {}) => ({
  number, title: `PR ${number}`, headRefName: `claude/issue-${number}-x`, headRefOid: H(number % 9 + 1), baseRefName: 'main',
  isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: GREEN, labels: [], ...over });
const CHANGES = { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 5000, findings: ['x'] };

function viewOf(t, pulls, state = { jobs: {} }, issues = []) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'qs-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cache = { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, delivered: [], pulls, issues };
  return buildView({ config, root, jobs: [], events: [], state, cache, snapshots: [], now: NOW });
}
const entries = view => Object.values(view.queues).flat();
const total = n => n.implement + n.review + n.fix + n.rebase + n.waiting + n.held;

test('the 13 Nov 2026 queues: 26 entries for 18 distinct items count as 18, not 26', async t => {
  const reviewed = [1324, 1358, 1359, 1371];
  const pulls = [
    ...reviewed.map(n => pull(n)),
    pull(1400, { statusCheckRollup: RED }),
    pull(1401, { statusCheckRollup: PENDING }),
    pull(1402, { mergeable: 'CONFLICTING' }),   // a PASS that cannot merge: rebase work
    ...Array.from({ length: 8 }, (_, i) => pull(1410 + i, { statusCheckRollup: RED, labels: [] })),
    pull(1420, { isDraft: true }), pull(1421, { statusCheckRollup: PENDING }),
  ];
  assert.equal(pulls.length, 17);
  const pass = { verdict: 'PASS', reviewer: 'codex', at: NOW - 5000 };
  const state = { verdicts: { [`1402:${H(1402 % 9 + 1)}`]: pass }, jobs: {} };
  const issues = [{ number: 9000, title: 'Next issue', state: 'OPEN', labels: [], body: '' }];
  const view = await viewOf(t, pulls, state, issues);
  const all = entries(view);
  assert.equal(all.filter(e => e.type === 'pr').length, 17);
  assert.equal(all.filter(e => e.type === 'review').length, 8);
  assert.equal(all.filter(e => e.type === 'issue').length, 1);
  for (const n of reviewed) assert.equal(all.filter(e => e.type === 'review' && e.ref === n).length, 2);
  const n = queueSplit(view);
  assert.equal(n.total, 18);
  assert.equal(n.review, 4);
  assert.equal(n.implement, 1);
  assert.equal(n.rebase, 1);
  assert.equal(total(n), n.total);
  const html = renderRoute(view, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  assert.match(html, /4 review/);
});

test('a rebase carry waiting for CI counts as waiting, and a plain conflict still counts as rebase', async t => {
  const view = await viewOf(t, [pull(1, { mergeable: 'CONFLICTING', statusCheckRollup: RED })], { jobs: {} });
  assert.deepEqual(queueSplit(view), { implement: 0, review: 0, fix: 1, rebase: 0, waiting: 0, held: 0, total: 1 });   // red CI is fix work
  const carryText = 'the rebase carry is waiting for CI; no review starts for this head until it is recorded or refused';
  const entries = [{ type: 'pr', ref: 5, reason: carryText }, { type: 'pr', ref: 6, reason: 'PASS from codex but not mergeable (conflicting)' }];
  const carry = { queues: { claude: entries } };
  assert.deepEqual(queueSplit(carry), { implement: 0, review: 0, fix: 0, rebase: 1, waiting: 1, held: 0, total: 2 });
});

test('a pull request at the fix limit counts as held and not as fix; the tile text shows the held figure', async t => {
  const key = `7:${H(7 % 9 + 1)}`;
  const state = { fixAttempts: { [key]: 2 }, verdicts: { [key]: CHANGES }, unblock: { escalated: { 7: true } }, jobs: {} };   // the final round already ran
  const view = await viewOf(t, [pull(7, { labels: ['needs-homeowner'] }), pull(8, { statusCheckRollup: RED })], state);
  assert.match(entries(view).find(e => e.ref === 7).reason, /fix limit reached/);
  const n = queueSplit(view);
  assert.equal(n.held, 1);
  assert.equal(n.fix, 1);
  assert.equal(n.total, 2);
  const html = renderRoute(view, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  assert.match(html, /1 held for the homeowner or the fix limit/);
  const none = renderRoute(await viewOf(t, [pull(8, { statusCheckRollup: RED })]), { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  assert.doesNotMatch(none, /held for the homeowner/);
});

test('boundary: an empty queue gives all zeros; one pull request with two reviewers gives review 1', async t => {
  assert.deepEqual(queueSplit({ queues: {} }), { implement: 0, review: 0, fix: 0, rebase: 0, waiting: 0, held: 0, total: 0 });
  assert.deepEqual(queueSplit({}), { implement: 0, review: 0, fix: 0, rebase: 0, waiting: 0, held: 0, total: 0 });
  const view = await viewOf(t, [pull(3)]);
  assert.equal(entries(view).filter(e => e.type === 'review').length, 2);
  assert.deepEqual(queueSplit(view), { implement: 0, review: 1, fix: 0, rebase: 0, waiting: 0, held: 0, total: 1 });
});

test('invalid: an entry with no type or reason counts as waiting and never throws', () => {
  const odd = { queues: { claude: [{}, { ref: 4 }, { type: 'pr', ref: 5, reason: null }] } };
  assert.deepEqual(queueSplit(odd), { implement: 0, review: 0, fix: 0, rebase: 0, waiting: 3, held: 0, total: 3 });
});
