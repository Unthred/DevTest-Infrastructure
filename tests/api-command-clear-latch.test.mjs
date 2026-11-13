// Issue #1290: POST /api/v1/commands/upgrade.clear_latch through the real dashboard request handler with a temporary Inbox folder and state
// root, sending the origin and access proof a real page sends. The real example is the latch of 13 Nov 2026, cleared after issue 1154 was restored.
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
const nextKey = () => `latch-key-${String(++keyCount).padStart(4, '0')}`;

async function serve(t, { withInbox = true } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1290-'));
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
    return send('POST', '/api/v1/commands/upgrade.clear_latch', text, headers);
  };
  // One call a second apart so the Inbox cooldown of the endpoint never hides the refusal under test.
  const clear = async (reason = null, input = {}) => {
    clock.now += 5000;
    return post({ input, reason, idempotency_key: nextKey() });
  };
  return { root, inbox, clock, wakes, clear, get: p => send('GET', p, undefined, {}) };
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

const REASON = 'Worktree of issue 1154 was left mid rebase and has been restored';
// Plain words, because a long run of one letter looks like a secret to the request check.
const words = n => 'latch cleared after review. '.repeat(Math.ceil(n / 27)).slice(0, n).trimEnd().padEnd(n, '.');

test('meta lists upgrade.clear_latch with tier person_only, reason required, not reversible, no undo and no inputs', async t => {
  const s = await serve(t);
  const r = await s.get('/api/v1/meta');
  assert.equal(r.status, 200);
  assert.equal(JSON.stringify(r.body).includes('"upgrade.clear_latch"'), true);
  const { commands } = await import('../supervisor/api/routes/commands.mjs');
  const entry = commands.find(c => c.name === 'upgrade.clear_latch');
  assert.deepEqual([entry.tier, entry.reason_required, entry.reversible, entry.undo_command, entry.inputs], ['person_only', true, false, null, []]);
});

test('valid: the real reason records one approved clear_latch action, wakes once and the reply fits the schema', async t => {
  const s = await serve(t);
  const r = await s.clear(REASON);
  assert.equal(r.status, 200);
  shape(r.body);
  assert.deepEqual([r.body.ok, r.body.outcome, r.body.undo], [true, 'accepted', null]);
  assert.equal(r.body.result.target.key, 'latch');
  assert.match(r.body.result.target.label, /upgrade/i);
  const all = items(s);
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].kind, all[0].action, all[0].target, all[0].state], ['action', 'clear_latch', 'latch', 'approved']);
  const loaded = store.loadItem(s.inbox, all[0].id);
  assert.equal(loaded.ok, true);
  assert.equal(loaded.item.reason, REASON);
  assert.deepEqual(s.wakes, ['clear_latch']);
});

test('boundary: 300 characters are accepted, 301 are reported as not_recorded, a second call while approved is already_queued', async t => {
  const s = await serve(t);
  const long = await s.clear(words(301));
  assert.equal(long.status, 409);
  shape(long.body);
  assert.equal(long.body.refusal_code, 'not_recorded');
  assert.equal(typeof long.body.refusal_text, 'string');
  assert.equal(items(s).length, 0);
  assert.equal((await s.clear(words(300))).body.outcome, 'accepted');
  const again = await s.clear(REASON);
  assert.equal(again.status, 409);
  shape(again.body);
  assert.equal(again.body.refusal_code, 'already_queued');
  assert.match(again.body.refusal_text, /clear_latch for latch is already queued/);
  assert.equal(items(s).length, 1);
  assert.equal(s.wakes.length, 1);
});

test('invalid: no reason, spaces only and an undeclared input are refused and record nothing', async t => {
  const s = await serve(t);
  const none = await s.clear(null);
  const spaces = await s.clear('   ');
  const extra = await s.clear(REASON, { issue: 1 });
  assert.deepEqual([none.status, none.body.refusal_code], [400, 'reason_required']);
  assert.deepEqual([spaces.status, spaces.body.refusal_code], [400, 'reason_required']);
  assert.deepEqual([extra.status, extra.body.refusal_code], [400, 'malformed_request']);
  assert.equal(items(s).length, 0);
  assert.deepEqual(s.wakes, []);
});

test('an Inbox folder that is not configured is refused with inbox_not_configured and no wake', async t => {
  const s = await serve(t, { withInbox: false });
  const r = await s.clear(REASON);
  assert.equal(r.status, 409);
  assert.equal(r.body.refusal_code, 'inbox_not_configured');
  assert.deepEqual(s.wakes, []);
});

test('real entry point: the recorded item reaches the action runner of the real dispatch with clear_latch and latch', async t => {
  const s = await serve(t);
  await s.clear(REASON);
  const [status] = items(s);
  const ran = [];
  const team = { runInboxAction: async (dir, st, item) => ran.push([item.action, item.target]) };
  await dispatchApproved(team, store, s.inbox, status, store.loadItem(s.inbox, status.id).item, {});
  assert.deepEqual(ran, [['clear_latch', 'latch']]);
});

test('audit: the applied entry keeps its reason, the refused one is listed, and each has one command_applied event', async t => {
  const s = await serve(t);
  const ok = await s.clear(REASON);
  const refused = await s.clear(words(301));
  const entries = await auditOf(s);
  const seen = entries.map(e => [e.command, e.outcome, e.refusal_code, e.reason]);
  assert.deepEqual(seen, [['upgrade.clear_latch', 'refused', 'not_recorded', words(301)], ['upgrade.clear_latch', 'accepted', null, REASON]]);
  assert.deepEqual(events(s).map(e => e.audit_id), [ok.body.audit_id, refused.body.audit_id]);
});
