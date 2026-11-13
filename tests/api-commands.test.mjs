// Issue #1257: POST /api/v1/commands/{name} and GET /api/v1/audit, driven through the real dashboard request handler with a temporary Inbox
// folder and state root, sending the origin and the access proof a real page sends. Replies are checked against the closed schemas.
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
import { readSince } from '../supervisor/api/eventlog.mjs';
import { parseRequest } from '../supervisor/api/command-request.mjs';

const NOW = Date.UTC(2026, 10, 12, 13, 2, 0);
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const NAMES = ['common', 'audit', 'meta', 'command-request', 'command-result'];
const schemas = Object.fromEntries(NAMES.map(n => [`${n}.schema.json`, readSchema(`${n}.schema.json`)]));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const idOf = (n, tail = 'a') => n.toString(16).padStart(8, '0') + tail.repeat(24);
const DRIFT = 'Rules drift check read only Driftcheck';
const KEY = 'abcdefgh';

async function serve(t, { items = [{ n: 1, title: DRIFT }] } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1257-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team', 'inbox/status', 'inbox/items']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const { n, title, state = 'pending', tail } of items) {
    const id = idOf(n, tail);
    const item = { kind: 'prompt', title, prompt: 'Read the rules and report any drift.', why: 'A weekly check.', effect: 'read_only' };
    fs.writeFileSync(path.join(root, 'inbox', 'items', `${id}.json`), JSON.stringify(item));
    fs.writeFileSync(path.join(root, 'inbox', 'status', `${id}.json`), JSON.stringify({ id, state, kind: 'prompt', title, hash: hashOf(item), createdAt: NOW - 5000 }));
  }
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  const clock = { now: NOW };
  const wakes = [];
  server.on('request', handler({ wake: (...args) => wakes.push(args[1]), root, config: { ...config, inbox: { dir: path.join(root, 'inbox') } }, host: '127.0.0.1', port, now: () => clock.now }));
  const origin = `http://127.0.0.1:${port}`;
  const send = (method, p, body, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, text, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const post = (name, body, { proof = writeToken(root), from = origin } = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) };
    if (proof) headers['x-foreman-proof'] = proof;
    if (from) headers.origin = from;
    return send('POST', `/api/v1/commands/${name}`, text, headers);
  };
  const get = p => send('GET', p, undefined, {});
  return { root, clock, wakes, post, get, origin };
}

const ask = (id, extra = {}) => ({ input: { id }, reason: null, idempotency_key: KEY, ...extra });
const statusFile = (root, n) => JSON.parse(fs.readFileSync(path.join(root, 'inbox', 'status', `${idOf(n)}.json`), 'utf8'));
const shape = reply => assert.deepEqual(validate(schemas['command-result.schema.json'], reply, schemas), [], 'the reply fits command-result.schema.json');
const auditOf = async s => {
  const r = await s.get('/api/v1/audit');
  assert.equal(r.status, 200);
  assert.deepEqual(validate(schemas['audit.schema.json'], r.body, schemas), [], 'the audit reply fits audit.schema.json');
  return r.body.data;
};

test('valid: the Driftcheck item is approved by its 8 character id, the reply says approved, and the wake is requested', async t => {
  const s = await serve(t);
  const r = await s.post('inbox.approve', ask('00000001'));
  assert.equal(r.status, 200);
  shape(r.body);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.outcome, 'applied');
  assert.equal(r.body.result.condition.state, 'approved');
  assert.equal(r.body.result.target.title, DRIFT);
  assert.deepEqual(r.body.undo, { command: 'inbox.undo_decision', input: { id: '00000001' }, until: new Date(NOW + 30000).toISOString() });
  assert.equal(statusFile(s.root, 1).state, 'approved');
  assert.deepEqual(s.wakes, ['approve']);
  assert.match(r.body.audit_id, /^[a-f0-9]{8}$/);
  assert.equal(r.body.cursor, readSince(s.root, null).events.at(-1).id, 'the reply cursor is the newest event');
});

test('valid: approve, then undo inside the window: waiting again, two audit entries, the first reads undone, one event each', async t => {
  const s = await serve(t);
  const first = await s.post('inbox.approve', ask(idOf(1)));
  s.clock.now += 5000;
  const second = await s.post('inbox.undo_decision', ask('00000001', { idempotency_key: 'undo-key-1' }));
  assert.equal(second.status, 200);
  shape(second.body);
  assert.equal(second.body.result.condition.state, 'waiting_for_approval');
  assert.equal(second.body.undo, null);
  assert.equal(statusFile(s.root, 1).state, 'pending');
  const audit = await auditOf(s);
  assert.equal(audit.entries.length, 2);
  assert.deepEqual(audit.entries.map(e => e.id), [second.body.audit_id, first.body.audit_id], 'newest first');
  const [undoEntry, approveEntry] = audit.entries;
  assert.equal(approveEntry.undo.undone_by, undoEntry.id);
  assert.equal(approveEntry.undo.available, false);
  assert.deepEqual([audit.direct_control, audit.summary], [null, { window_seconds: 86400, applied: 2, refused: 0, undone: 1 }]);
  assert.deepEqual([approveEntry.actor, approveEntry.client, approveEntry.before.state, approveEntry.after.state], ['homeowner', 'web', 'waiting_for_approval', 'approved']);
  const events = readSince(s.root, null).events.filter(e => e.type === 'command_applied');
  assert.deepEqual(events.map(e => [e.command, e.audit_id, e.actor]), [['inbox.approve', first.body.audit_id, 'homeowner'], ['inbox.undo_decision', second.body.audit_id, 'homeowner']]);
  assert.deepEqual(events[0].models, ['inbox', 'overview', 'appbar']);
});

test('valid: reject records the decision and offers the same undo', async t => {
  const s = await serve(t);
  const r = await s.post('inbox.reject', ask('00000001'));
  assert.equal(r.status, 200);
  assert.equal(r.body.result.condition.state, 'rejected');
  assert.equal(r.body.undo.command, 'inbox.undo_decision');
  assert.deepEqual(s.wakes, [], 'a rejection does not request the wake');
});

test('boundary: an undo one second after the window is refused with undo_window_passed and changes nothing', async t => {
  const s = await serve(t);
  await s.post('inbox.approve', ask('00000001'));
  s.clock.now += 31000;
  const r = await s.post('inbox.undo_decision', ask('00000001', { idempotency_key: 'undo-key-1' }));
  assert.equal(r.status, 409);
  shape(r.body);
  assert.deepEqual([r.body.ok, r.body.outcome, r.body.refusal_code, r.body.result], [false, 'refused', 'undo_window_passed', null]);
  assert.equal(statusFile(s.root, 1).state, 'approved');
  const audit = await auditOf(s);
  assert.deepEqual(audit.entries.map(e => [e.command, e.outcome, e.refusal_code]), [['inbox.undo_decision', 'refused', 'undo_window_passed'], ['inbox.approve', 'applied', null]]);
  assert.equal(audit.entries[1].undo.undone_by, null);
  assert.equal(audit.entries[1].undo.available, false, 'the undo time has passed');
});

test('boundary: a body of exactly 16384 bytes is read and one byte more answers 400', async t => {
  const s = await serve(t);
  const base = JSON.stringify(ask('00000001'));
  const exact = base + ' '.repeat(16384 - Buffer.byteLength(base));
  assert.equal(Buffer.byteLength(exact), 16384);
  const ok = await s.post('inbox.approve', exact);
  assert.equal(ok.status, 200);
  const over = await s.post('inbox.approve', exact + ' ');
  assert.equal(over.status, 400);
  shape(over.body);
  assert.equal(over.body.refusal_code, 'malformed_request');
});

test('boundary: the same key sent twice gives one audit entry, one event, one effect and the first reply', async t => {
  const s = await serve(t);
  const first = await s.post('inbox.approve', ask('00000001'));
  s.clock.now += 5000;
  const again = await s.post('inbox.approve', ask('00000001'));
  assert.equal(again.status, 200);
  assert.deepEqual({ ...again.body, cursor: 0 }, { ...first.body, cursor: 0 });
  assert.equal((await auditOf(s)).entries.length, 1);
  assert.equal(readSince(s.root, null).events.filter(e => e.type === 'command_applied').length, 1);
  assert.deepEqual(s.wakes, ['approve']);
  s.clock.now += 11 * 60000;
  const late = await s.post('inbox.approve', ask('00000001'));
  assert.equal(late.status, 409, 'after 10 minutes the key is new and the item is no longer waiting');
  assert.equal(late.body.refusal_code, 'wrong_state');
});

test('valid: dry_run answers no_change without any effect, audit entry or event, and does not use up the key', async t => {
  const s = await serve(t);
  const r = await s.post('inbox.approve', ask('00000001', { dry_run: true }));
  assert.equal(r.status, 200);
  shape(r.body);
  assert.deepEqual([r.body.ok, r.body.outcome, r.body.result, r.body.audit_id], [true, 'no_change', null, null]);
  assert.equal(statusFile(s.root, 1).state, 'pending');
  assert.equal((await auditOf(s)).entries.length, 0);
  assert.equal(readSince(s.root, null).events.length, 0);
  assert.equal((await s.post('inbox.approve', ask('00000001'))).body.outcome, 'applied');
});

test('invalid: another origin and a wrong or missing proof answer 403 and change nothing', async t => {
  const s = await serve(t);
  const other = await s.post('inbox.approve', ask('00000001'), { from: 'http://evil.example' });
  assert.deepEqual([other.status, other.body.refusal_code, other.body.outcome], [403, 'origin_refused', 'refused']);
  const noOrigin = await s.post('inbox.approve', ask('00000001'), { from: null });
  assert.equal(noOrigin.body.refusal_code, 'origin_refused');
  const wrong = await s.post('inbox.approve', ask('00000001'), { proof: 'f'.repeat(64) });
  assert.deepEqual([wrong.status, wrong.body.refusal_code], [403, 'bad_proof']);
  const missing = await s.post('inbox.approve', ask('00000001'), { proof: null });
  assert.equal(missing.body.refusal_code, 'bad_proof');
  for (const r of [other, noOrigin, wrong, missing]) shape(r.body);
  assert.equal(statusFile(s.root, 1).state, 'pending');
  assert.equal((await auditOf(s)).entries.length, 0);
  assert.equal(readSince(s.root, null).events.length, 0);
});

test('invalid: an unknown command answers 404, and a body that does not fit answers 400 with its own audit entry', async t => {
  const s = await serve(t);
  const unknown = await s.post('inbox.explode', ask('00000001'));
  assert.deepEqual([unknown.status, unknown.body.refusal_code, unknown.body.command], [404, 'unknown_command', 'inbox.explode']);
  shape(unknown.body);
  const cases = [
    [{ input: { id: '00000001' }, reason: null }, 'malformed_request'],
    [{ input: { id: '00000001' }, reason: null, idempotency_key: 'short' }, 'malformed_request'],
    [{ input: { id: '00000001' }, reason: 7, idempotency_key: KEY }, 'malformed_request'],
    [{ input: [], reason: null, idempotency_key: KEY }, 'malformed_request'],
    [{ input: { id: '00000001', extra: 1 }, reason: null, idempotency_key: KEY }, 'malformed_request'],
    [{ input: {}, reason: null, idempotency_key: KEY }, 'missing_input'],
    ['{not json', 'malformed_request'],
  ];
  for (const [body, code] of cases) {
    const r = await s.post('inbox.approve', body);
    assert.deepEqual([r.status, r.body.refusal_code], [400, code], JSON.stringify(body));
    shape(r.body);
  }
  assert.equal(statusFile(s.root, 1).state, 'pending');
  const audit = await auditOf(s);
  assert.equal(audit.entries.length, cases.length, 'each known-command request is audited and the unknown one is not');
  assert.equal(audit.summary.refused, cases.length);
});

test('invalid: approving a done item is wrong_state (409) and a short id two items share is ambiguous_id', async t => {
  const s = await serve(t, { items: [{ n: 1, title: 'Done one', state: 'done' }, { n: 2, title: 'Twin A', tail: 'a' }, { n: 2, title: 'Twin B', tail: 'b' }] });
  const done = await s.post('inbox.approve', ask('00000001'));
  assert.deepEqual([done.status, done.body.refusal_code, done.body.ok], [409, 'wrong_state', false]);
  assert.match(done.body.refusal_text, /already done/);
  shape(done.body);
  s.clock.now += 2000;
  const twin = await s.post('inbox.approve', ask('00000002', { idempotency_key: 'twin-key-1' }));
  assert.deepEqual([twin.status, twin.body.refusal_code], [409, 'ambiguous_id']);
  const full = await s.post('inbox.approve', ask(idOf(2, 'b'), { idempotency_key: 'twin-key-2' }));
  assert.equal(full.status, 200, 'the full id picks one');
  s.clock.now += 2000;
  const unknown = await s.post('inbox.approve', ask('0000ffff', { idempotency_key: 'twin-key-3' }));
  assert.equal(unknown.body.refusal_code, 'unknown_item');
});

test('invalid: undoing an item that is still waiting is refused and a second decision inside the cooldown answers 429', async t => {
  const s = await serve(t, { items: [{ n: 1, title: 'One' }, { n: 2, title: 'Two' }] });
  const undo = await s.post('inbox.undo_decision', ask('00000001'));
  assert.deepEqual([undo.status, undo.body.refusal_code], [409, 'already_acted_on']);
  const first = await s.post('inbox.approve', ask('00000001', { idempotency_key: 'cool-key-1' }));
  assert.equal(first.status, 200);
  const soon = await s.post('inbox.approve', ask('00000002', { idempotency_key: 'cool-key-2' }));
  assert.deepEqual([soon.status, soon.body.refusal_code], [429, 'cooldown']);
  shape(soon.body);
  assert.equal(statusFile(s.root, 2).state, 'pending');
  s.clock.now += 1500;
  assert.equal((await s.post('inbox.approve', ask('00000002', { idempotency_key: 'cool-key-2' }))).status, 200, 'a cooldown reply is not kept under its key');
});

test('valid: meta lists every loaded command with tier, inputs and refusal codes, and the audit schema is served', async t => {
  const s = await serve(t);
  const meta = await s.get('/api/v1/meta');
  assert.deepEqual(validate(schemas['meta.schema.json'], meta.body, schemas), []);
  const named = meta.body.data.commands.filter(c => c.name.startsWith('inbox.')).map(c => [c.name, c.tier, c.reversible, c.undo_command]);
  assert.deepEqual(named, [['inbox.approve', 'person_only', true, 'inbox.undo_decision'], ['inbox.reject', 'person_only', true, 'inbox.undo_decision'], ['inbox.undo_decision', 'person_only', false, null]]);
  const approve = meta.body.data.commands[0];
  assert.deepEqual(approve.inputs, [{ name: 'id', type: 'string', required: true }]);
  assert.deepEqual(approve.refusals, ['ambiguous_id', 'unknown_item', 'wrong_state', 'item_changed']);
  assert.ok(meta.body.data.commands.every(c => !('run' in c)));
  assert.equal((await s.get('/api/v1/schemas/command-request.schema.json')).status, 200);
  assert.equal((await s.get('/api/v1/schemas/command-result.schema.json')).status, 200);
});

test('invalid: an item edited after it was picked up is refused with item_changed (the store marks it refused)', async t => {
  const s = await serve(t);
  fs.writeFileSync(path.join(s.root, 'inbox', 'items', `${idOf(1)}.json`), JSON.stringify({ kind: 'prompt', title: DRIFT, prompt: 'Changed.', why: 'x', effect: 'read_only' }));
  const r = await s.post('inbox.approve', ask('00000001'));
  assert.deepEqual([r.status, r.body.refusal_code], [409, 'item_changed']);
  assert.equal(statusFile(s.root, 1).state, 'refused', 'the store marks an item whose file changed as refused');
});

test('valid and invalid: request bodies fit command-request.schema.json exactly when parseRequest accepts them', () => {
  const fits = body => validate(schemas['command-request.schema.json'], body, schemas).length === 0;
  const accepted = body => parseRequest(JSON.stringify(body)).request !== undefined;
  const base = { input: { id: '00000001' }, reason: null, idempotency_key: KEY };
  const cases = [
    [base, true],
    [{ ...base, reason: 'because', dry_run: true }, true],
    [{ ...base, idempotency_key: 'a'.repeat(64) }, true],
    [{ input: base.input, reason: null }, false],
    [{ ...base, idempotency_key: 'short' }, false],
    [{ ...base, idempotency_key: 'a'.repeat(65) }, false],
    [{ ...base, idempotency_key: 'bad key!!' }, false],
    [{ ...base, reason: 7 }, false],
    [{ ...base, input: [] }, false],
    [{ ...base, dry_run: 'yes' }, false],
    [{ ...base, extra: 1 }, false],
  ];
  for (const [body, expected] of cases) {
    assert.equal(fits(body), expected, `schema verdict for ${JSON.stringify(body)}`);
    assert.equal(accepted(body), expected, `parseRequest verdict for ${JSON.stringify(body)}`);
  }
});
