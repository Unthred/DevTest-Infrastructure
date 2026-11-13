// Issue #1281: POST /api/v1/commands/work_item.accept_split through the real dashboard request handler with a temporary state root.
// Real data: issue 1127 with a proposed split into the three parts titled as issues 1171, 1172 and 1173 are titled.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { readSince } from '../supervisor/api/eventlog.mjs';
import { takeHomeownerRequests } from '../supervisor/homeownerqueue.mjs';

const NOW = Date.UTC(2026, 10, 13, 9, 0, 0);
const API = new URL('../supervisor/api/', import.meta.url);
const NAMES = ['common', 'audit', 'meta', 'command-request', 'command-result'];
const schemas = Object.fromEntries(NAMES.map(n => [`${n}.schema.json`, JSON.parse(fs.readFileSync(new URL(`schemas/${n}.schema.json`, API), 'utf8'))]));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const CHILDREN = [
  { title: 'Read the repository, branch and pull request state', scope: 'part one' },
  { title: 'Supervisor follow-up for an agent held by the reserve', scope: 'part two' },
  { title: 'Show the held reading in the web shell', scope: 'part three' },
];
const split = status => ({ status, agent: 'alpha', children: CHILDREN });

async function serve(t, splits = { 1127: split('proposed') }) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1281-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {}, splits }));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  const wakes = [];
  server.on('request', handler({ wake: (...args) => wakes.push(args[1]), root, config, host: '127.0.0.1', port, now: () => NOW }));
  const send = (method, p, body, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
  let counter = 0;
  const post = (input, key = `split-key-${++counter}`) => {
    const text = JSON.stringify({ input, reason: null, idempotency_key: key });
    return send('POST', '/api/v1/commands/work_item.accept_split', text, {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-foreman-proof': writeToken(root), origin: `http://127.0.0.1:${port}`,
    });
  };
  return { root, wakes, post, get: p => send('GET', p, undefined, {}) };
}

const shape = reply => assert.deepEqual(validate(schemas['command-result.schema.json'], reply, schemas), []);
const queued = root => takeHomeownerRequests(root);
const refusedWith = (r, code, text) => {
  assert.equal(r.status, 409);
  shape(r.body);
  assert.deepEqual([r.body.ok, r.body.outcome, r.body.refusal_code], [false, 'refused', code]);
  assert.match(r.body.refusal_text, text);
};

test('valid: issue 1127 proposed is accepted, one request the tick would take, one wake', async t => {
  const s = await serve(t);
  const r = await s.post({ issue: 1127 });
  assert.equal(r.status, 200);
  shape(r.body);
  assert.deepEqual([r.body.ok, r.body.outcome, r.body.undo], [true, 'accepted', null]);
  assert.deepEqual([r.body.result.target.kind, r.body.result.target.key, r.body.result.target.label], ['issue', '1127', 'Issue #1127']);
  assert.deepEqual(s.wakes, ['accept-split']);
  const taken = queued(s.root);
  assert.equal(taken.length, 1);
  assert.deepEqual([taken[0].command, taken[0].args], ['accept-split', ['1127']]);
  const events = readSince(s.root, null).events.filter(e => e.type === 'command_applied');
  assert.deepEqual(events.map(e => [e.command, e.audit_id]), [['work_item.accept_split', r.body.audit_id]]);
});

test('valid: meta lists the command with tier approval, two optional integer inputs and no undo', async t => {
  const s = await serve(t);
  const meta = await s.get('/api/v1/meta');
  assert.deepEqual(validate(schemas['meta.schema.json'], meta.body, schemas), []);
  const c = meta.body.data.commands.find(x => x.name === 'work_item.accept_split');
  assert.deepEqual([c.tier, c.reason_required, c.reversible, c.undo_command], ['approval', false, false, null]);
  assert.deepEqual(c.inputs, [{ name: 'issue', type: 'integer', required: false }, { name: 'pull', type: 'integer', required: false }]);
});

test('boundary: a split already accepted is refused with the state found, nothing queued, no wake', async t => {
  const s = await serve(t, { 1127: split('accepted') });
  refusedWith(await s.post({ issue: 1127 }), 'no_proposed_split', /accepted/);
  assert.deepEqual(queued(s.root), []);
  assert.deepEqual(s.wakes, []);
});

test('boundary: the same idempotency key twice returns the first reply and leaves one request', async t => {
  const s = await serve(t);
  const first = await s.post({ issue: 1127 }, 'repeat-key-1');
  const again = await s.post({ issue: 1127 }, 'repeat-key-1');
  assert.equal(again.status, 200);
  assert.equal(again.body.audit_id, first.body.audit_id);
  assert.equal(queued(s.root).length, 1);
  assert.equal(s.wakes.length, 1);
});

test('invalid: issue 999999 has no split', async t => {
  const s = await serve(t);
  refusedWith(await s.post({ issue: 999999 }), 'no_proposed_split', /no split/);
  assert.deepEqual(queued(s.root), []);
  assert.deepEqual(s.wakes, []);
});

test('invalid: a pull input, an empty input and an issue with a pull are refused with split_needs_issue', async t => {
  const s = await serve(t);
  for (const input of [{ pull: 1192 }, {}, { issue: 1127, pull: 1192 }]) refusedWith(await s.post(input), 'split_needs_issue', /not built yet.*parked/);
  assert.deepEqual(queued(s.root), []);
  assert.deepEqual(s.wakes, []);
});

test('invalid: an issue given as text is refused before the command runs', async t => {
  const s = await serve(t);
  const r = await s.post({ issue: '1127' });
  assert.equal(r.status, 400);
  assert.equal(r.body.refusal_code, 'malformed_request');
  assert.deepEqual(queued(s.root), []);
});

test('audit: one entry for the applied call and one for a refused call', async t => {
  const s = await serve(t);
  await s.post({ issue: 1127 });
  await s.post({ issue: 999999 });
  const audit = (await s.get('/api/v1/audit')).body;
  assert.deepEqual(validate(schemas['audit.schema.json'], audit, schemas), []);
  assert.deepEqual(audit.data.entries.map(e => [e.command, e.outcome]).sort(), [['work_item.accept_split', 'accepted'], ['work_item.accept_split', 'refused']]);
  assert.equal(readSince(s.root, null).events.filter(e => e.type === 'command_applied').length, 2);
});
