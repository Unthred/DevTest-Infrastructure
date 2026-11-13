// Issue #1253: GET /api/v1/appbar, driven through the real dashboard request handler on fixture state and checked against the schema.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import { systemCondition } from '../supervisor/api/system-state.mjs';

const NOW = Date.UTC(2026, 10, 12, 13, 2, 0);
const H = 3600000;
const MIN = 60000;
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const schemas = { 'common.schema.json': readSchema('common.schema.json'), 'appbar.schema.json': readSchema('appbar.schema.json') };
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] }, beta: { provider: 'prov-b', branch_prefix: 'beta/', issues: [] } },
};
const win = (type, utilization, resetsAt, windowMinutes) => ({ type, utilization, resetsAt, windowMinutes });
const probe = (provider, observedAt, windows) => ({ provider, status: 'ok', observedAt, source: 'session-log', windows });
const held = (kind, agent, ref) => ({ type: 'implement', agent, ref, outcome: 'held', kind, reason: kind });
const pull = number => ({
  number, title: `PR ${number}`, headRefName: `alpha/issue-${number}-x`, headRefOid: String(number % 10).repeat(40), baseRefName: 'main',
  isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }], labels: ['needs-homeowner'] });

// Serves the real handler on a fixture root; returns { get, root }.
async function serve(t, { cache = {}, state = { jobs: {} }, jobs = [], tick = NOW - MIN, now = NOW } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1253-'));
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
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => now }));
  const get = () => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/v1/appbar', headers: { host: `127.0.0.1:${port}` } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, text, body: JSON.parse(text) }));
    }).on('error', reject);
  });
  return get;
}
const answer = async (t, options) => {
  const r = await serve(t, options).then(get => get());
  assert.equal(r.status, 200);
  assert.deepEqual(validate(schemas['appbar.schema.json'], r.body, schemas), [], 'the reply validates against the closed schema');
  return r;
};
const byId = (data, id) => data.agents.find(a => a.id === id);
const jobAt = (id, startedAgo, status = 'completed', endedAgo = startedAgo - MIN) => ({
  id: id.repeat(32).slice(0, 32), provider: 'prov-a', kind: 'implement', issue: 5, branch: 'alpha/issue-5-x', status,
  createdAt: NOW - startedAgo, updatedAt: NOW - endedAgo,
});

test('valid: an agent with a fresh reading has two known windows (12 Nov data), and the live-check words are in the reply', async t => {
  const windows = [win('seven_day', 0.14, Date.UTC(2026, 10, 19, 4), 10080), win('five_hour', 0.01, NOW + 4 * H, 300)];
  const cache = { probes: { 'prov-a': probe('prov-a', NOW - 3 * MIN, windows) } };
  const r = await answer(t, { cache });
  const a = byId(r.body.data, 'alpha');
  assert.equal(a.weekly.state, 'known');
  assert.equal(a.weekly.used_fraction, 0.14);
  assert.equal(a.weekly.resets_at, '2026-11-19T04:00:00.000Z');
  assert.equal(a.short.state, 'known');
  assert.equal(a.short.used_fraction, 0.01);
  assert.deepEqual([a.weekly.reason_code, a.short.reason_code], [null, null]);
  assert.equal(a.reading.stale, false);
  assert.equal(a.reading.age_seconds, 180);
  assert.match(r.text, /used_fraction/);
  assert.match(r.text, /max_age_seconds/);
});

test('invalid: an agent with no reading has two unknown windows with no_reading, never a zero', async t => {
  const { data } = (await answer(t)).body;
  const b = byId(data, 'beta');
  for (const w of [b.weekly, b.short]) {
    assert.equal(w.state, 'unknown');
    assert.equal(w.used_fraction, null);
    assert.equal(w.reason_code, 'no_reading');
  }
  assert.equal(b.reading.read_at, null);
  assert.equal(b.reading.stale, true);
});

test('boundary: a reading exactly at its maximum age is not stale and one second past it is', async t => {
  const windows = [win('seven_day', 0.2, NOW + 24 * H, 10080), win('five_hour', 0.2, NOW + 4 * H, 300)];
  const ages = { exact: 3600, past: 3601 };
  for (const [label, seconds] of Object.entries(ages)) {
    const cache = { probes: { 'prov-a': probe('prov-a', NOW - seconds * 1000, windows) } };
    const a = byId((await answer(t, { cache })).body.data, 'alpha');
    assert.equal(a.reading.max_age_seconds, 3600);
    assert.equal(a.reading.age_seconds, seconds);
    assert.equal(a.reading.stale, label === 'past', label);
  }
});

test('real data (12 Nov): expired 5 hour window, 32,520 second old reading, four held actions, six Needs you items', async t => {
  const probes = {
    'prov-a': probe('prov-a', NOW - 3 * MIN, [win('seven_day', 0.14, Date.UTC(2026, 10, 19, 4), 10080), win('five_hour', 0.01, NOW + 4 * H, 300)]),
    'prov-b': probe('prov-b', NOW - 32520 * 1000, [win('seven_day', 0.31, NOW + 3 * 24 * H, 10080), win('five_hour', 0.5, NOW - 4 * H, 300)]),
  };
  const unexplained = ['a', 'b'].map(k => ({ type: 'implement', agent: 'alpha', ref: k === 'a' ? 7 : 8, kind: 'unexplained', since: NOW - 6 * H }));
  const state = { jobs: {}, unexplainedHolds: Object.fromEntries(unexplained.map(u => [`implement:alpha:${u.ref}`, u])) };
  const planned = [held('unexplained', 'alpha', 7), held('unexplained', 'alpha', 8), held('slot', 'beta', 9), held('allowance', 'beta', 10)];
  const pulls = [11, 12, 13, 14].map(pull);
  const cache = { probes, planned, pulls };
  const r = await answer(t, { cache, state });
  const { data } = r.body;
  const b = byId(data, 'beta');
  assert.equal(b.weekly.state, 'known');
  assert.equal(b.weekly.used_fraction, 0.31);
  assert.equal(b.short.state, 'unknown');
  assert.equal(b.short.reason_code, 'window_expired_no_reading');
  assert.equal(b.short.used_fraction, null);
  assert.equal(b.reading.age_seconds, 32520);
  assert.equal(b.reading.stale, true);
  assert.deepEqual(data.slots, { max: 4, in_use: 0 });
  assert.equal(data.counts.planned_held, 4);
  assert.equal(data.system.state, 'stalled');
  assert.equal(data.system.attention, 'fault');
  assert.equal(data.system.reason_code, 'unrecorded');
  assert.equal(data.counts.needs_you + data.counts.faults, 6, 'six Needs you items, each classed homeowner or fault');
  assert.equal(data.counts.stalled_agents, 2, 'both idle agents hold a planned action');
  assert.ok(r.text.length < 8000, `the reply is ${r.text.length} bytes`);
  assert.equal(data.tick.state, 'scheduled');
});

test('boundary: a job that started 14 minutes ago with held actions is not stalled; at 15 minutes it is', async t => {
  const planned = [held('slot', 'alpha', 7)];
  const at14 = await answer(t, { cache: { planned }, jobs: [jobAt('c', 14 * MIN, 'completed', 13 * MIN)] });
  assert.equal(at14.body.data.system.state, 'idle');
  const at15 = await answer(t, { cache: { planned }, jobs: [jobAt('d', 15 * MIN, 'completed', 14 * MIN)] });
  assert.equal(at15.body.data.system.state, 'stalled');
  assert.equal(at15.body.data.system.reason_code, 'slot');
  assert.equal(at15.body.data.system.since, new Date(NOW - 14 * MIN).toISOString());
});

test('invalid: a missing tick gives system unknown, never ok', async t => {
  const r = await answer(t, { tick: null, cache: { planned: [held('slot', 'alpha', 7)] } });
  assert.equal(r.body.data.system.state, 'unknown');
  assert.equal(r.body.data.system.attention, 'unknown');
  assert.equal(r.body.data.tick.state, 'unknown');
});

test('the stall rule on its own: a running job, a halted breaker and the order of the rule', () => {
  const base = { tickKnown: true, now: NOW, held: [{ kind: 'slot' }], jobs: [] };
  assert.equal(systemCondition({ ...base, jobs: [{ status: 'running', startedAt: NOW - 3 * H, endedAt: null }] }).state, 'running');
  assert.equal(systemCondition({ ...base, breaker: { halted: true, text: 'x' } }).state, 'halted');
  assert.equal(systemCondition({ ...base, tickKnown: false, breaker: null }).state, 'unknown');
  assert.equal(systemCondition({ ...base, held: [], paused: true }).state, 'paused');
  assert.equal(systemCondition({ ...base, held: [] }).state, 'idle');
  assert.equal(systemCondition(base).reason_code, 'slot', 'no job at all and a held action is a stall');
});

test('no agent or provider name appears in the code of this item', () => {
  const files = ['models/appbar.mjs', 'system-state.mjs', 'schemas/appbar.schema.json'];
  for (const f of files) assert.doesNotMatch(fs.readFileSync(new URL(f, API), 'utf8'), /claude|codex|anthropic|openai/i, f);
});
