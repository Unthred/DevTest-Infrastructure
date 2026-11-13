// Issue #1248: the versioned read contract under /api/v1/, driven through the real dashboard request handler on fixture state.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { handler } from '../supervisor/dashserver.mjs';
import { freshnessOf } from '../supervisor/api/envelope.mjs';
import { validate } from '../supervisor/api/validate.mjs';

const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const schemaSet = () => ({ 'common.schema.json': readSchema('common.schema.json'), 'meta.schema.json': readSchema('meta.schema.json') });

async function serve(t, { apiDir, ...extra } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'api1248-'));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  removeLater(root);
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const port = server.address().port;
  const saved = process.env.DEVTEST_API_DIR;
  if (apiDir) process.env.DEVTEST_API_DIR = apiDir;
  try { server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => 10 * 60000, ...extra })); } finally { if (saved === undefined) delete process.env.DEVTEST_API_DIR; else process.env.DEVTEST_API_DIR = saved; }
  const request = (p, method = 'GET', headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let body = '';
      res.on('data', d => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
  return Object.assign(request, { root });
}

test('GET /api/v1/meta answers 200 with the header, security headers, and a reply that validates', async t => {
  const get = await serve(t);
  const r = await get('/api/v1/meta');
  assert.equal(r.status, 200);
  assert.equal(r.headers['foreman-contract'], '1.0');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(r.headers['content-type'], /^application\/json/);
  const body = JSON.parse(r.body);
  assert.deepEqual(validate(schemaSet()['meta.schema.json'], body, schemaSet()), []);
  assert.deepEqual(Object.keys(body), ['contract', 'model', 'generated_at', 'freshness', 'cursor', 'data']);
  assert.equal(body.cursor, 'e-0');
  assert.equal(body.freshness.state, 'unknown');   // the fixture has no finished tick
  assert.equal(body.freshness.tick_at, null);
  const group = name => body.data.states.find(s => s.state === name)?.group;
  assert.equal(group('waiting_for_approval'), 'waiting');   // the contract name for the Inbox state the store calls pending
  assert.equal(group('stalled'), 'failed');
  assert.deepEqual(body.data.models, [
    { name: 'appbar', path: '/api/v1/appbar', schema: 'appbar.schema.json' },   // issue #1253
    { name: 'meta', path: '/api/v1/meta', schema: 'meta.schema.json' },
  ]);
  assert.deepEqual([body.data.commands, body.data.events], [[], []]);
});

test('freshness reads the last finished tick: fresh when recent, stale when old, null times stay null', async t => {
  const get = await serve(t, { now: () => 100 * 60000 });
  assert.equal(JSON.parse((await get('/api/v1/meta')).body).freshness.state, 'unknown');
  const reply = at => { fs.writeFileSync(path.join(get.root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at } })); return get('/api/v1/meta').then(r => JSON.parse(r.body).freshness); };
  assert.deepEqual([(await reply(99 * 60000)).state, (await reply(50 * 60000)).state], ['fresh', 'stale']);
  const cases = [[99 * 60000, 'fresh', 60], [50 * 60000, 'stale', 3000]];
  for (const [at, state, age] of cases) {
    const f = freshnessOf({ tickAt: at, now: 100 * 60000, staleAfterMs: 600000 });
    assert.deepEqual([f.state, f.age_seconds, f.stale_after_seconds, f.tick_at], [state, age, 600, new Date(at).toISOString()]);
    assert.deepEqual(validate({ $ref: 'common.schema.json#/$defs/freshness' }, f, schemaSet()), []);
  }
});

test('the model list comes from the folder: a folder holding only the meta module still serves', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api1248m-'));
  removeLater(dir);
  fs.mkdirSync(path.join(dir, 'models'));
  fs.symlinkSync(fileURLToPath(new URL('schemas', API)), path.join(dir, 'schemas'));
  fs.copyFileSync(new URL('models/meta.mjs', API), path.join(dir, 'models', 'meta.mjs'));
  fs.writeFileSync(path.join(dir, 'models', 'README.txt'), 'not a module');
  const get = await serve(t, { apiDir: dir });
  const r = await get('/api/v1/meta');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body).data.models.map(m => m.name), ['meta']);
});

test('a second model module is served without any edit to the router', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api1248x-'));
  removeLater(dir);
  fs.mkdirSync(path.join(dir, 'models'));
  fs.symlinkSync(fileURLToPath(new URL('schemas', API)), path.join(dir, 'schemas'));
  fs.copyFileSync(new URL('models/meta.mjs', API), path.join(dir, 'models', 'meta.mjs'));
  fs.writeFileSync(path.join(dir, 'models', 'ping.mjs'), "export const name = 'ping'; export const path = 'ping'; export const schema = 'meta.schema.json'; export const usesView = false; export const build = () => ({ pong: true });\n");
  fs.writeFileSync(path.join(dir, 'models', 'broken.mjs'), 'export const name = 1;\n');
  const get = await serve(t, { apiDir: dir });
  const ping = JSON.parse((await get('/api/v1/ping')).body);
  assert.equal(ping.model, 'ping');
  assert.deepEqual(ping.data, { pong: true });
  assert.deepEqual(JSON.parse((await get('/api/v1/meta')).body).data.models.map(m => m.name), ['meta', 'ping']);
});

test('HEAD answers with the headers and no body', async t => {
  const get = await serve(t);
  const r = await get('/api/v1/meta', 'HEAD');
  assert.equal(r.status, 200);
  assert.equal(r.headers['foreman-contract'], '1.0');
  assert.equal(r.body, '');
});

test('schemas are served by exact name; the common schema defines condition', async t => {
  const get = await serve(t);
  const r = await get('/api/v1/schemas/common.schema.json');
  assert.equal(r.status, 200);
  assert.equal(r.headers['foreman-contract'], '1.0');
  assert.ok(Object.hasOwn(JSON.parse(r.body).$defs, 'condition'));
});

test('an unknown path is a JSON 404 with code not_found', async t => {
  const get = await serve(t);
  for (const p of ['/api/v1/nope', '/api/v1/', '/api/v1/meta/', '/api/v1/schemas/nope.json']) {
    const r = await get(p);
    assert.equal(r.status, 404, p);
    const body = JSON.parse(r.body);
    assert.equal(body.error.code, 'not_found');
    assert.equal(typeof body.error.text, 'string');
    assert.equal(r.headers['foreman-contract'], '1.0');
  }
});

test('a schema name that is not in the list is 404, whatever it contains', async t => {
  const get = await serve(t);
  for (const name of ['a..b', '..', '../../package.json', '%2e%2e%2fmeta.schema.json', 'meta.schema.json/', 'common.schema.json%00', '..%2f..%2fetc%2fpasswd']) {
    const r = await get(`/api/v1/schemas/${name}`);
    assert.equal(r.status, 404, name);
    assert.equal(JSON.parse(r.body).error.code, 'not_found');
  }
});

test('methods other than GET and HEAD answer 405 as JSON', async t => {
  const get = await serve(t);
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const r = await get('/api/v1/meta', method);
    assert.equal(r.status, 405, method);
    assert.equal(r.headers.allow, 'GET, HEAD');
    assert.equal(JSON.parse(r.body).error.code, 'method_not_allowed');
  }
});

test('a request with a foreign Host is refused with 421 JSON', async t => {
  const get = await serve(t);
  const r = await get('/api/v1/meta', 'GET', { host: 'evil.example' });
  assert.equal(r.status, 421);
  assert.equal(JSON.parse(r.body).error.code, 'unexpected_host');
});

test('existing routes answer as before: /healthz and /api/view.json', async t => {
  const get = await serve(t);
  const health = await get('/healthz');
  assert.equal(health.status, 200);
  assert.equal(health.body, 'ok\n');
  assert.equal(health.headers['foreman-contract'], undefined);
  const view = await get('/api/view.json');
  assert.notEqual(view.status, 404);
  assert.equal(view.headers['foreman-contract'], undefined);
  const post = await get('/healthz', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.body, 'read-only dashboard');
});

// Validator unit cases.
const schema = {
  type: 'object', required: ['name', 'kind'], additionalProperties: false,
  properties: { name: { type: 'string' }, kind: { enum: ['a', 'b'] }, count: { type: 'integer', minimum: 0 }, at: { type: 'string', format: 'date-time' }, tags: { type: 'array', items: { type: 'string' } } },
};
test('validator: a valid value has no errors', () => {
  assert.deepEqual(validate(schema, { name: 'x', kind: 'a', count: 1, at: '2026-01-02T03:04:05Z', tags: ['t'] }), []);
});
test('validator: a missing required field is reported with its path', () => {
  assert.deepEqual(validate(schema, { kind: 'a' }), ['$.name: required field is missing']);
});
test('validator: a wrong type is reported with its path', () => {
  const errors = validate(schema, { name: 5, kind: 'a', tags: ['ok', 7] });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^\$\.name: expected string, got integer/);
  assert.match(errors[1], /^\$\.tags\[1\]: expected string/);
});
test('validator: an unknown field under additionalProperties false is reported', () => {
  assert.deepEqual(validate(schema, { name: 'x', kind: 'a', extra: 1 }), ['$.extra: unknown field']);
});
test('validator: a value outside an enum is reported', () => {
  const errors = validate(schema, { name: 'x', kind: 'c' });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^\$\.kind: "c" is not one of a, b/);
});
test('validator: a time that does not end in Z is reported', () => {
  for (const at of ['2026-01-02T03:04:05+00:00', '2026-01-02T03:04:05', '2026-13-45T03:04:05Z']) {
    const errors = validate(schema, { name: 'x', kind: 'a', at });
    assert.equal(errors.length, 1, at);
    assert.match(errors[0], /^\$\.at: .*UTC date-time ending in Z/);
  }
});
test('validator: minimum, $ref across files, anyOf and const', () => {
  const files = { 'a.json': { $defs: { n: { type: 'integer', minimum: 1 } } } };
  const s = { properties: { x: { $ref: 'a.json#/$defs/n' }, y: { anyOf: [{ type: 'null' }, { const: 'k' }] } } };
  assert.deepEqual(validate(s, { x: 1, y: null }, files), []);
  assert.match(validate(s, { x: 0 }, files)[0], /^\$\.x: 0 is below the minimum 1/);
  assert.match(validate(s, { y: 'z' }, files)[0], /^\$\.y: matches none/);
  assert.match(validate({ $ref: 'gone.json#/x' }, 1, files)[0], /unknown schema file gone.json/);
});
test('validator.mjs has no imports', () => {
  assert.doesNotMatch(fs.readFileSync(new URL('validate.mjs', API), 'utf8'), /^\s*import\s|\bimport\(|require\(/m);
});
