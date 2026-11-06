// Overseer job 211f3615: Needs you is short and trustworthy. Fixtures replay the real audit cases without private details.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView, healthOf } from '../supervisor/dashboard.mjs';
import { compactIssues } from '../supervisor/dashdata.mjs';
import { consolidateNeedsYou, needsYouCount } from '../supervisor/needsyou.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = 1_800_000_000_000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n\n## D-021 — y\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n';
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, review: { model: 'opus', effort: 'medium' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, extra = {}) => ({ number: n, title: `t${n}`, headRefName: `claude/issue-${n}-x`, headRefOid: H(n % 9 + 1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [], ...extra });
const iss = (number, extra = {}) => ({ number, title: `issue ${number}`, state: 'OPEN', body: '', labels: [], ...extra });
async function view(t, { issues = [], pulls = [], state = {}, jobs = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nyc-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  return buildView({ config: config(), root, jobs, events: [], state, register: REGISTER, snapshots: [], now: NOW,
    cache: { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls, issues: compactIssues(issues) } });
}
const item = (id, ref, extra = {}) => ({ id, text: `text ${id}`, ref, severity: 'action', action: `act ${id}`, ...extra });
const cache = { pulls: [{ number: 5 }, { number: 6 }], issues: [{ number: 10, state: 'OPEN' }, { number: 11, state: 'CLOSED' }] };

test('real item appears; a card with an unrelated or missing ref stays', () => {
  const r = consolidateNeedsYou([item('fixlimit-5', { kind: 'pull', n: 5 }), item('tick-failed', null)], { cache });
  assert.deepEqual(r.needsYou.map(i => i.id).sort(), ['fixlimit-5', 'tick-failed']);
});
test('stale clears itself: closed PR, closed issue and epic issue drop out on the next pass', () => {
  const r = consolidateNeedsYou([item('homeowner-pr-7', { kind: 'pull', n: 7 }), item('stale-mark-11', { kind: 'issue', n: 11 }), item('homeowner-10', { kind: 'issue', n: 10 })], { cache });
  assert.deepEqual(r.needsYou.map(i => i.id), ['homeowner-10']);
  assert.deepEqual(r.dropped.map(d => d.id).sort(), ['homeowner-pr-7', 'stale-mark-11']);
});
test('information stays out: an item flagged homeowner:false becomes a notice, never counted', () => {
  const r = consolidateNeedsYou([item('stalled-5', { kind: 'pull', n: 5 }, { homeowner: false })], { cache });
  assert.equal(r.needsYou.length, 0); assert.equal(r.notices[0].severity, 'info');
});
test('non-action severities are not listed', () => {
  assert.equal(consolidateNeedsYou([{ id: 'drift', text: 'x', severity: 'warning', ref: null }], { cache }).needsYou.length, 0);
});
test('duplicates merge: three causes on one issue are one item with a count and history (the real #494 shape)', () => {
  const ref = { kind: 'issue', n: 10 };
  const r = consolidateNeedsYou([item('stale-mark-10', ref, { since: 100 }), item('job-' + 'a'.repeat(32), ref, { since: 300 }), item('homeowner-10', ref)], { cache });
  assert.equal(r.needsYou.length, 1); const m = r.needsYou[0];
  assert.equal(m.count, 3); assert.equal(m.causes.length, 3); assert.equal(m.since, 100); assert.match(m.text, /3 causes/);
  assert.equal(m.id.startsWith('job-'), true, 'the job is the most specific cause');
});
test('a review limit and a self-check on one PR merge into one item', () => {
  const ref = { kind: 'pull', n: 5 };
  const r = consolidateNeedsYou([item('selfcheck-review-5', ref), item('reviewlimit-5', ref)], { cache });
  assert.equal(r.needsYou.length, 1); assert.equal(r.needsYou[0].id, 'reviewlimit-5'); assert.match(r.needsYou[0].action, /Also open/);
});
test('order: whole-system items, then what blocks the most issues, then the oldest', () => {
  const c = { pulls: [], issues: [{ number: 10, state: 'OPEN' }, { number: 20, state: 'OPEN', prerequisites: [10] }, { number: 21, state: 'OPEN', prerequisites: [10] }, { number: 30, state: 'OPEN' }, { number: 31, state: 'OPEN' }] };
  const r = consolidateNeedsYou([item('homeowner-31', { kind: 'issue', n: 31 }, { since: 1 }), item('homeowner-30', { kind: 'issue', n: 30 }, { since: 2 }), item('homeowner-10', { kind: 'issue', n: 10 }, { since: 9 }), item('tick-failed', null)], { cache: c });
  assert.deepEqual(r.needsYou.map(i => i.id), ['tick-failed', 'homeowner-10', 'homeowner-31', 'homeowner-30']);
});

test('a stopped PR at the fix limit raises exactly one item and the queue stops promising a free slot', async t => {
  const head = H(1);
  const v = await view(t, { pulls: [pr(1, { headRefOid: head, labels: ['needs-homeowner'] })], state: { verdicts: { [`1:${head}`]: { verdict: 'CHANGES', reviewer: 'x' } }, fixAttempts: { [`1:${head}`]: 2 }, jobs: {}, unblock: { escalated: { 1: true }, pr: {}, day: {}, log: [] } } });
  assert.deepEqual(v.panels.needsYou.map(i => i.id), ['fixlimit-1']);
  const q = JSON.stringify(v.queues); assert.ok(!/fix waits for a free slot/.test(q), q); assert.match(q, /fix limit reached \(2 rounds\)/);
});
test('below the fix limit the queue may still say the fix waits for a slot, and no item is raised', async t => {
  const head = H(1);
  const v = await view(t, { pulls: [pr(1, { headRefOid: head })], state: { verdicts: { [`1:${head}`]: { verdict: 'CHANGES', reviewer: 'x' } }, fixAttempts: { [`1:${head}`]: 1 }, jobs: {} } });
  assert.equal(v.panels.needsYou.length, 0); assert.match(JSON.stringify(v.queues), /fix (is next|waits for a free slot)/);
});
test('a stopped PR at the review limit raises an item', async t => {
  const head = H(1);
  const v = await view(t, { pulls: [pr(1, { headRefOid: head })], state: { verdicts: {}, reviewAttempts: { [`1:${head}:claude`]: 2 }, jobs: {} } });
  assert.ok(v.panels.needsYou.some(i => i.id === 'reviewlimit-1'));
});
test('a stalled PR that Foreman moves on by itself is a notice, one that waits for the homeowner is an item, one per PR', async t => {
  const heads = { 1: H(1), 2: H(2) };
  const stalls = { items: [
    { pr: 1, title: 'a', head: heads[1], since: NOW - 5 * 3600000, last: 'new head', reasons: [{ code: 'review-held', text: 'review held: the provider is out of allowance' }] },
    { pr: 2, title: 'b', head: heads[2], since: NOW - 6 * 3600000, last: 'new head', reasons: [{ code: 'homeowner', text: 'waiting for you to merge' }] }] };
  const v = await view(t, { pulls: [pr(1, { headRefOid: heads[1] }), pr(2, { headRefOid: heads[2] })], state: { stalls, verdicts: { [`1:${heads[1]}`]: { verdict: 'PASS', reviewer: 'x' }, [`2:${heads[2]}`]: { verdict: 'PASS', reviewer: 'x' } }, jobs: {} } });
  assert.deepEqual(v.panels.needsYou.map(i => i.id), ['stalled-2']);
  assert.ok(v.panels.warnings.some(w => w.id === 'stalled-1'));
});

test('one shared count: health, label, list and the MCP reading agree', async t => {
  const head = H(1);
  const ref = [pr(1, { headRefOid: head, labels: ['needs-homeowner'] })];
  const v = await view(t, { pulls: ref, issues: [iss(7)], state: { verdicts: { [`1:${head}`]: { verdict: 'CHANGES', reviewer: 'x' } }, fixAttempts: { [`1:${head}`]: 2 }, jobs: {}, unblock: { escalated: { 1: true }, pr: {}, day: {}, log: [] } } });
  assert.equal(v.health.count, v.panels.needsYou.length); assert.equal(v.health.label, `Needs you (${v.panels.needsYou.length})`); assert.equal(needsYouCount(v), v.panels.needsYou.length);
  // a warning in attention is not counted: the list and the count never differ by it
  assert.ok(v.attention.length >= v.panels.needsYou.length);
  assert.equal(healthOf({ attention: [{ severity: 'action' }, { severity: 'action' }], states: {}, needsYouCount: 1 }).count, 1);
  const src = fs.readFileSync(new URL('../foreman-mcp/tools.mjs', import.meta.url), 'utf8');
  assert.ok(!/needsYouCount: \(v\.attention/.test(src), 'the MCP status does not count attention items');
});
