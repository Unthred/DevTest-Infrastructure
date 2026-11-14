// Issue #1368: POST /api/v1/commands/upgrade.retry_install through the real dashboard request handler, over the same state folder a real SelfUpgrade
// wrote while it refused the commit of 13 Nov 2026 19:50 UTC. Sends the origin and access proof a real page sends.
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
import { SelfUpgrade } from '../supervisor/upgrade.mjs';
import { MAX_ATTEMPTS } from '../supervisor/upgrade-attempts.mjs';

const NOW = Date.UTC(2026, 10, 13, 19, 50);
const MIN = 60 * 1000;
const H = n => String(n).repeat(40).slice(0, 40);
const FROM = H('a'), TO = H('b');
const FAILING = 'valid: heartbeats keep to the 15 second limit (here 120 ms) even while other events are sent between them';
const API = new URL('../supervisor/api/', import.meta.url);
const schemas = Object.fromEntries(['common', 'audit', 'meta', 'command-request', 'command-result']
  .map(name => [`${name}.schema.json`, JSON.parse(fs.readFileSync(new URL(`schemas/${name}.schema.json`, API), 'utf8'))]));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
let keyCount = 0;

async function serve(t) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1368-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team', `versions/${FROM}`]) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.symlinkSync(`versions/${FROM}`, path.join(root, 'current'));
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  const clock = { now: NOW };
  const wakes = [];
  server.on('request', handler({ wake: (...args) => wakes.push(args[1]), root, config, host: '127.0.0.1', port, now: () => clock.now }));
  const send = (method, p, body, headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const retry = async () => {
    clock.now += 5000;
    const text = JSON.stringify({ input: {}, reason: null, idempotency_key: `retry-key-${String(++keyCount).padStart(4, '0')}` });
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), 'x-foreman-proof': writeToken(root), origin: `http://127.0.0.1:${port}` };
    return send('POST', '/api/v1/commands/upgrade.retry_install', text, headers);
  };
  return { root, clock, wakes, retry, get: p => send('GET', p, undefined, {}) };
}

// A real SelfUpgrade over the server's state folder with a fake installer that refuses; `step` runs one tick at the given minute.
function installer(root) {
  const state = { now: NOW, up: { ok: false, blocked: true, kind: 'tests', reason: `tests failed: ${FAILING}`, tests: [FAILING] }, calls: 0 };
  const deps = {
    config: { agents: { claude: { branch_prefix: 'claude/' }, codex: { branch_prefix: 'codex/' } } }, independenceApproved: () => true, installed: () => FROM, fetchMain: () => TO,
    isAncestor: () => true, changedFiles: () => ['supervisor/team.mjs'], mainCommits: () => [{ sha: H('9'), pr: 7, head: H('d') }],
    mergedPull: async () => ({ state: 'MERGED', headRefName: 'claude/issue-9-x', headRefOid: H('d'), statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }),
    verdict: () => ({ verdict: 'PASS', reviewer: 'codex' }), activeJobs: async () => 0, jobEndedAt: () => null,
    preChecks: async () => ({ ok: true }), upgrade: async () => { state.calls++; return state.up; },
    dryRunTick: async () => ({ ok: true }), rollback: async () => ({ ok: true }), alert: async () => {},
  };
  const step = minutes => { state.now = NOW + minutes * MIN; return new SelfUpgrade({ root, deps, clock: { now: () => state.now } }).step(); };
  return { state, step };
}

test('meta lists upgrade.retry_install: direct tier, no reason, not reversible, no undo and no inputs', async t => {
  const s = await serve(t);
  assert.equal((await s.get('/api/v1/meta')).status, 200);
  const { commands } = await import('../supervisor/api/routes/commands.mjs');
  const entry = commands.find(c => c.name === 'upgrade.retry_install');
  assert.deepEqual([entry.tier, entry.reason_required, entry.reversible, entry.undo_command, entry.inputs], ['direct', false, false, null, []]);
});

test('invalid: with nothing blocked the command is refused and audited, and nothing changes', async t => {
  const s = await serve(t);
  const r = await s.retry();
  assert.equal(r.status, 409);
  assert.deepEqual(validate(schemas['command-result.schema.json'], r.body, schemas), []);
  assert.equal(r.body.refusal_code, 'nothing_blocked');
  assert.deepEqual(s.wakes, []);
  assert.equal(fs.existsSync(path.join(s.root, 'team', 'self-upgrade.json')), false);
  const audit = (await s.get('/api/v1/audit')).body.data.entries;
  assert.deepEqual(audit.map(e => [e.command, e.outcome, e.refusal_code]), [['upgrade.retry_install', 'refused', 'nothing_blocked']]);
});

test('valid: after four refusals the command is audited, wakes the tick once and starts exactly one attempt', async t => {
  const s = await serve(t);
  const inst = installer(s.root);
  for (const minute of [0, 30, 60, 90]) await inst.step(minute);
  assert.equal(inst.state.calls, MAX_ATTEMPTS);
  assert.equal(await inst.step(200), 'precheck-failed');
  assert.equal(inst.state.calls, MAX_ATTEMPTS, 'no fifth attempt without the control');
  const r = await s.retry();
  assert.equal(r.status, 200);
  assert.deepEqual(validate(schemas['command-result.schema.json'], r.body, schemas), []);
  assert.deepEqual([r.body.ok, r.body.outcome], [true, 'accepted']);
  assert.deepEqual(s.wakes, ['approve']);
  const audit = (await s.get('/api/v1/audit')).body.data.entries;
  assert.deepEqual(audit.map(e => [e.command, e.outcome]), [['upgrade.retry_install', 'accepted']]);
  await inst.step(201);
  assert.equal(inst.state.calls, MAX_ATTEMPTS + 1, 'one attempt');
  await inst.step(202);
  await inst.step(203);
  assert.equal(inst.state.calls, MAX_ATTEMPTS + 1, 'and only one');
  inst.state.up = { ok: true };
  assert.equal((await s.retry()).status, 200);
  assert.equal(await inst.step(210), 'upgraded', 'the requested attempt installs when the tests pass');
});
