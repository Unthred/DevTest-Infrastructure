// Issue #1288: the web shell sends a command with the access proof. Part one drives the real dashboard request handler (temporary Inbox
// folder and state root): get the shell index page, take the proof from its meta element and send inbox.approve with the real client
// function, whose fetch calls the handler. Part two checks that no other served shell file holds the proof.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import { hashOf } from '../supervisor/inbox.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { sendCommand, newIdempotencyKey } from '../supervisor/ui/client.mjs';

const NOW = Date.UTC(2026, 10, 13, 9, 0, 0);
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const schemas = Object.fromEntries(['common', 'command-result'].map(n => [`${n}.schema.json`, readSchema(`${n}.schema.json`)]));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const TITLE = 'Clear a retry cap on a pull request as a named command Capclear';
const ID = '00000001'.padEnd(32, 'a');
const KEY = 'key-12345';
const META = /<meta name="foreman-proof" content="([^"]*)">/;

async function serve(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'ui1288-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team', 'inbox/status', 'inbox/items']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const item = { kind: 'prompt', title: TITLE, prompt: 'Clear the retry cap.', why: 'A cap was reached.', effect: 'read_only' };
  fs.writeFileSync(path.join(root, 'inbox', 'items', `${ID}.json`), JSON.stringify(item));
  const status = { id: ID, state: 'pending', kind: 'prompt', title: TITLE, hash: hashOf(item), createdAt: NOW - 5000 };
  fs.writeFileSync(path.join(root, 'inbox', 'status', `${ID}.json`), JSON.stringify(status));
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  const full = { ...config, inbox: { dir: path.join(root, 'inbox') } };
  server.on('request', handler({ wake: () => {}, root, config: full, host: '127.0.0.1', port, now: () => NOW }));
  const origin = `http://127.0.0.1:${port}`;
  const requests = [];
  const call = (method, p, headers = {}, body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
  // A browser fetch: it sends the page's origin and answers like fetch does, with a json() that rejects on text that is not JSON.
  const fetchFn = async (url, init) => {
    requests.push(url);
    const body = init.body;
    const r = await call(init.method, url, { ...init.headers, origin, 'content-length': Buffer.byteLength(body) }, body);
    return { ok: r.status < 400, status: r.status, json: async () => JSON.parse(r.text) };
  };
  const page = async () => (await call('GET', '/api/v1/ui/index.html')).text;
  return { root, call, fetchFn, requests, page };
}

const docOf = html => ({ querySelector: () => { const m = META.exec(html); return m ? { getAttribute: () => m[1] } : null; } });
const statusOf = root => JSON.parse(fs.readFileSync(path.join(root, 'inbox', 'status', `${ID}.json`), 'utf8')).state;
const shape = reply => assert.deepEqual(validate(schemas['command-result.schema.json'], reply, schemas), [], 'the reply fits command-result.schema.json');

test('index page: one foreman-proof meta element with the proof, and no-store', async t => {
  const s = await serve(t);
  const r = await s.call('GET', '/api/v1/ui/index.html');
  assert.equal(r.status, 200);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.text.match(/foreman-proof/g).length, 1);
  assert.equal(META.exec(r.text)[1], writeToken(s.root));
});

test('valid: the waiting Capclear item is approved by the real client, and the reply fits the schema', async t => {
  const s = await serve(t);
  const doc = docOf(await s.page());
  const reply = await sendCommand('inbox.approve', { id: ID.slice(0, 8) }, null, false, KEY, { fetchFn: s.fetchFn, doc });
  assert.equal(reply.ok, true);
  assert.equal(reply.outcome, 'applied');
  shape(reply);
  assert.equal(reply.undo.command, 'inbox.undo_decision');
  assert.equal(typeof reply.cursor, 'string');
  assert.equal(statusOf(s.root), 'approved');
});

test('boundary: the same idempotency value twice returns the first reply and approves once', async t => {
  const s = await serve(t);
  const deps = { fetchFn: s.fetchFn, doc: docOf(await s.page()) };
  const first = await sendCommand('inbox.approve', { id: ID.slice(0, 8) }, null, false, KEY, deps);
  const again = await sendCommand('inbox.approve', { id: ID.slice(0, 8) }, null, false, KEY, deps);
  assert.equal(again.ok, true);
  assert.equal(again.audit_id, first.audit_id);
  assert.equal(statusOf(s.root), 'approved');
});

test('boundary: a dry run returns no change and leaves the item waiting', async t => {
  const s = await serve(t);
  const reply = await sendCommand('inbox.approve', { id: ID.slice(0, 8) }, null, true, KEY, { fetchFn: s.fetchFn, doc: docOf(await s.page()) });
  assert.equal(reply.ok, true);
  assert.equal(reply.outcome, 'no_change');
  shape(reply);
  assert.equal(statusOf(s.root), 'pending');
});

test('boundary: a generated idempotency value is 8 to 64 letters, digits, underscore or hyphen', () => {
  assert.match(newIdempotencyKey(), /^[A-Za-z0-9_-]{8,64}$/);
});

test('invalid: a page with no meta element returns no_answer and sends nothing', async t => {
  const s = await serve(t);
  const html = (await s.page()).replace(META, '');
  const reply = await sendCommand('inbox.approve', { id: ID.slice(0, 8) }, null, false, KEY, { fetchFn: s.fetchFn, doc: docOf(html) });
  assert.equal(reply.ok, false);
  assert.equal(reply.refusal_code, 'no_answer');
  assert.deepEqual(s.requests, []);
});

test('invalid: a rejecting fetch and a non-JSON answer each return no_answer without throwing', async t => {
  const s = await serve(t);
  const doc = docOf(await s.page());
  const rejecting = await sendCommand('inbox.approve', { id: 'x' }, null, false, KEY, { fetchFn: async () => { throw new Error('offline'); }, doc });
  const notJson = async () => ({ ok: true, json: async () => JSON.parse('not json') });
  const text = await sendCommand('inbox.approve', { id: 'x' }, null, false, KEY, { fetchFn: notJson, doc });
  for (const reply of [rejecting, text]) {
    assert.equal(reply.ok, false);
    assert.equal(reply.refusal_code, 'no_answer');
    assert.match(reply.refusal_text, /\w+ \w+/);
  }
});

test('invalid: the name "Inbox Approve" returns bad_command_name and no request is sent', async t => {
  const s = await serve(t);
  const doc = docOf(await s.page());
  for (const name of ['Inbox Approve', 'inbox/approve', '', 'inbox..approve', 'inbox.']) {
    const reply = await sendCommand(name, {}, null, false, KEY, { fetchFn: s.fetchFn, doc });
    assert.equal(reply.refusal_code, 'bad_command_name', name);
  }
  assert.deepEqual(s.requests, []);
});

test('invalid: a wrong proof returns the endpoint bad_proof refusal and changes nothing', async t => {
  const s = await serve(t);
  const doc = docOf((await s.page()).replace(META, '<meta name="foreman-proof" content="wrong">'));
  const reply = await sendCommand('inbox.approve', { id: ID.slice(0, 8) }, null, false, KEY, { fetchFn: s.fetchFn, doc });
  assert.equal(reply.ok, false);
  assert.equal(reply.refusal_code, 'bad_proof');
  assert.equal(statusOf(s.root), 'pending');
});

test('part two: the style sheet and every shell script served under the same path do not contain the proof', async t => {
  const s = await serve(t);
  const proof = writeToken(s.root);
  const files = fs.readdirSync(new URL('../supervisor/ui/', import.meta.url)).filter(f => /\.(css|mjs|js)$/.test(f));
  assert.ok(files.includes('app.css') && files.includes('client.mjs'));
  for (const file of files) {
    const r = await s.call('GET', `/api/v1/ui/${file}`);
    assert.equal(r.status, 200, file);
    assert.ok(!r.text.includes(proof), `${file} must not hold the proof`);
  }
});
