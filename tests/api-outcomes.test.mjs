// Issue #1307: GET /api/v1/outcomes through the real dashboard handler over a temporary state root holding a timeline file.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import { hoursOf } from '../supervisor/api/models/outcomes.mjs';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const HOUR = 3600000;
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => [name, JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'))];
const schemas = Object.fromEntries(['common.schema.json', 'outcomes.schema.json'].map(readSchema));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const entry = (pr, verdict, at) => ({ id: `verdict:${pr}:${at}`, at, kind: 'verdict', source: 'live', pr, verdict, head: 'abcdef1' });
const TIMELINE = [entry(1, 'PASS', NOW - 2 * HOUR), entry(2, 'CHANGES', NOW - 30 * HOUR), entry(3, 'CHANGES', NOW - 100 * HOUR)];

async function serve(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1307-'));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team', path.join('dashboard', 'archive')]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'archive', 'timeline.jsonl'), TIMELINE.map(e => JSON.stringify(e)).join('\n') + '\n');
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
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

test('the default window is 24 hours, the reply validates against the closed schema, and counts and window are stated', async t => {
  const r = await (await serve(t))('/api/v1/outcomes');
  assert.equal(r.status, 200);
  assert.equal(r.headers['foreman-contract'], '1.0');
  assert.deepEqual(validate(schemas['outcomes.schema.json'], r.body, schemas), []);
  assert.equal(r.body.model, 'outcomes');
  assert.deepEqual(r.body.data.window, { hours: 24, start: '2026-11-12T12:00:00.000Z', end: '2026-11-13T12:00:00.000Z' });
  assert.deepEqual(r.body.data.items.map(i => [i.key, i.bin]), [['pr-1', 'moving']]);
  assert.equal(r.body.data.truncated, false);
});

test('hours 1 and 168 are accepted and change the window; hours 168 reaches the older entries', async t => {
  const get = await serve(t);
  assert.deepEqual((await get('/api/v1/outcomes?hours=1')).body.data.items, []);
  const week = await get('/api/v1/outcomes?hours=168');
  assert.equal(week.status, 200);
  assert.deepEqual(validate(schemas['outcomes.schema.json'], week.body, schemas), []);
  assert.deepEqual(week.body.data.items.map(i => i.key), ['pr-1', 'pr-2', 'pr-3']);
  assert.deepEqual(week.body.data.counts, { merged: 0, needs_you: 0, failed: 2, moving: 1 });
});

test('hours 0, 169, text and other malformed values are refused with the contract error shape', async t => {
  const get = await serve(t);
  for (const bad of ['0', '169', 'abc', '', '24.5', '-1', '1e2', '%20', '0024x']) {
    const r = await get(`/api/v1/outcomes?hours=${bad}`);
    assert.equal(r.status, 400, bad);
    assert.deepEqual(Object.keys(r.body), ['error']);
    assert.equal(r.body.error.code, 'invalid_hours');
    assert.equal(r.headers['foreman-contract'], '1.0');
  }
});

test('hoursOf: default when absent, whole numbers 1 to 168 only', () => {
  assert.deepEqual([{}, { hours: '1' }, { hours: '168' }, { hours: '0' }, { hours: '169' }, { hours: 'x' }].map(hoursOf), [24, 1, 168, null, null, null]);
});

test('the model is listed in the meta model and is a pure read: no timer in the module, no file written', async t => {
  const get = await serve(t);
  const meta = (await get('/api/v1/meta')).body.data.models;
  assert.ok(meta.some(m => m.name === 'outcomes' && m.path === '/api/v1/outcomes' && m.schema === 'outcomes.schema.json'));
  for (const file of ['models/outcomes.mjs', '../outcomes.mjs']) {
    const forbidden = /setInterval|setTimeout|writeFile|appendFile|Date\.now|new Date\(\)|fetch\(|execFile/;
    assert.doesNotMatch(fs.readFileSync(new URL(file, API), 'utf8'), forbidden, file);
  }
});
