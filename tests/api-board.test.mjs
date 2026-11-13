// Issue #1310: GET /api/v1/liveboard through the real dashboard handler over a temporary state root; the reply is checked against the schema.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const H = 3600000;
const MIN = 60000;
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => [name, JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'))];
const schemas = Object.fromEntries(['common.schema.json', 'appbar.schema.json', 'liveboard.schema.json'].map(readSchema));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { alpha: { implement: { model: 'sonnet' }, review: { model: 'opus' } }, beta: { implement: { effort: 'high' } } } },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] }, beta: { provider: 'prov-b', branch_prefix: 'beta/', issues: [] } },
};
const record = (id, o) => ({ id: id.repeat(32).slice(0, 32), provider: 'prov-a', kind: 'implement', issue: 7, branch: 'alpha/issue-7-x', status: 'completed', model: 'sonnet',
  createdAt: NOW - 3 * H, updatedAt: NOW - 2 * H, usage: { inputTokens: 600, outputTokens: 400, costUsdEstimate: 0.4 }, ...o });

async function serve(t, { jobs = [], state = { jobs: {} }, cache = {} } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1310-'));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const j of jobs) fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j));
  const tick = { at: NOW - MIN, status: 'ok', error: null, lastOkAt: NOW - MIN };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW - MIN, delivered: [], pulls: [], issues: [], tick, ...cache }));
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
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    }).on('error', reject);
  });
}

test('with no jobs the model answers 200, validates against the closed schema, and lists both agents and the configured lanes', async t => {
  const r = await (await serve(t))('/api/v1/liveboard');
  assert.equal(r.status, 200);
  assert.equal(r.headers['foreman-contract'], '1.0');
  assert.deepEqual(validate(schemas['liveboard.schema.json'], r.body, schemas), []);
  assert.equal(r.body.model, 'liveboard');
  assert.deepEqual(r.body.data.agents.map(a => a.id), ['alpha', 'beta']);
  assert.deepEqual(r.body.data.lanes.map(l => l.id), ['alpha/sonnet', 'alpha/opus', 'beta/default']);
  assert.deepEqual([r.body.data.running, r.body.data.landed, r.body.data.truncated], [[], [], false]);
});

test('jobs on disk come back as running and landed entries, with the box, cost in pence and a paused agent out until its reset', async t => {
  const jobs = [
    record('a', { status: 'running', createdAt: NOW - 10 * MIN, updatedAt: NOW - MIN }),
    record('b', { issue: 8, status: 'completed' }),
    record('c', { provider: 'prov-b', model: null, issue: 9, status: 'paused_limit', resetAt: NOW + 2 * H, updatedAt: NOW - H }),
  ];
  const get = await serve(t, { jobs, cache: { issues: [{ number: 8, title: 'Eight', state: 'OPEN', labels: [] }] } });
  const r = await get('/api/v1/liveboard');
  assert.deepEqual(validate(schemas['liveboard.schema.json'], r.body, schemas), []);
  const d = r.body.data;
  assert.deepEqual(d.running.map(x => [x.lane_id, x.job_type, x.number]), [['alpha/sonnet', 'implement', 7]]);
  const b = d.landed.find(x => x.number === 8);
  assert.deepEqual([b.box, b.lane_id, b.tokens, b.cost_pence, b.title], ['to_review', 'alpha/sonnet', 1000, 30, 'Eight']);
  assert.equal(d.landed.find(x => x.number === 9).box, 'out_of_allowance');
  assert.equal(d.agents.find(a => a.id === 'beta').out_until, new Date(NOW + 2 * H).toISOString());
  assert.equal(d.counts.to_review, 1);
});

test('a job record with an unknown status is counted in skipped_jobs and the reply still validates', async t => {
  const r = await (await serve(t, { jobs: [record('d', { status: 'mystery' }), record('e')] }))('/api/v1/liveboard');
  assert.deepEqual(validate(schemas['liveboard.schema.json'], r.body, schemas), []);
  assert.deepEqual([r.body.data.skipped_jobs, r.body.data.landed.length], [1, 1]);
});

test('the meta model lists liveboard and the schema is served', async t => {
  const get = await serve(t);
  assert.ok((await get('/api/v1/meta')).body.data.models.some(m => m.name === 'liveboard' && m.path === '/api/v1/liveboard'));
  const s = await get('/api/v1/schemas/liveboard.schema.json');
  assert.equal(s.status, 200);
  assert.equal(s.body.$id, 'liveboard.schema.json');
});

test('the closed schema refuses an unknown field and a bad box', () => {
  const ok = { contract: '1.0', model: 'liveboard', generated_at: '2026-11-13T12:00:00.000Z', freshness: { state: 'unknown', tick_at: null, age_seconds: null, stale_after_seconds: 600, reason_code: 'no_tick', reason_text: 'no tick' }, cursor: 'e-0',
    data: { agents: [], lanes: [], waiting: [], running: [], landed: [], counts: Object.fromEntries(['merged', 'needs_you', 'passed', 'changes_asked', 'out_of_allowance', 'failed', 'stopped', 'to_review', 'done'].map(k => [k, 0])), truncated: false, skipped_jobs: 0 } };
  assert.deepEqual(validate(schemas['liveboard.schema.json'], ok, schemas), []);
  assert.notDeepEqual(validate(schemas['liveboard.schema.json'], { ...ok, data: { ...ok.data, extra: 1 } }, schemas), []);
  const landed = { job_id: 'x', lane_id: 'a/b', job_type: 'fix', number: 1, title: null, laps: 0, ended_at: '2026-11-13T12:00:00.000Z', box: 'nonsense', tokens: null, cost_pence: null };
  assert.notDeepEqual(validate(schemas['liveboard.schema.json'], { ...ok, data: { ...ok.data, landed: [landed] } }, schemas), []);
});
