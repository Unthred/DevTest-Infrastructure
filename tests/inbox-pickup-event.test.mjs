// Issue #1286: an Inbox pickup between ticks is announced on the change stream (GET /api/v1/events) at once. The real scan function runs on a
// temporary Inbox folder and state root; the real dashboard request handler serves the stream.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { scanInboxNow, INBOX_MODELS } from '../supervisor/wake.mjs';
import { scan, statusOf } from '../supervisor/inbox.mjs';
import { readSince } from '../supervisor/api/eventlog.mjs';

const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const TITLES = ['Action bridge', 'Known commands', 'Split accept'];
const idOf = n => String(n).repeat(32);

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'pickup1286-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  removeLater(dir);
  const root = path.join(dir, 'state');
  const inbox = path.join(dir, 'inbox');
  for (const sub of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, sub), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  fs.mkdirSync(path.join(inbox, 'items'), { recursive: true });
  const put = (n, raw) => fs.writeFileSync(path.join(inbox, 'items', `${idOf(n)}.json`), typeof raw === 'string' ? raw : JSON.stringify(raw));
  const draft = (n, title) => put(n, { kind: 'issue_draft', title, body: `Implement ${title} as described.`, why: 'test' });
  const logs = [];
  const pass = () => scanInboxNow({ root, inboxDir: inbox, scan, maxPending: 20, log: line => logs.push(line) });
  const events = () => readSince(root, null).events;
  return { dir, root, inbox, put, draft, pass, events, logs };
}

test('valid: one pass over three waiting drafts appends one model_changed naming inbox, overview and appbar', t => {
  const f = fixture(t);
  TITLES.forEach((title, i) => f.draft(i + 1, title));
  const result = f.pass();
  assert.equal(result.picked, 3);
  assert.equal(f.events().length, 1);
  assert.equal(f.events()[0].type, 'model_changed');
  assert.deepEqual(f.events()[0].models, ['inbox', 'overview', 'appbar']);
  assert.deepEqual(INBOX_MODELS, ['inbox', 'overview', 'appbar']);
});

test('boundary: a second pass with nothing new appends nothing', t => {
  const f = fixture(t);
  TITLES.forEach((title, i) => f.draft(i + 1, title));
  f.pass();
  assert.equal(f.pass().picked, 0);
  assert.equal(f.events().length, 1);
});

test('boundary: one valid and one malformed item in the same pass give one event, and a refused item alone counts as picked up', t => {
  const f = fixture(t);
  f.draft(1, TITLES[0]);
  f.put(2, '{ not json');
  assert.equal(f.pass().picked, 2);
  assert.equal(f.events().length, 1);
  f.put(3, '{ also not json');
  assert.equal(f.pass().picked, 1);
  assert.equal(statusOf(f.inbox, idOf(3)).state, 'refused');
  assert.equal(f.events().length, 2);
});

test('invalid: when the event log cannot be written the scan still returns its count, the items wait and the failure is logged once', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'dashboard', 'events.json'));   // a folder where the log file belongs: reading and writing it fail
  TITLES.forEach((title, i) => f.draft(i + 1, title));
  const result = f.pass();
  assert.equal(result.scanned, true);
  assert.equal(result.picked, 3);
  for (const n of [1, 2, 3]) assert.equal(statusOf(f.inbox, idOf(n)).state, 'pending');
  assert.equal(f.logs.length, 1);
  assert.match(f.logs[0], /not announced on the change stream: .+/);
});

test('real entry point: a client on GET /api/v1/events gets the event from a pickup with the tick time unchanged', async t => {
  const f = fixture(t);
  process.env.DEVTEST_EVENTS_POLL_MS = '30';
  t.after(() => { delete process.env.DEVTEST_EVENTS_POLL_MS; });
  const at = Date.now() - 1000;
  fs.writeFileSync(path.join(f.root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: at, delivered: [], pulls: [], issues: [], tick: { at, status: 'ok', error: null, lastOkAt: at } }));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root: f.root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  const head = await new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port, method: 'HEAD', path: '/api/v1/events', headers: { host: `127.0.0.1:${port}` } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject).end();
  });
  assert.equal(head, 200);
  let raw = '';
  const req = http.get({ host: '127.0.0.1', port, path: '/api/v1/events', headers: { host: `127.0.0.1:${port}` } }, res => { res.setEncoding('utf8'); res.on('data', d => (raw += d)); });
  t.after(() => req.destroy());
  const waitFor = async predicate => { for (let i = 0; i < 200 && !predicate(); i++) await new Promise(r => setTimeout(r, 15)); return predicate(); };
  assert.ok(await waitFor(() => raw.includes('event: hello')), 'the stream opens');
  assert.ok(!raw.includes('event: model_changed'));
  TITLES.forEach((title, i) => f.draft(i + 1, title));
  f.pass();
  assert.ok(await waitFor(() => raw.includes('event: model_changed')), 'the pickup reaches the client');
  const block = raw.split('\n\n').find(b => b.includes('event: model_changed'));
  const data = JSON.parse(block.split('\n').find(l => l.startsWith('data: ')).slice(6));
  assert.deepEqual(data.models, ['inbox', 'overview', 'appbar']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'dashboard', 'cache.json'), 'utf8')).tick.at, at);
});
