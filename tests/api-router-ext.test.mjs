// Issue #1251: the extension points of the contract router (query, keyed paths, route modules, guard), driven through the real dashboard
// request handler with DEVTEST_API_DIR naming a temporary folder that holds a sample read model and sample route modules.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { handler } from '../supervisor/dashserver.mjs';

const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
const ROUTER = new URL('../supervisor/api/router.mjs', import.meta.url).href;

const SAMPLE_MODEL = `import { notFound } from '${ROUTER}';
export const name = 'item'; export const path = 'work-items/{key}'; export const schema = 'item.schema.json'; export const usesView = false;
export async function build(view, context) {
  if (context.params.key === 'missing-1') return notFound('No such work item.');
  return { params: context.params, query: context.query, hasRoot: typeof context.root === 'string', hasConfig: context.config?.repository === 'o/r' };
}`;
const SAMPLE_ROUTES = {
  'hello.mjs': `export const name = 'hello'; export const method = 'GET'; export const path = 'hello/{who}';
export const events = [{ name: 'hello_said' }]; export const commands = [{ name: 'say_hello' }];
export const cursor = () => 'e-42';
export function handle(req, res, context) {
  context.reply(req, res, 200, 'text/plain; charset=utf-8', 'hello ' + context.params.who, { 'x-sample': context.guard.originAllowed(req) ? 'allowed' : 'refused' });
}`,
  'shout.mjs': `export const name = 'shout'; export const method = 'POST'; export const path = 'shout';
export function handle(req, res, context) {
  context.guard.invalidateView();
  context.fail(req, res, 202, 'shouted', JSON.stringify(Object.keys(context.guard)));
}`,
  'guardcheck.mjs': `export const name = 'guardcheck'; export const method = 'POST'; export const path = 'guardcheck';
import fs from 'node:fs';
import nodePath from 'node:path';
export function handle(req, res, context) {
  const g = context.guard;
  const bad = g.proofValid('nope');   // creates the token file on first use
  const given = fs.readFileSync(nodePath.join(context.root, 'dashboard', 'write-token'), 'utf8').trim();
  const first = g.reserveCooldown('k', 600000);
  const blocked = g.reserveCooldown('k', 600000);
  g.releaseCooldown('k');
  const again = g.reserveCooldown('k', 600000);
  context.fail(req, res, 202, 'checked', JSON.stringify({ first: first.ok, blocked: blocked.ok, again: again.ok, good: g.proofValid(given), bad }));
}`,
  'broken.mjs': `export const name = 'broken'; export const method = 'GET'; export const path = 'broken';`,
};

async function serve(t, { sample = true, now = () => 10 * 60000 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api1251-'));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  removeLater(root);
  const saved = process.env.DEVTEST_API_DIR;
  if (sample) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api1251-dir-'));
    removeLater(dir);
    for (const d of ['models', 'routes', 'schemas']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'models', 'item.mjs'), SAMPLE_MODEL);
    fs.copyFileSync(new URL('../supervisor/api/models/meta.mjs', import.meta.url), path.join(dir, 'models', 'meta.mjs'));
    for (const [file, text] of Object.entries(SAMPLE_ROUTES)) fs.writeFileSync(path.join(dir, 'routes', file), text);
    process.env.DEVTEST_API_DIR = dir;
  }
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  try { server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now })); } finally { if (saved === undefined) delete process.env.DEVTEST_API_DIR; else process.env.DEVTEST_API_DIR = saved; }
  const request = (p, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
  return Object.assign(request, { port });
}

test('a keyed model gets params.key, the query, root and config in its context', async t => {
  const get = await serve(t);
  const r = await get('/api/v1/work-items/change-1192?state=waiting_for_approval');
  assert.equal(r.status, 200);
  const data = JSON.parse(r.body).data;
  assert.deepEqual(data.params, { key: 'change-1192' });
  assert.deepEqual(data.query, { state: 'waiting_for_approval' });
  assert.equal(data.hasRoot, true);
  assert.equal(data.hasConfig, true);
});

test('boundary: a 64-character key matches, a 65-character key does not', async t => {
  const get = await serve(t);
  assert.equal((await get(`/api/v1/work-items/${'a'.repeat(64)}`)).status, 200);
  assert.equal((await get(`/api/v1/work-items/${'a'.repeat(65)}`)).status, 404);
});

test('boundary: only the first 20 query names are kept and a value is cut at 200 characters', async t => {
  const get = await serve(t);
  const names = Array.from({ length: 21 }, (_, i) => `n${i + 1}=${i === 0 ? 'x'.repeat(250) : 'v'}`).join('&');
  const query = JSON.parse((await get(`/api/v1/work-items/change-1192?${names}`)).body).data.query;
  assert.equal(Object.keys(query).length, 20);
  assert.equal(query.n21, undefined);
  assert.equal(query.n1.length, 200);
});

test('invalid: a key with a percent sign answers 404 as JSON', async t => {
  const get = await serve(t);
  const r = await get('/api/v1/work-items/change%2F1192');
  assert.equal(r.status, 404);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.equal(JSON.parse(r.body).error.code, 'not_found');
});

test('a build function that returns notFound answers 404 with the code not_found, and an async build works', async t => {
  const get = await serve(t);
  const r = await get('/api/v1/work-items/missing-1');
  assert.equal(r.status, 404);
  assert.deepEqual(JSON.parse(r.body), { error: { code: 'not_found', text: 'No such work item.' } });
});

test('a GET route module writes its own reply, with the guard and helpers in its context', async t => {
  const get = await serve(t);
  const r = await get('/api/v1/hello/change-1192');
  assert.equal(r.status, 200);
  assert.equal(r.body, 'hello change-1192');
  assert.equal(r.headers['x-sample'], 'refused');   // no Origin header: the dashboard's own check refuses it
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  const allowed = await get('/api/v1/hello/x', 'GET', { origin: `http://127.0.0.1:${get.port}` });
  assert.equal(allowed.headers['x-sample'], 'allowed');   // the dashboard's own origin rule: the listen address is allowed
});

test('a POST route module is called for POST and the guard holds the six checks', async t => {
  const get = await serve(t);
  const r = await get('/api/v1/shout', 'POST');
  assert.equal(r.status, 202);
  assert.deepEqual(JSON.parse(JSON.parse(r.body).error.text), ['originAllowed', 'proofValid', 'reserveCooldown', 'releaseCooldown', 'invalidateView', 'wake']);
});

test('guard: a released cooldown can be reserved again with an advancing clock; proofValid accepts the token and rejects a wrong one', async t => {
  let clock = 10 * 60000;
  const get = await serve(t, { now: () => (clock += 1000) });
  const r = await get('/api/v1/guardcheck', 'POST', { origin: `http://127.0.0.1:${get.port}` });
  assert.equal(r.status, 202);
  assert.deepEqual(JSON.parse(JSON.parse(r.body).error.text), { first: true, blocked: false, again: true, good: true, bad: false });
});

test('boundary: HEAD on a GET route has the same status and headers and no body', async t => {
  const get = await serve(t);
  const full = await get('/api/v1/hello/change-1192');
  const head = await get('/api/v1/hello/change-1192', 'HEAD');
  assert.equal(head.status, full.status);
  assert.equal(head.body, '');
  assert.equal(head.headers['content-type'], full.headers['content-type']);
});

test('invalid: POST to a read model or to a GET route answers 405 as JSON; a module with no handle is skipped', async t => {
  const get = await serve(t);
  for (const p of ['/api/v1/work-items/change-1192', '/api/v1/hello/x', '/api/v1/nowhere']) {
    const r = await get(p, 'POST');
    assert.equal(r.status, 405);
    assert.equal(JSON.parse(r.body).error.code, 'method_not_allowed');
  }
  assert.equal((await get('/api/v1/broken')).status, 404);   // skipped, the others still loaded
  assert.equal((await get('/api/v1/hello/x')).status, 200);
});

test('meta lists events and commands from route modules and the envelope cursor comes from the first cursor export', async t => {
  const get = await serve(t);
  const meta = JSON.parse((await get('/api/v1/meta')).body);
  assert.deepEqual(meta.data.events, [{ name: 'hello_said' }]);
  assert.deepEqual(meta.data.commands, [{ name: 'say_hello' }]);
  assert.equal(meta.cursor, 'e-42');
});

test('regression: GET /api/v1/meta and GET /api/view.json answer as before, and meta lists only what the route exports', async t => {
  const get = await serve(t, { sample: false });
  const meta = await get('/api/v1/meta');
  assert.equal(meta.status, 200);
  const body = JSON.parse(meta.body);
  assert.deepEqual([body.data.commands.map(c => c.name), body.data.events, body.cursor], [['inbox.approve', 'inbox.reject', 'inbox.undo_decision', 'job.resume', 'upgrade.clear_latch', 'work_item.accept_split', 'work_item.clear_retry_cap', 'work_item.close_reason', 'work_item.requeue'], ['hello', 'heartbeat', 'model_changed', 'command_applied', 'freshness_changed', 'resync_required'].map(name => ({ name })), 'e-0']);   // issue #1254: only the events route exports events
  assert.equal((await get('/api/v1/meta', 'POST')).status, 405);
  assert.equal((await get('/api/view.json')).status, 200);
});
