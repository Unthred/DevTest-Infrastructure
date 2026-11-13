// Issue #1289: POST /api/v1/commands/work_item.clear_retry_cap through the real dashboard request handler with a temporary Inbox folder and state
// root, sending the origin and access proof a real page sends. Pull request 1189 is the real example: it holds a rebase retry cap.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import * as store from '../supervisor/inbox.mjs';
import { dispatchApproved } from '../supervisor/controlactions.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { readSince } from '../supervisor/api/eventlog.mjs';
import { FIXED_REASON } from '../supervisor/api/commands/work-item-clear-retry-cap.mjs';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const NAMES = ['common', 'audit', 'meta', 'command-request', 'command-result'];
const schemas = Object.fromEntries(NAMES.map(n => [`${n}.schema.json`, readSchema(`${n}.schema.json`)]));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
let keyCount = 0;
const nextKey = () => `capclear-key-${String(++keyCount).padStart(4, '0')}`;

async function serve(t, { withInbox = true } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1289-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team', 'inbox/status', 'inbox/items']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  const clock = { now: NOW };
  const wakes = [];
  const inbox = path.join(root, 'inbox');
  const cfg = withInbox ? { ...config, inbox: { dir: inbox } } : config;
  server.on('request', handler({ wake: (...args) => wakes.push(args[1]), root, config: cfg, host: '127.0.0.1', port, now: () => clock.now }));
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
  const post = (body) => {
    const text = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-foreman-proof': writeToken(root), origin };
    return send('POST', '/api/v1/commands/work_item.clear_retry_cap', text, headers);
  };
  // One call a second apart so the Inbox cooldown of the endpoint never hides the refusal under test.
  const clear = async (input, reason = null) => {
    clock.now += 5000;
    return post({ input, reason, idempotency_key: nextKey() });
  };
  return { root, inbox, clock, wakes, clear, get: p => send('GET', p, undefined, {}) };
}

const shape = reply => assert.deepEqual(validate(schemas['command-result.schema.json'], reply, schemas), [], 'the reply fits command-result.schema.json');
const items = s => store.allStatuses(s.inbox);
const events = s => readSince(s.root, null).events.filter(e => e.type === 'command_applied');
const refusedWith = (r, code) => {
  assert.equal(r.status, 409);
  shape(r.body);
  assert.deepEqual([r.body.outcome, r.body.refusal_code], ['refused', code]);
};

test('meta lists work_item.clear_retry_cap with tier approval, no reason, not reversible, no undo and one required key', async t => {
  const s = await serve(t);
  const r = await s.get('/api/v1/meta');
  assert.equal(r.status, 200);
  assert.equal(JSON.stringify(r.body).includes('"work_item.clear_retry_cap"'), true);
  const { commands } = await import('../supervisor/api/routes/commands.mjs');
  const entry = commands.find(c => c.name === 'work_item.clear_retry_cap');
  assert.deepEqual([entry.tier, entry.reason_required, entry.reversible, entry.undo_command], ['approval', false, false, null]);
  assert.deepEqual(entry.inputs, [{ name: 'key', type: 'string', required: true }]);
});

test('valid: rebase-1189 records one approved clear_retry_cap action with target 1189, wakes once, reply fits the schema', async t => {
  const s = await serve(t);
  const r = await s.clear({ key: 'rebase-1189' });
  assert.equal(r.status, 200);
  shape(r.body);
  assert.deepEqual([r.body.ok, r.body.outcome, r.body.undo], [true, 'accepted', null]);
  assert.equal(r.body.result.target.key, '1189');
  assert.match(r.body.result.target.label, /Pull request 1189/);
  const all = items(s);
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].kind, all[0].action, all[0].target, all[0].state], ['action', 'clear_retry_cap', '1189', 'approved']);
  assert.equal(store.loadItem(s.inbox, all[0].id).ok, true);
  assert.equal(s.wakes.length, 1);
});

test('reason: the one sent is stored, and a fixed sentence is stored when none is sent', async t => {
  const s = await serve(t);
  await s.clear({ key: 'rebase-1189' }, 'The cause is fixed');
  await s.clear({ key: 'rebase-1175' });
  const reasonOf = target => store.loadItem(s.inbox, items(s).find(i => i.target === target).id).item.reason;
  assert.equal(reasonOf('1189'), 'The cause is fixed');
  assert.equal(reasonOf('1175'), FIXED_REASON);
});

test('boundary: ci-fix-1117 gives target 1117; the same call twice with different idempotency values gives already_queued', async t => {
  const s = await serve(t);
  const first = await s.clear({ key: 'ci-fix-1117' });
  assert.equal(first.body.result.target.key, '1117');
  const again = await s.clear({ key: 'ci-fix-1117' });
  refusedWith(again, 'already_queued');
  assert.match(again.body.refusal_text, /clear_retry_cap for 1117 is already queued/);
  assert.equal(items(s).length, 1);
  assert.equal(s.wakes.length, 1);
});

test('boundary: a key of exactly 60 characters is accepted', async t => {
  const s = await serve(t);
  const key = `${'a'.repeat(55)}-1189`;
  assert.equal(key.length, 60);
  assert.equal((await s.clear({ key })).body.outcome, 'accepted');
});

test('implement-12 is refused with cap_on_issue naming issues and pull requests, nothing recorded, no wake', async t => {
  const s = await serve(t);
  const r = await s.clear({ key: 'implement-12' });
  refusedWith(r, 'cap_on_issue');
  assert.match(r.body.refusal_text, /on an issue.*pull requests only/);
  assert.equal(items(s).length, 0);
  assert.deepEqual(s.wakes, []);
});

test('invalid: rebase-, no hyphen, zero, a 61 character key are bad_key; a number as key is malformed; nothing recorded', async t => {
  const s = await serve(t);
  for (const key of ['rebase-', 'rebase', 'rebase-0', '-5', 'rebase-12x', `${'a'.repeat(56)}-1189`]) refusedWith(await s.clear({ key }), 'bad_key');
  const number = await s.clear({ key: 1189 });
  assert.deepEqual([number.status, number.body.refusal_code], [400, 'malformed_request']);
  assert.equal(items(s).length, 0);
  assert.deepEqual(s.wakes, []);
});

test('an Inbox folder that is not configured is refused with inbox_not_configured and no wake', async t => {
  const s = await serve(t, { withInbox: false });
  refusedWith(await s.clear({ key: 'rebase-1189' }), 'inbox_not_configured');
  assert.deepEqual(s.wakes, []);
});

test('a helper refusal other than a repeat is passed on as not_recorded with its sentence and no wake', async () => {
  const { commands } = await import('../supervisor/api/commands/work-item-clear-retry-cap.mjs');
  const reason = `token ghp_${'a1'.repeat(18)}`;
  const direct = commands[0].run({ key: 'rebase-1189' }, { inboxDir: os.tmpdir(), now: NOW, reason, wake: () => assert.fail('no wake') });
  assert.equal(direct.refusal_code, 'not_recorded');
  assert.notEqual(direct.refusal_text, '');
});

test('real entry point: the recorded item reaches the action runner of the real dispatch with clear_retry_cap and 1189', async t => {
  const s = await serve(t);
  await s.clear({ key: 'rebase-1189' });
  const [status] = items(s);
  const ran = [];
  const team = { runInboxAction: async (dir, st, item) => ran.push([item.action, item.target]) };
  await dispatchApproved(team, store, s.inbox, status, store.loadItem(s.inbox, status.id).item, {});
  assert.deepEqual(ran, [['clear_retry_cap', '1189']]);
});

test('audit: the applied and the refused call each write one audit entry and one command_applied event', async t => {
  const s = await serve(t);
  const ok = await s.clear({ key: 'rebase-1189' });
  const refused = await s.clear({ key: 'implement-12' });
  const r = await s.get('/api/v1/audit');
  assert.deepEqual(validate(schemas['audit.schema.json'], r.body, schemas), []);
  const seen = r.body.data.entries.map(e => [e.command, e.outcome, e.refusal_code]);
  assert.deepEqual(seen, [['work_item.clear_retry_cap', 'refused', 'cap_on_issue'], ['work_item.clear_retry_cap', 'accepted', null]]);
  assert.deepEqual(events(s).map(e => e.audit_id), [ok.body.audit_id, refused.body.audit_id]);
});
