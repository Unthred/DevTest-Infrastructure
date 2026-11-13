// Issue #1285: POST /api/v1/commands/job.resume and job.close through the real dashboard request handler with a temporary Inbox folder and state root.
// Real data: job 867710c6, the failed Inbox job examined in issue #1154.
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
import * as store from '../supervisor/inbox.mjs';
import { dispatchApproved } from '../supervisor/controlactions.mjs';

const NOW = Date.UTC(2026, 10, 13, 9, 0, 0);
const JOB = '867710c6';
const FULL = `${JOB}0123456789abcdef01234567`;
const FIXED = /homeowner used the control/;
const API = new URL('../supervisor/api/', import.meta.url);
const NAMES = ['common', 'audit', 'meta', 'command-request', 'command-result'];
const schemas = Object.fromEntries(NAMES.map(n => [`${n}.schema.json`, JSON.parse(fs.readFileSync(new URL(`schemas/${n}.schema.json`, API), 'utf8'))]));

async function serve(t, { withInbox = true } = {}) {
  const tmp = process.env.TMPDIR || os.tmpdir();
  const root = fs.mkdtempSync(path.join(tmp, 'api1285-'));
  const inbox = fs.mkdtempSync(path.join(tmp, 'api1285-inbox-'));
  t.after(() => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(inbox, { recursive: true, force: true }); });
  removeLater(root);
  removeLater(inbox);
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  const config = {
    schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
    agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
    ...(withInbox ? { inbox: { dir: inbox } } : {}),
  };
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  const wakes = [];
  let clock = 0;   // each call is later than the Inbox cooldown of the one before
  server.on('request', handler({ wake: (...args) => wakes.push(args[1]), root, config, host: '127.0.0.1', port, now: () => NOW + (clock += 5000) }));
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
  const post = (command, input, reason = null) => {
    const text = JSON.stringify({ input, reason, idempotency_key: `job-key-${++counter}` });
    return send('POST', `/api/v1/commands/${command}`, text, {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-foreman-proof': writeToken(root), origin: `http://127.0.0.1:${port}`,
    });
  };
  return { root, inbox, wakes, post, get: p => send('GET', p, undefined, {}) };
}

const shape = reply => assert.deepEqual(validate(schemas['command-result.schema.json'], reply, schemas), []);
const items = dir => store.allStatuses(dir);
const refusedWith = (r, code) => {
  assert.equal(r.status, 409);
  shape(r.body);
  assert.deepEqual([r.body.ok, r.body.outcome, r.body.refusal_code], [false, 'refused', code]);
};
const acceptedFor = (r, job) => {
  assert.equal(r.status, 200);
  shape(r.body);
  assert.deepEqual([r.body.ok, r.body.outcome, r.body.undo], [true, 'accepted', null]);
  assert.deepEqual([r.body.result.target.kind, r.body.result.target.key], ['job', job]);
  assert.match(r.body.result.target.label, new RegExp(job));
};

async function checkRecorded(t, command, action) {
  const s = await serve(t);
  acceptedFor(await s.post(command, { job: JOB }), JOB);
  assert.deepEqual(s.wakes, [command]);
  const all = items(s.inbox);
  assert.equal(all.length, 1);
  assert.deepEqual([all[0].state, all[0].kind, all[0].action, all[0].target], ['approved', 'action', action, JOB]);
  const loaded = store.loadItem(s.inbox, all[0].id);
  assert.equal(loaded.ok, true);
  assert.deepEqual([loaded.item.action, loaded.item.target, loaded.item.reason], [action, JOB, loaded.item.reason]);
  assert.match(loaded.item.reason, FIXED);
}

async function checkDispatched(t, command, action) {
  const s = await serve(t);
  await s.post(command, { job: JOB });
  const [status] = items(s.inbox);
  const ran = [];
  const runInboxAction = async (d, st, item) => {
    ran.push([item.action, item.target]);
    store.finish(d, st.id, { state: 'done', result: 'ok' }, NOW);
  };
  const team = { runInboxAction };
  await dispatchApproved(team, store, s.inbox, status, store.loadItem(s.inbox, status.id).item, {});
  assert.deepEqual(ran, [[action, JOB]]);
}

test('valid: job.resume for 867710c6 records one approved resume_job the store loads, one wake', t => checkRecorded(t, 'job.resume', 'resume_job'));
test('valid: job.close for 867710c6 records one approved close_job the store loads, one wake', t => checkRecorded(t, 'job.close', 'close_job'));
test('real dispatch: the item recorded by job.resume reaches the action runner with resume_job and 867710c6', t => checkDispatched(t, 'job.resume', 'resume_job'));
test('real dispatch: the item recorded by job.close reaches the action runner with close_job and 867710c6', t => checkDispatched(t, 'job.close', 'close_job'));

test('valid: meta lists both commands with their tier, no reason, no undo and one required text input job', async t => {
  const s = await serve(t);
  const meta = await s.get('/api/v1/meta');
  assert.equal(meta.status, 200);
  assert.deepEqual(validate(schemas['meta.schema.json'], meta.body, schemas), []);
  for (const [name, tier] of [['job.resume', 'direct'], ['job.close', 'approval']]) {
    const c = meta.body.data.commands.find(x => x.name === name);
    assert.deepEqual([c.tier, c.reason_required, c.reversible, c.undo_command], [tier, false, false, null]);
    assert.deepEqual(c.inputs, [{ name: 'job', type: 'string', required: true }]);
  }
});

test('boundary: a 32 character id gives a target of its first 8 characters', async t => {
  const s = await serve(t);
  acceptedFor(await s.post('job.resume', { job: FULL }), JOB);
  assert.equal(items(s.inbox)[0].target, JOB);
});

test('boundary: resume and close for the same job are both accepted, resume twice is already_queued', async t => {
  const s = await serve(t);
  acceptedFor(await s.post('job.resume', { job: JOB }), JOB);
  acceptedFor(await s.post('job.close', { job: JOB }), JOB);
  const again = await s.post('job.resume', { job: JOB });
  refusedWith(again, 'already_queued');
  assert.match(again.body.refusal_text, /already queued/);
  assert.equal(items(s.inbox).length, 2);
  assert.equal(s.wakes.length, 2);
});

test('reason: the one sent is stored; none or blank gives the fixed sentence', async t => {
  const s = await serve(t);
  await s.post('job.resume', { job: JOB }, 'Retry after the allowance reset');
  await s.post('job.close', { job: JOB }, '   ');
  const reasons = Object.fromEntries(items(s.inbox).map(st => [st.action, store.loadItem(s.inbox, st.id).item.reason]));
  assert.equal(reasons.resume_job, 'Retry after the allowance reset');
  assert.match(reasons.close_job, FIXED);
});

test('invalid: 7 characters, an upper case letter and 9 or 33 characters are bad_job_id; a number is malformed_request from the endpoint; nothing recorded, no wake', async t => {
  const s = await serve(t);
  for (const job of ['867710c', '867710C6', '867710c67', `${FULL}0`]) refusedWith(await s.post('job.close', { job }), 'bad_job_id');
  const number = await s.post('job.resume', { job: 86771006 });
  assert.equal(number.status, 400);
  assert.equal(number.body.refusal_code, 'malformed_request');
  assert.deepEqual(items(s.inbox), []);
  assert.deepEqual(s.wakes, []);
});

test('refusal: a reason the helper rejects is passed on as not_recorded with its sentence, nothing recorded, no wake', async t => {
  const s = await serve(t);
  const r = await s.post('job.resume', { job: JOB }, 'ask someone@example.com');
  refusedWith(r, 'not_recorded');
  assert.match(r.body.refusal_text, /e-mail address/);
  assert.deepEqual(items(s.inbox), []);
  assert.deepEqual(s.wakes, []);
});

test('refusal: no Inbox folder in the configuration gives inbox_not_configured, no wake', async t => {
  const s = await serve(t, { withInbox: false });
  refusedWith(await s.post('job.resume', { job: JOB }), 'inbox_not_configured');
  assert.deepEqual(s.wakes, []);
});

test('audit: every applied and refused call writes one audit entry and one command_applied event', async t => {
  const s = await serve(t);
  await s.post('job.resume', { job: JOB });
  await s.post('job.resume', { job: JOB });
  await s.post('job.close', { job: 'bad' });
  await s.post('job.close', { job: FULL });
  const audit = (await s.get('/api/v1/audit')).body;
  assert.deepEqual(validate(schemas['audit.schema.json'], audit, schemas), []);
  assert.deepEqual(audit.data.entries.map(e => `${e.command}:${e.outcome}`).sort(),
    ['job.close:accepted', 'job.close:refused', 'job.resume:accepted', 'job.resume:refused']);
  assert.equal(readSince(s.root, null).events.filter(e => e.type === 'command_applied').length, 4);
});
