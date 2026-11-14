// Issue #1252: the attention classification table. The attention list comes from the real view builder (through the real dashboard
// handler, from fixture state); a few cases use hand made items for the cases no fixture reaches.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { ensureStartedAt } from '../supervisor/closedreason-store.mjs';
import { decisionCard } from '../supervisor/decisiontable.mjs';
import { decisionHtml } from '../supervisor/decisioncard-ui.mjs';
import { ATTENTIONS, KINDS, TABLE, TIERS, classify, findDeadEnds } from '../supervisor/api/attention.mjs';

const NOW = Date.UTC(2026, 10, 12, 13, 0, 0);
const H = n => String(n).repeat(40).slice(0, 40);
const RED = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
const GREEN = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [1185] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
};
const pull = (number, over = {}) => ({ number, title: `PR ${number}`, headRefName: `claude/issue-${number}-x`, headRefOid: H(1), baseRefName: 'main',
  isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: GREEN, labels: [], ...over });
const cacheOf = (pulls, issues = [], extra = {}) => ({
  tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, delivered: [], pulls, issues, ...extra,
});

const get = options => new Promise((resolve, reject) => {
  http.get(options, res => {
    let text = '';
    res.on('data', d => (text += d));
    res.on('end', () => resolve(text));
  }).on('error', reject);
});

// The attention list the dashboard builds from this state, as the page shows it: Needs you plus the warnings.
async function attentionFrom(t, { cache, state, jobs = [], started = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'attn-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const j of jobs) fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache));
  if (state) fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify(state));
  if (started) ensureStartedAt(root, started);
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => NOW }));
  const body = await get({ host: '127.0.0.1', port, path: '/api/view.json', headers: { host: `127.0.0.1:${port}` } });
  const view = JSON.parse(body);
  return [...view.panels.needsYou, ...view.panels.warnings];
}
const REJECTED = { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 5000, findings: ['x'] };
const FIX_LIMIT_STATE = { fixAttempts: { [`1192:${H(1)}`]: 4 }, verdicts: { [`1192:${H(1)}`]: REJECTED }, jobs: {} };
const fixLimitCache = () => cacheOf([pull(1192, { statusCheckRollup: RED, labels: ['needs-homeowner'] })]);
const byId = (items, id) => items.find(i => i.id === id);
const ALL = new Set(['work_item.allow_fix_round', 'work_item.accept_split', 'work_item.park', 'breaker.resume']);

test('real data: the fix limit item of PR 1192 (limit 3 reached after 4 review rounds) is homeowner, fix_limit_reached, with three actions', async t => {
  const items = await attentionFrom(t, { cache: fixLimitCache(), state: FIX_LIMIT_STATE });
  const item = byId(items, 'fixlimit-1192');
  assert.ok(item, `the builder made the item (${items.map(i => i.id)})`);
  const c = classify(item, ALL);
  assert.equal(c.kind, 'stuck_change');
  assert.equal(c.attention, 'homeowner');
  assert.equal(c.reason_code, 'fix_limit_reached');
  assert.deepEqual(c.actions.map(a => a.command), ['work_item.allow_fix_round', 'work_item.accept_split', 'work_item.park']);
  assert.ok(c.actions.every(a => a.enabled && a.refusal_code === null && TIERS.includes(a.tier)));
  assert.deepEqual(c.actions[0].input, { pull: 1192 });
  assert.equal(c.step_text, null);
});

test('real data: an issue 1185 prerequisite declaration inside a sentence is a fault, malformed_prerequisite_line, edit_prerequisites', async t => {
  const malformed = { dependsOn: [], malformed: 'the line is inside a sentence', line: 'This waits on Depends on: #1148 landing',
    cycle: null, met: false, reasons: [] };
  const dependencies = { evaluatedAt: NOW, issues: { 1185: malformed } };
  const issue = { number: 1185, title: 'Issue 1185', state: 'OPEN', labels: [], prerequisites: [] };
  const items = await attentionFrom(t, { cache: cacheOf([], [issue], { dependencies }), state: { jobs: {} } });
  const item = byId(items, 'dependency-malformed-1185');
  assert.ok(item, `the builder made the item (${items.map(i => i.id)})`);
  const c = classify(item, new Set(['work_item.edit_prerequisites']));
  assert.equal(c.kind, 'held_item');
  assert.equal(c.attention, 'fault');
  assert.equal(c.reason_code, 'malformed_prerequisite_line');
  assert.deepEqual(c.actions.map(a => [a.command, a.tier, a.enabled, a.input]), [['work_item.edit_prerequisites', 'direct', true, { issue: 1185 }]]);
});

test('a blocked job item is other/fault with job.resume (direct) and job.close (approval)', async t => {
  const job = { id: 'a'.repeat(32), provider: 'claude', kind: 'cifix', issue: 41, branch: 'claude/issue-41-x', status: 'blocked', createdAt: NOW - 600000,
    updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 1, lastEvent: 'blocked_needs_input' };
  const items = await attentionFrom(t, { cache: cacheOf([pull(41)]), state: { jobs: {} }, jobs: [job] });
  const c = classify(items.find(i => i.id.startsWith('job-')), new Set(['job.resume', 'job.close']));
  assert.deepEqual([c.kind, c.attention], ['other', 'fault']);
  assert.deepEqual(c.actions.map(a => [a.command, a.tier]), [['job.resume', 'direct'], ['job.close', 'approval']]);
  assert.deepEqual(c.actions[0].input, { job: job.id });
});

test('an issue labelled needs-homeowner is a homeowner_step with the step text from the item', async t => {
  const question = { question: 'Should the team continue?', yes: 'work resumes.', no: 'it stays held.' };
  const issue = { number: 3, title: 'Three', state: 'OPEN', labels: ['needs-homeowner'], prerequisites: [], question };
  const items = await attentionFrom(t, { cache: cacheOf([], [issue]), state: { jobs: {} } });
  const item = byId(items, 'homeowner-3');
  assert.ok(item, `the builder made the item (${items.map(i => i.id)})`);
  const c = classify(item, new Set());
  assert.deepEqual([c.kind, c.attention, c.step_text], ['homeowner_step', 'homeowner', item.text]);
});

test('every id the builder makes in these fixtures is classified (none is unclassified)', async t => {
  const items = await attentionFrom(t, { cache: fixLimitCache(), state: FIX_LIMIT_STATE });
  for (const item of items) assert.notEqual(classify(item, ALL).reason_code, 'unclassified', item.id);
});

test('real data: an unexplained hold from the planner state is an idle agent fault', async t => {
  const state = { jobs: {}, unexplainedHolds: { k: { type: 'implement', agent: 'claude', ref: 1185, kind: 'unexplained', since: NOW - 3600000 } } };
  const items = await attentionFrom(t, { cache: cacheOf([]), state });
  const item = items.find(i => i.id.startsWith('unexplained-hold-'));
  assert.ok(item, 'the view builder makes the item');
  const c = classify(item, ALL);
  assert.deepEqual([c.kind, c.attention, c.reason_code], ['idle_agent', 'fault', 'unexplained_hold']);
});

test('valid: a breaker halt is a fault with breaker.resume (person_only)', () => {
  const c = classify({ id: 'breaker-halt', text: 'halted', severity: 'action' }, ALL);
  assert.deepEqual([c.kind, c.attention, c.reason_code], ['breaker', 'fault', 'breaker_halt']);
  assert.deepEqual(c.actions.map(a => [a.command, a.tier, a.enabled]), [['breaker.resume', 'person_only', true]]);
});

test('the rows the issue lists are classified as listed', () => {
  const want = {
    'foreman-idle': ['idle_agent', 'fault'], 'stalled-hold-x': ['idle_agent', 'fault'],
    'decision-proposal-D-040-12': ['decision', 'homeowner'], 'decision-D-024': ['decision', 'homeowner'],
    'retrycap-implement-12': ['stuck_change', 'homeowner'], 'upgrade-latched': ['install', 'homeowner'],
    'upgrade-refused': ['install', 'fault'],
    'dashboard-restart-failed': ['install', 'fault'], 'migration-failed': ['install', 'fault'], 'config-invalid': ['install', 'fault'],
    'hand-deploy': ['homeowner_step', 'homeowner'], 'history-storage': ['homeowner_step', 'homeowner'], 'stale-mark-8': ['held_item', 'homeowner'],
  };
  for (const [id, [kind, attention]] of Object.entries(want)) {
    const c = classify({ id, text: 'text', action: 'do this' }, ALL);
    assert.deepEqual([c.kind, c.attention], [kind, attention], id);
  }
  const retry = classify({ id: 'retrycap-implement-12', text: 't' }, new Set(['work_item.clear_retry_cap']));
  assert.equal(retry.reason_code, 'retry_capped');
  assert.deepEqual(retry.actions.map(a => [a.command, a.tier]), [['work_item.clear_retry_cap', 'approval']]);
  const decision = classify({ id: 'decision-proposal-D-040-12', text: 't' }, ALL);
  assert.deepEqual(decision.actions.map(a => [a.command, a.tier]), [['decision.approve', 'person_only'], ['decision.reject', 'person_only']]);
  assert.deepEqual(classify({ id: 'upgrade-latched' }, ALL).actions.map(a => [a.command, a.tier]), [['upgrade.clear_latch', 'person_only']]);
  assert.deepEqual(classify({ id: 'stale-mark-8' }, ALL).actions.map(a => [a.command, a.tier]), [['work_item.requeue', 'approval']]);
  assert.equal(classify({ id: 'hand-deploy', text: 'Run: deploy it' }, ALL).step_text, 'Run: deploy it');
  assert.equal(classify({ id: 'history-storage', text: 'History storage: low', action: 'Free space.' }, ALL).step_text, 'Free space.');
});

test('an action whose command is not known is disabled with not_built; a known one is enabled', () => {
  const item = { id: 'fixlimit-5', text: 't' };
  const none = classify(item, new Set());
  assert.ok(none.actions.length === 3 && none.actions.every(a => a.enabled === false && a.refusal_code === 'not_built' && /not built/.test(a.refusal_text)));
  const some = classify(item, ['work_item.park']);
  assert.deepEqual(some.actions.map(a => a.enabled), [false, false, true]);
  assert.equal(some.actions[2].refusal_code, null);
  assert.equal(some.actions[2].refusal_text, null);
  assert.ok(classify(item).actions.every(a => !a.enabled), 'no known set means nothing is built');
});

test('invalid: an id never seen before is unclassified and a fault; an empty id and a missing item do not throw', () => {
  for (const item of [{ id: 'brand-new-thing-9', text: 'x' }, { id: '' }, {}, null, undefined, { id: 42 }]) {
    const c = classify(item, ALL);
    assert.deepEqual([c.kind, c.attention, c.reason_code, c.actions, c.step_text], ['other', 'fault', 'unclassified', [], null]);
  }
});

test('every table row gives allowed values, a lower case code, and passes the homeowner dead end check', () => {
  const classified = [];
  for (const r of TABLE) {
    assert.ok(r.pattern.test(r.example), `${r.example} matches its own row`);
    assert.ok(KINDS.includes(r.kind) && ATTENTIONS.includes(r.attention), r.example);
    assert.match(r.reasonCode, /^[a-z]+(_[a-z]+)*$/, r.example);
    const c = classify({ id: r.example, text: 'what happened', action: 'what to do' }, new Set());
    assert.equal(c.reason_code, r.reasonCode, `${r.example} is not shadowed by an earlier row`);
    classified.push(c);
  }
  assert.deepEqual(findDeadEnds(classified), []);
});

test('dead end check: only disabled actions plus a step text passes; no action and no step text is reported', () => {
  const ok = { attention: 'homeowner', actions: [{ command: 'x', enabled: false }], step_text: 'Do the thing.' };
  const stepOnly = { attention: 'homeowner', actions: [], step_text: 'Do the thing.' };
  const dead = { attention: 'homeowner', actions: [], step_text: null };
  const fault = { attention: 'fault', actions: [], step_text: null };
  assert.deepEqual(findDeadEnds([ok, stepOnly, dead, fault]), [dead]);
  assert.deepEqual(findDeadEnds(null), []);
});

test('the module imports nothing', () => {
  const source = fs.readFileSync(new URL('../supervisor/api/attention.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m);
  assert.doesNotMatch(source, /Date\.now|new Date|process\.|require\(|fetch\(/);
});

// Issue #1306: closed-noreason is homeowner attention with the work_item.close_reason control, in the contract table and in the decision table.
test('real data: the closed-noreason item for issue 895 is homeowner, closed_without_reason, with the close_reason control for every listed issue', async t => {
  const issues = [{ number: 895, title: 'Explain everything', state: 'CLOSED', stateReason: 'NOT_PLANNED', closedAt: '2026-11-09T20:14:00Z', labels: [] },
    { number: 896, title: 'Second', state: 'CLOSED', stateReason: 'DUPLICATE', closedAt: '2026-11-09T20:15:00Z', labels: [] }];
  const item = byId(await attentionFrom(t, { cache: cacheOf([], issues), started: Date.UTC(2026, 10, 9, 19, 0, 0) }), 'closed-noreason');
  assert.deepEqual(item.issues, [895, 896]);
  assert.equal(item.since, Date.parse('2026-11-09T20:14:00Z'));
  const known = new Set(['work_item.close_reason']);
  const c = classify(item, known);
  assert.deepEqual([c.kind, c.attention, c.reason_code], ['held_item', 'homeowner', 'closed_without_reason']);
  assert.deepEqual(c.actions.map(a => [a.command, a.input, a.enabled, a.tier]), [['work_item.close_reason', { issues: '895,896' }, true, 'direct']]);
  assert.deepEqual(findDeadEnds([c]), []);
  assert.equal(classify(item, new Set()).actions[0].enabled, false);
});

test('closed-noreason-unreadable is a fault, and the decision table has an entry for both ids so neither is an error card', () => {
  assert.deepEqual([classify({ id: 'closed-noreason-unreadable' }, []).attention, classify({ id: 'closed-noreason-unreadable' }, []).reason_code], ['fault', 'close_reason_record_unreadable']);
  for (const id of ['closed-noreason', 'closed-noreason-unreadable']) assert.equal(decisionCard({ id, text: 'x' }).type, id);
});

test('the card of closed-noreason has a text box and a Record reason button naming every issue; the unreadable one has none', () => {
  const html = decisionHtml({ id: 'closed-noreason', issues: [895, 896], card: decisionCard({ id: 'closed-noreason', text: 'x' }) });
  assert.match(html, /<form method="post" action="\/api\/v1\/commands\/work_item\.close_reason" class="close-reason-form" data-issues="895,896">/);
  assert.match(html, /<textarea name="reason"/);
  assert.match(html, />Record reason<\/button>/);
  assert.doesNotMatch(decisionHtml({ id: 'closed-noreason-unreadable', card: decisionCard({ id: 'closed-noreason-unreadable', text: 'x' }) }), /close-reason-form/);
});

test('the card of upgrade-blocked has a Retry install now form that sends upgrade.retry_install; other upgrade cards have none', () => {
  const html = decisionHtml({ id: 'upgrade-blocked', card: decisionCard({ id: 'upgrade-blocked', text: 'x' }) });
  assert.match(html, /<form method="post" action="\/api\/v1\/commands\/upgrade\.retry_install" class="retry-install-form">/);
  assert.match(html, />Retry install now<\/button>/);
  assert.doesNotMatch(decisionHtml({ id: 'upgrade-refused', card: decisionCard({ id: 'upgrade-refused', text: 'x' }) }), /retry-install-form/);
});
