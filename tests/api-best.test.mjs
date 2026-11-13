// Issue #1325: GET /api/v1/best through the real dashboard handler over a temporary state root holding a timeline file.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import { bestDayStep } from '../supervisor/best-day-step.mjs';
import { readBest } from '../supervisor/best-day-store.mjs';
import { appendTimeline } from '../supervisor/history.mjs';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const HOUR = 3600000;
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => [name, JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'))];
const schemas = Object.fromEntries(['common.schema.json', 'best.schema.json'].map(readSchema));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};

async function serve(t, prepare = () => {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1325-'));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team', path.join('dashboard', 'archive')]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  prepare(root);
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => NOW }));
  const get = route => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { host: `127.0.0.1:${port}` } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    }).on('error', reject);
  });
  get.root = root;
  return get;
}


const comment = (pr, verdict, at) => ({ created_at: new Date(at).toISOString(), body: `<!-- devtest-verdict v1 job=${'a'.repeat(32)} pr=${pr} head=${'b'.repeat(40)} verdict=${verdict} reviewer=x -->` });
const history = (n, approved, at) => Array.from({ length: n }, (_, i) => comment(i + 1, i < approved ? 'PASS' : 'CHANGES', at + i * 60000));
const fetchOf = list => page => list.slice((page - 1) * 100, page * 100);

test('with no record stored the reply validates against the schema, says it is not built and holds no records or distance', async t => {
  const r = await (await serve(t))('/api/v1/best');
  assert.equal(r.status, 200);
  assert.equal(r.headers['foreman-contract'], '1.0');
  assert.deepEqual(validate(schemas['best.schema.json'], r.body, schemas), []);
  assert.equal(r.body.model, 'best');
  assert.equal(r.body.data.built, false);
  assert.deepEqual(r.body.data.records, { approval: null, merges: null });
  assert.deepEqual(r.body.data.distance, { approval: null, merges: null });
  assert.equal(r.body.data.current.reviewed, 0);
  assert.equal(r.body.data.updated_at, null);
});

test('after the tick step built the records the reply carries both records, the current 24 hours and the distances', async t => {
  const start = NOW - 30 * HOUR;
  const get = await serve(t, root => appendTimeline(root, [{ id: 'merge:1', at: NOW - 2 * HOUR, kind: 'merge', pr: 1 }, { id: 'merge:2', at: NOW - 3 * HOUR, kind: 'merge', pr: 2 }]));
  assert.equal(bestDayStep(get.root, { repository: 'o/r', now: NOW, fetchPage: fetchOf(history(25, 20, start)) }), 'built');
  const r = await get('/api/v1/best');
  assert.deepEqual(validate(schemas['best.schema.json'], r.body, schemas), []);
  const data = r.body.data;
  assert.equal(data.built, true);
  assert.equal(data.records.approval.reviewed, 25);
  assert.equal(data.records.approval.rate, 80);
  assert.equal(data.records.merges.merged, 2);
  assert.equal(data.current.merged, 2);
  assert.equal(data.current.reviewed, 0);
  assert.equal(data.current.qualifies, false);
  assert.deepEqual(data.distance, { approval: null, merges: 0 });
});

test('a record stays in the reply when the verdicts it came from are gone from the timeline and the ledger', async t => {
  const get = await serve(t);
  const long = NOW - 100 * 24 * HOUR;
  assert.equal(bestDayStep(get.root, { repository: 'o/r', now: long, fetchPage: fetchOf(history(20, 20, long - HOUR)) }), 'built');
  appendTimeline(get.root, [{ id: 'merge:77', at: NOW - HOUR, kind: 'merge', pr: 77 }]);
  assert.equal(bestDayStep(get.root, { repository: 'o/r', now: NOW, fetchPage: () => [] }), 'updated');
  assert.equal(readBest(get.root).verdicts.length, 0);
  const r = await get('/api/v1/best');
  assert.deepEqual(validate(schemas['best.schema.json'], r.body, schemas), []);
  assert.equal(r.body.data.records.approval.rate, 100);
  assert.equal(r.body.data.records.approval.reviewed, 20);
});

test('the model is listed in the meta model and a request writes nothing', async t => {
  const get = await serve(t);
  const meta = (await get('/api/v1/meta')).body.data.models;
  assert.ok(meta.some(m => m.name === 'best' && m.path === '/api/v1/best' && m.schema === 'best.schema.json'));
  await get('/api/v1/best');
  assert.equal(fs.existsSync(path.join(get.root, 'dashboard', 'best-day.json')), false);
});
