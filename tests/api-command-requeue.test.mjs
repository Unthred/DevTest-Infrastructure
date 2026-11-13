// Issue #1284: POST /api/v1/commands/work_item.requeue through the real dashboard request handler with a temporary Inbox folder and state
// root, sending the origin and access proof a real page sends. Issue 1225 is the real example: its implement job ended blocked, post condition unmet.
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
import { FIXED_REASON } from '../supervisor/api/commands/work-item-requeue.mjs';

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
const nextKey = () => `requeue-key-${String(++keyCount).padStart(4, '0')}`;

async function serve(t, { withInbox = true } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1284-'));
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
    return send('POST', '/api/v1/commands/work_item.requeue', text, headers);
  };
  // One call a second apart so the Inbox cooldown of the endpoint never hides the refusal under test.
  const requeue = async (input, reason = null) => {
    clock.now += 5000;
    return post({ input, reason, idempotency_key: nextKey() });
  };
  return { root, inbox, clock, wakes, requeue, get: p => send('GET', p, undefined, {}) };
}

const shape = reply => assert.deepEqual(validate(schemas['command-result.schema.json'], reply, schemas), [], 'the reply fits command-result.schema.json');
const items = s => store.allStatuses(s.inbox);
const auditOf = async s => {
  const r = await s.get('/api/v1/audit');
  assert.equal(r.status, 200);
  assert.deepEqual(validate(schemas['audit.schema.json'], r.body, schemas), []);
  return r.body.data.entries;
};
const events = s => readSince(s.root, null).events.filter(e => e.type === 'command_applied');

test('meta lists work_item.requeue with tier approval, no reason, not reversible, no undo and one required integer input', async t => {
  const s = await serve(t);
  const r = await s.get('/api/v1/meta');
  assert.equal(r.status, 200);
  const found = JSON.stringify(r.body).includes('"work_item.requeue"');
  assert.equal(found, true);
  const { commands } = await import('../supervisor/api/routes/commands.mjs');
  const entry = commands.find(c => c.name === 'work_item.requeue');
  assert.deepEqual([entry.tier, entry.reason_required, entry.reversible, entry.undo_command], ['approval', false, false, null]);
  assert.deepEqual(entry.inputs, [{ name: 'issue', type: 'integer', required: true }]);
});

test('valid: issue 1225 records one approved reopen action with target 1225, wakes once and the reply fits the schema', async t => {
  const s = await serve(t);
  const r = await s.requeue({ issue: 1225 });
  assert.equal(r.status, 200);
  shape(r.body);
  assert.deepEqual([r.body.ok, r.body.outcome, r.body.undo], [true, 'accepted', null]);
  assert.equal(r.body.result.target.key, '1225');
  assert.match(r.body.result.target.label, /1225/);
  const all = items(s);
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].kind, all[0].action, all[0].target, all[0].state], ['action', 'reopen', '1225', 'approved']);
  assert.equal(store.loadItem(s.inbox, all[0].id).ok, true);
  assert.deepEqual(s.wakes, ['requeue']);
});

test('reason: the one sent is stored, and a fixed sentence is stored when none is sent', async t => {
  const s = await serve(t);
  await s.requeue({ issue: 1225 }, 'The job ended blocked with no pull request');
  await s.requeue({ issue: 1226 });
  const reasonOf = target => store.loadItem(s.inbox, items(s).find(i => i.target === target).id).item.reason;
  assert.equal(reasonOf('1225'), 'The job ended blocked with no pull request');
  assert.equal(reasonOf('1226'), FIXED_REASON);
});

test('boundary: issue 1 and 999999999 are accepted; 0 and 1000000000 are refused with bad_issue and record nothing', async t => {
  const s = await serve(t);
  for (const issue of [1, 999999999]) assert.equal((await s.requeue({ issue })).body.outcome, 'accepted', String(issue));
  assert.equal(items(s).length, 2);
  for (const issue of [0, 1000000000, -5]) {
    const r = await s.requeue({ issue });
    assert.equal(r.status, 409, String(issue));
    shape(r.body);
    assert.deepEqual([r.body.outcome, r.body.refusal_code], ['refused', 'bad_issue']);
  }
  assert.equal(items(s).length, 2);
  assert.equal(s.wakes.length, 2);
});

test('repeat: the same issue twice gives already_queued with the helper sentence, one item, one wake', async t => {
  const s = await serve(t);
  await s.requeue({ issue: 1225 });
  const r = await s.requeue({ issue: 1225 });
  assert.equal(r.status, 409);
  shape(r.body);
  assert.equal(r.body.refusal_code, 'already_queued');
  assert.match(r.body.refusal_text, /reopen for 1225 is already queued/);
  assert.equal(items(s).length, 1);
  assert.equal(s.wakes.length, 1);
});

test('invalid: text, a missing issue and a fractional issue are refused and record nothing', async t => {
  const s = await serve(t);
  const text = await s.requeue({ issue: '1225' });
  const missing = await s.requeue({});
  const fraction = await s.requeue({ issue: 12.5 });
  assert.deepEqual([text.status, text.body.refusal_code], [400, 'malformed_request']);
  assert.deepEqual([missing.status, missing.body.refusal_code], [400, 'missing_input']);
  assert.deepEqual([fraction.status, fraction.body.refusal_code], [400, 'malformed_request']);
  assert.equal(items(s).length, 0);
  assert.deepEqual(s.wakes, []);
});

test('an Inbox folder that is not configured is refused with inbox_not_configured and no wake', async t => {
  const s = await serve(t, { withInbox: false });
  const r = await s.requeue({ issue: 1225 });
  assert.equal(r.status, 409);
  assert.equal(r.body.refusal_code, 'inbox_not_configured');
  assert.deepEqual(s.wakes, []);
});

test('a refusal of the helper other than a repeat is passed on as not_recorded', async t => {
  const s = await serve(t);
  const r = await s.requeue({ issue: 1225 }, `token ghp_${'a1'.repeat(18)}`);   // the request check refuses a secret shaped reason first
  assert.equal(r.status, 400);
  assert.equal(items(s).length, 0);
  const { commands } = await import('../supervisor/api/commands/work-item-requeue.mjs');
  const reason = `token ghp_${'a1'.repeat(18)}`;
  const direct = commands[0].run({ issue: 1225 }, { inboxDir: s.inbox, now: NOW, reason, wake: () => assert.fail('no wake') });
  assert.equal(direct.refusal_code, 'not_recorded');
  assert.equal(typeof direct.refusal_text, 'string');
});

test('real entry point: the recorded item reaches the action runner of the real dispatch with reopen and 1225', async t => {
  const s = await serve(t);
  await s.requeue({ issue: 1225 });
  const [status] = items(s);
  const ran = [];
  const team = { runInboxAction: async (dir, st, item) => ran.push([item.action, item.target]) };
  await dispatchApproved(team, store, s.inbox, status, store.loadItem(s.inbox, status.id).item, {});
  assert.deepEqual(ran, [['reopen', '1225']]);
});

test('audit: the applied and the refused call each write one audit entry and one command_applied event', async t => {
  const s = await serve(t);
  const ok = await s.requeue({ issue: 1225 });
  const refused = await s.requeue({ issue: 0 });
  const entries = await auditOf(s);
  const seen = entries.map(e => [e.command, e.outcome, e.refusal_code]);
  assert.deepEqual(seen, [['work_item.requeue', 'refused', 'bad_issue'], ['work_item.requeue', 'accepted', null]]);
  assert.deepEqual(events(s).map(e => e.audit_id), [ok.body.audit_id, refused.body.audit_id]);
});
