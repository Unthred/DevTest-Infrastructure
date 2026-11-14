// Issue #1256: GET /api/v1/overview, driven through the real dashboard request handler on fixture state and checked against the schema.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import { attentionItem } from '../supervisor/api/models/overview.mjs';

const NOW = Date.UTC(2026, 10, 12, 13, 2, 0);
const MIN = 60000;
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const schemas = {};
for (const f of ['common', 'appbar', 'overview']) schemas[`${f}.schema.json`] = readSchema(`${f}.schema.json`);
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] }, beta: { provider: 'prov-b', branch_prefix: 'beta/', issues: [] } },
};
const held = (type, agent, ref, kind, reason = kind) => ({ type, agent, ref, outcome: 'held', kind, reason });
const pull = (number, labels = []) => ({
  number, title: `PR ${number}`, headRefName: `alpha/issue-${number}-x`, headRefOid: String(number % 10).repeat(40), baseRefName: 'main',
  isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], labels });

// Serves the real handler on a fixture root; returns a function that GETs one path.
async function serve(t, { cache = {}, state = { jobs: {} }, jobs = [], tick = NOW - MIN } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1256-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const j of jobs) fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j));
  const body = { fetchedAt: NOW - MIN, delivered: [], pulls: [], issues: [], ...cache };
  if (tick !== null) body.tick = { at: tick, status: 'ok', error: null, lastOkAt: tick };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(body));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify(state));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => NOW }));
  return route => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { host: `127.0.0.1:${port}` } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, text, body: JSON.parse(text) }));
    }).on('error', reject);
  });
}
const answer = async (t, options) => {
  const get = await serve(t, options);
  const r = await get('/api/v1/overview');
  assert.equal(r.status, 200);
  assert.deepEqual(validate(schemas['overview.schema.json'], r.body, schemas), [], 'the reply validates against the closed schema');
  r.appbar = (await get('/api/v1/appbar')).body.data;
  return r;
};
const wasteState = records => ({ jobs: {}, breaker: { waste: Object.fromEntries(records.map(w => [w.job, w])) } });
const wasted = (n, cause, tokens, pr, at = NOW - 60 * MIN) => ({ job: `job${n}`, at, cause, tokens, pr, type: 'rebase' });
const runningJob = {
  id: 'a'.repeat(32), provider: 'prov-a', kind: 'implement', issue: 5, branch: 'alpha/issue-5-x', status: 'running',
  createdAt: NOW - 20 * MIN, updatedAt: NOW - MIN,
};

test('valid: one running job and no held action gives an empty stalls list and the verdict running; the live-check words are in the reply', async t => {
  const r = await answer(t, { jobs: [runningJob] });
  assert.deepEqual(r.body.data.stalls, []);
  assert.equal(r.body.data.verdict.state, 'running');
  assert.match(r.text, /"needs_you"/);
  assert.match(r.text, /"stalls"/);
});

test('the verdict is the app bar system value of the same instant', async t => {
  const r = await answer(t, { cache: { planned: [held('implement', 'alpha', 7, 'slot')] } });
  assert.deepEqual(r.body.data.verdict, r.appbar.system);
  assert.equal(r.body.data.verdict.state, 'stalled');
});

const OVERLAP_TEXT = 'rebase of PR #1139 (issue #1139) waits: it is expected to edit a.mjs, '
  + 'which the running or planned job for issue #1142 (PR #1142) also edits';

test('the 12 Nov data: four free slots, two stalls, the unexplained one reads unrecorded, overlap names the other item', async t => {
  const planned = [
    held('fix', 'alpha', 1180, 'unexplained', 'planned but neither started nor held, and no reason was recorded'),
    held('fix', 'alpha', 1175, 'unexplained'),
    held('rebase', 'beta', 1139, 'overlap', OVERLAP_TEXT),
    held('fix', 'beta', 1142, 'overlap'),
  ];
  const r = await answer(t, { cache: { planned, pulls: [pull(1180), pull(1142)] } });
  const d = r.body.data;
  assert.deepEqual([d.slots.max, d.slots.in_use], [4, 0]);
  assert.equal(d.stalls.length, 2);
  assert.equal(d.stalls[0].agent, 'alpha');
  assert.equal(d.stalls[0].condition.reason_code, 'unrecorded');
  assert.equal(d.stalls[0].planned, 2);
  assert.deepEqual(d.stalls[0].actions.map(a => a.target.key), ['change-1180', 'change-1175']);
  assert.equal(d.stalls[0].actions[0].condition.attention, 'fault');
  assert.equal(d.stalls[0].actions[0].target.title, 'PR 1180');
  assert.equal(d.stalls[1].condition.reason_code, 'overlap');
  assert.equal(d.stalls[1].actions[0].held_by.key, 'issue-1142');
  assert.equal(d.stalls[1].actions[0].condition.attention, 'none');
  assert.equal(d.stalls[1].actions[1].held_by, null, 'an overlap reason that names nobody gives a null held_by');
  assert.equal(d.planned.length, 4);
  assert.ok(Number.isInteger(d.stalls[0].idle_seconds) || d.stalls[0].idle_seconds === null);
});

test('boundary: a stall together with six Needs you items still gives the verdict stalled, and the two lists stay apart', async t => {
  const pulls = [1, 2, 3, 4, 5, 6].map(n => pull(n, ['needs-homeowner']));
  const r = await answer(t, { cache: { pulls, planned: [held('implement', 'alpha', 9, 'slot')] } });
  const d = r.body.data;
  assert.equal(d.verdict.state, 'stalled');
  assert.ok(d.needs_you.length >= 6);
  const ids = new Set(d.needs_you.map(i => i.id));
  assert.ok(d.needs_you.every(i => i.condition.attention === 'homeowner' && (i.actions.length || i.step_text || i.list)));
  assert.ok(d.faults.every(i => ['fault', 'unknown'].includes(i.condition.attention) && !ids.has(i.id)));
  assert.equal(d.needs_you[0].target.kind, 'change');
});

test('boundary: waste with a single cause gives the fraction 1', async t => {
  const state = wasteState([wasted(1, 'review:x', 500, 7), wasted(2, 'review:x', 500, 7)]);
  const r = await answer(t, { state });
  const text = '2 wasted jobs of this cause in the last 7 days.';
  assert.deepEqual(r.body.data.waste.top_cause, { code: 'review:x', text, fraction: 1, tokens: 1000, changes: 1 });
});

test('the 12 Nov waste: 59 jobs and 86,000,000 tokens, 67,080,000 from one cause across 28 pull requests, give 0.78 and 28 changes', async t => {
  const top = Array.from({ length: 40 }, (_, i) => wasted(i, 'rebase:failed:retry', 1677000, 1000 + (i % 28)));
  const rest = Array.from({ length: 19 }, (_, i) => wasted(100 + i, 'fix:blocked:other', i === 18 ? 920000 : 1000000, 2000 + i));
  const old = wasted(900, 'review:old', 5000000, 3000, NOW - 8 * 24 * 60 * MIN);
  const r = await answer(t, { state: wasteState([...top, ...rest, old]) });
  const w = r.body.data.waste;
  assert.deepEqual([w.jobs, w.tokens, w.window_seconds], [59, 86000000, 604800], 'a record older than 7 days is not counted');
  assert.deepEqual([w.top_cause.code, w.top_cause.tokens, w.top_cause.fraction, w.top_cause.changes], ['rebase:failed:retry', 67080000, 0.78, 28]);
});

test('invalid: a missing tick gives the verdict unknown and never ok', async t => {
  const r = await answer(t, { tick: null, cache: { planned: [held('implement', 'alpha', 7, 'slot')] } });
  assert.equal(r.body.data.verdict.state, 'unknown');
  assert.equal(r.body.data.verdict.attention, 'unknown');
});

test('invalid: no waste records gives a null top_cause and zero totals; the host reading is unknown without one', async t => {
  const r = await answer(t, {});
  assert.deepEqual(r.body.data.waste, { window_seconds: 604800, jobs: 0, tokens: 0, top_cause: null });
  assert.equal(r.body.data.host.state, 'unknown');
  assert.equal(r.body.data.headline.first_pass.fraction, null);
  assert.equal(r.body.data.headline.window_seconds, 86400);
});

test('headline: first pass, merges and jobs run of the last 24 hours come from the view headline numbers', async t => {
  const at = NOW - 3600000;
  const verdicts = {
    [`11:${'1'.repeat(40)}`]: { verdict: 'PASS', at, reviewer: 'beta' },
    [`12:${'2'.repeat(40)}`]: { verdict: 'CHANGES', at, reviewer: 'beta' },
  };
  const state = { jobs: {}, verdicts, mergeLog: [{ pr: 11, issue: 11, agent: 'alpha', mergedAt: at }] };
  const job = { ...runningJob, status: 'completed', createdAt: NOW - 2 * 3600000, updatedAt: NOW - 3600000 };
  const r = await answer(t, { state, jobs: [job], cache: { pulls: [pull(12)] } });
  assert.deepEqual(r.body.data.headline, { window_seconds: 86400, first_pass: { approved: 1, reviewed: 2, fraction: 0.5 }, merges: 1, jobs_run: 1 });
});

test('an item that waits for the homeowner but offers nothing is a fault with the code dead_end; a list stands for several', () => {
  const view = { panels: { inbox: [{}, {}, {}] } };
  const classed = { attention: 'homeowner', actions: [], reason_code: 'x' };
  const dead = attentionItem(view, { id: 'homeowner-pr-5', text: '', ref: null }, { ...classed, kind: 'homeowner_step', step_text: null });
  assert.equal(dead.condition.reason_code, 'dead_end');
  assert.equal(dead.condition.attention, 'fault');
  const item = { id: 'inbox-waiting', text: '3 overseer proposals waiting', ref: null };
  const inbox = attentionItem(view, item, { ...classed, kind: 'inbox_item', step_text: '3 waiting' });
  assert.deepEqual([inbox.count, inbox.list], [3, { model: 'inbox', filter: { state: 'waiting_for_approval' } }]);
});

test('no agent or provider name appears in the code of this item', () => {
  for (const f of ['models/overview.mjs', 'schemas/overview.schema.json']) {
    assert.doesNotMatch(fs.readFileSync(new URL(f, API), 'utf8'), /claude|codex|anthropic|openai/i, f);
  }
});

// Issue #1377: homeowner steps of merged pull requests, served by the real router, are Needs you items with their step text and none is a fault.
test('real data: homeowner steps (PR 1124 step 1 among them) are served under needs_you with step text and the PR as target, none as faults', async t => {
  const text = 'On a host that is latched now, run clear-latch once';
  const steps = n => Array.from({ length: n }, (_, i) => ({ text: i === 0 ? text : `Step ${i + 1}`, done: false }));
  const pendingSteps = {
    1124: { title: 'Clear latch (#1124)', mergedAt: NOW - 5 * MIN, steps: steps(2) },
    12345: { title: 'Big number', mergedAt: NOW - 4 * MIN, steps: steps(2) },
    1130: { title: 'Many steps', mergedAt: NOW - 3 * MIN, steps: steps(10) },
  };
  const r = await answer(t, { state: { jobs: {}, pendingSteps }, cache: { pulls: [] } });
  const d = r.body.data;
  const mine = d.needs_you.filter(i => i.id.startsWith('homeowner-step-'));
  assert.equal(mine.length, 14);
  assert.ok(mine.length >= 6);
  assert.ok(mine.every(i => i.kind === 'homeowner_step' && i.condition.attention === 'homeowner' && i.step_text));
  assert.ok(d.needs_you.every(i => i.kind !== 'other'), 'no item is left as kind other');
  assert.deepEqual(d.faults.filter(i => i.id.startsWith('homeowner-step-')), []);
  const first = mine.find(i => i.id === 'homeowner-step-1124-1');
  assert.match(first.step_text, /On a host that is latched now, run clear-latch once/);
  assert.equal(first.target.key, 'change-1124');
  assert.equal(first.condition.reason_code, 'homeowner_step_waiting');
  assert.deepEqual(first.actions.map(a => [a.command, a.enabled, a.refusal_code]), [['homeowner_step.mark_done', false, 'not_built']]);
  assert.ok(mine.some(i => i.id === 'homeowner-step-1130-10'));
  assert.ok(mine.some(i => i.id === 'homeowner-step-12345-2'));
});
