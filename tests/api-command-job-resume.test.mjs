// Issue #1333: POST /api/v1/commands/job.resume through the real dashboard request handler with a temporary Inbox folder and state root.
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
import { FIXED_REASON } from '../supervisor/api/commands/job-resume.mjs';

const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);
const API = new URL('../supervisor/api/', import.meta.url);
const JOB = '867710c6';
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const NAMES = ['common', 'audit', 'meta', 'command-request', 'command-result'];
const schemas = Object.fromEntries(NAMES.map(name => [`${name}.schema.json`, readSchema(`${name}.schema.json`)]));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
let keyCount = 0;
const nextKey = () => `resume-key-${String(++keyCount).padStart(4, '0')}`;

async function serve(t, { withInbox = true } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1333-'));
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
  const send = (method, requestPath, body, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let text = '';
      res.on('data', data => (text += data));
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const post = body => {
    const text = JSON.stringify(body);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-foreman-proof': writeToken(root), origin };
    return send('POST', '/api/v1/commands/job.resume', text, headers);
  };
  const resume = async (input, reason = null) => {
    clock.now += 5000;
    return post({ input, reason, idempotency_key: nextKey() });
  };
  return { root, inbox, wakes, resume, get: requestPath => send('GET', requestPath, undefined, {}) };
}

const shape = reply => assert.deepEqual(validate(schemas['command-result.schema.json'], reply, schemas), [], 'the reply fits command-result.schema.json');
const items = session => store.allStatuses(session.inbox);
const events = session => readSince(session.root, null).events.filter(event => event.type === 'command_applied');
const refusedWith = (reply, code) => {
  assert.equal(reply.status, 409);
  shape(reply.body);
  assert.deepEqual([reply.body.outcome, reply.body.refusal_code], ['refused', code]);
};

test('meta lists job.resume with tier direct, no reason, not reversible, no undo and one required string input job', async t => {
  const session = await serve(t);
  const response = await session.get('/api/v1/meta');
  assert.equal(response.status, 200);
  const entry = response.body.data.commands.find(command => command.name === 'job.resume');
  assert.deepEqual([entry.tier, entry.reason_required, entry.reversible, entry.undo_command], ['direct', false, false, null]);
  assert.deepEqual(entry.inputs, [{ name: 'job', type: 'string', required: true }]);
  assert.deepEqual(entry.refusals, ['bad_job_id', 'inbox_not_configured', 'already_queued', 'not_recorded']);
});

test('valid: job.resume for 867710c6 records one approved resume_job the store loads, wakes once, and reads its after condition', async t => {
  const session = await serve(t);
  const response = await session.resume({ job: JOB });
  assert.equal(response.status, 200);
  shape(response.body);
  assert.deepEqual([response.body.ok, response.body.outcome, response.body.undo], [true, 'accepted', null]);
  assert.deepEqual([response.body.result.target.kind, response.body.result.target.key], ['job', JOB]);
  assert.match(response.body.result.target.label, /867710c6/);
  assert.deepEqual(response.body.result.condition, { state: 'approved', attention: 'none', reason_code: null, reason_text: null, since: null });
  const all = items(session);
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].kind, all[0].action, all[0].target, all[0].state], ['action', 'resume_job', JOB, 'approved']);
  assert.equal(store.loadItem(session.inbox, all[0].id).ok, true);
  assert.deepEqual(session.wakes, ['job.resume']);
});

test('reason: a sent reason is trimmed, and only spaces use the fixed sentence', async t => {
  const session = await serve(t);
  await session.resume({ job: JOB }, '  Resume after the outage  ');
  await session.resume({ job: 'deadbeef' }, '   ');
  const reasonOf = target => store.loadItem(session.inbox, items(session).find(item => item.target === target).id).item.reason;
  assert.equal(reasonOf(JOB), 'Resume after the outage');
  assert.equal(reasonOf('deadbeef'), FIXED_REASON);
});

test('boundary: a 32 character job id uses its first 8 characters, and resuming 867710c6 twice is already_queued', async t => {
  const session = await serve(t);
  const fullId = `${JOB}${'a'.repeat(24)}`;
  const full = await session.resume({ job: fullId });
  assert.equal(full.body.result.target.key, JOB);
  await session.resume({ job: '12345678' });
  const again = await session.resume({ job: '12345678' });
  refusedWith(again, 'already_queued');
  assert.match(again.body.refusal_text, /resume_job for 12345678 is already queued/);
  assert.equal(items(session).length, 2);
  assert.equal(session.wakes.length, 2);
});

test('invalid: 7 characters, upper case, 9 characters and 33 characters are bad_job_id; a number is malformed_request; nothing records or wakes', async t => {
  const session = await serve(t);
  for (const job of ['1234567', 'ABCDEFGH', '123456789', `${JOB}${'a'.repeat(25)}`]) refusedWith(await session.resume({ job }), 'bad_job_id');
  const number = await session.resume({ job: 86771006 });
  assert.deepEqual([number.status, number.body.refusal_code], [400, 'malformed_request']);
  assert.equal(items(session).length, 0);
  assert.deepEqual(session.wakes, []);
});

test('an Inbox folder that is not configured is refused with inbox_not_configured and no wake', async t => {
  const session = await serve(t, { withInbox: false });
  refusedWith(await session.resume({ job: JOB }), 'inbox_not_configured');
  assert.deepEqual(session.wakes, []);
});

test('a helper refusal is handed on: a repeat is already_queued and any other is not_recorded with no wake', async t => {
  const session = await serve(t);
  await session.resume({ job: JOB });
  refusedWith(await session.resume({ job: JOB }), 'already_queued');
  const { commands } = await import('../supervisor/api/commands/job-resume.mjs');
  const reason = `token ghp_${'a1'.repeat(18)}`;
  const direct = commands[0].run({ job: 'deadbeef' }, { inboxDir: session.inbox, now: NOW, reason, wake: () => assert.fail('no wake') });
  assert.equal(direct.refusal_code, 'not_recorded');
  assert.notEqual(direct.refusal_text, '');
});

test('real entry point: the recorded item reaches the action runner of the real dispatch with resume_job and 867710c6', async t => {
  const session = await serve(t);
  await session.resume({ job: JOB });
  const [status] = items(session);
  const ran = [];
  const team = { runInboxAction: async (dir, state, item) => ran.push([item.action, item.target]) };
  await dispatchApproved(team, store, session.inbox, status, store.loadItem(session.inbox, status.id).item, {});
  assert.deepEqual(ran, [['resume_job', JOB]]);
});

test('audit: every applied and refused call writes one command_applied event, with before null and the read after condition', async t => {
  const session = await serve(t);
  const applied = await session.resume({ job: JOB });
  const refused = await session.resume({ job: '1234567' });
  const audit = await session.get('/api/v1/audit');
  assert.deepEqual(validate(schemas['audit.schema.json'], audit.body, schemas), []);
  const seen = audit.body.data.entries.map(entry => [entry.command, entry.outcome, entry.refusal_code]);
  assert.deepEqual(seen, [['job.resume', 'refused', 'bad_job_id'], ['job.resume', 'accepted', null]]);
  const accepted = audit.body.data.entries.find(entry => entry.outcome === 'accepted');
  assert.equal(accepted.before, null);
  assert.deepEqual(accepted.after, { state: 'approved', attention: 'none', reason_code: null, reason_text: null, since: null });
  assert.deepEqual(events(session).map(event => event.audit_id), [applied.body.audit_id, refused.body.audit_id]);
});
