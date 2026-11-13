// Issue #1254: GET /api/v1/events (the change stream) and its event log, driven through the real dashboard request handler on fixture state.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import { append, readSince, newestId, MAX_EVENTS } from '../supervisor/api/eventlog.mjs';
import { cursor, events as eventTypes } from '../supervisor/api/routes/events.mjs';

const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'));
const schemas = { 'common.schema.json': readSchema('common.schema.json'), 'event.schema.json': readSchema('event.schema.json') };
const checkEvent = event => assert.deepEqual(validate(schemas['event.schema.json'], event, schemas), [], `${event.type} validates`);
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1, rebaser: 1, inbox: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 3 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const writeTick = (root, at) => {
  const tick = { at, status: 'ok', error: null, lastOkAt: at };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: at, delivered: [], pulls: [], issues: [], tick }));
};

async function serve(t) {
  process.env.DEVTEST_EVENTS_POLL_MS = '30';
  process.env.DEVTEST_EVENTS_HEARTBEAT_MS = '120';
  t.after(() => { delete process.env.DEVTEST_EVENTS_POLL_MS; delete process.env.DEVTEST_EVENTS_HEARTBEAT_MS; });
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1254-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  writeTick(root, Date.now() - 1000);
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  const open = (headers = {}, query = '', method = 'GET') => new Promise((resolve, reject) => {
    const options = { host: '127.0.0.1', port, method, path: `/api/v1/events${query}`, headers: { host: `127.0.0.1:${port}`, ...headers } };
    const req = http.request(options, res => {
      const stream = { res, status: res.statusCode, events: [], raw: '', closed: false, close: () => req.destroy() };
      res.setEncoding('utf8');
      res.on('data', chunk => {
        stream.raw += chunk;
        if (!String(res.headers['content-type']).startsWith('text/event-stream')) return;
        stream.events = stream.raw.split('\n\n').slice(0, -1).filter(Boolean).map(block => {
          const fields = Object.fromEntries(block.split('\n').map(line => [line.slice(0, line.indexOf(': ')), line.slice(line.indexOf(': ') + 2)]));
          return { id: fields.id, type: fields.event, data: JSON.parse(fields.data) };
        });
      });
      res.on('close', () => { stream.closed = true; });
      t.after(() => req.destroy());
      resolve(stream);
    });
    req.on('error', reject);
    req.end();
  });
  const getJson = urlPath => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: urlPath, headers: { host: `127.0.0.1:${port}` } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }).on('error', reject);
  });
  return { root, open, getJson };
}
// A log that has had n events appended (the newest 500 kept), written as the module writes it (500 fsynced appends would only slow the test).
const seed = (root, n) => {
  const kept = Math.min(n, MAX_EVENTS);
  const at = new Date().toISOString();
  const events = Array.from({ length: kept }, (_, i) => ({ id: `e-${n - kept + i + 1}`, type: 'model_changed', at, models: ['meta'] }));
  fs.writeFileSync(path.join(root, 'dashboard', 'events.json'), JSON.stringify({ next: n + 1, events, lastTickAt: null, lastFreshness: null }));
};
const until = async (predicate, ms = 3000) => {
  for (let waited = 0; waited < ms; waited += 15) {
    if (predicate()) return true;
    await sleep(15);
  }
  return false;
};
const ofType = (stream, type) => stream.events.filter(e => e.type === type);

test('valid: the stream has the SSE type, sends hello first, then a heartbeat carrying freshness; every event validates', async t => {
  const { open } = await serve(t);
  const s = await open();
  assert.equal(s.status, 200);
  assert.match(s.res.headers['content-type'], /^text\/event-stream/);
  assert.ok(await until(() => ofType(s, 'heartbeat').length >= 2), 'heartbeats arrive');
  assert.equal(s.events[0].type, 'hello');
  assert.equal(s.events[0].data.contract, '1.0');
  const beat = ofType(s, 'heartbeat')[0].data;
  assert.equal(beat.freshness.state, 'fresh');
  for (const e of s.events) { checkEvent(e.data); assert.equal(e.id, e.data.id); assert.match(e.id, /^e-\d+$/); }
});

test('valid: a moved tick time delivers one model_changed naming the loaded models (meta among them); an appended event is delivered', async t => {
  const { open, root, getJson } = await serve(t);
  const s = await open();
  await sleep(100);
  writeTick(root, Date.now() - 500);
  assert.ok(await until(() => ofType(s, 'model_changed').length === 1));
  await sleep(150);
  assert.equal(ofType(s, 'model_changed').length, 1, 'once for the tick');
  const changed = ofType(s, 'model_changed')[0];
  assert.ok(changed.data.models.includes('meta'));
  checkEvent(changed.data);
  const stored = append(root, { type: 'command_applied', actor: 'homeowner', command: 'pause_team', audit_id: 'a-1', models: ['appbar'] });
  assert.ok(await until(() => ofType(s, 'command_applied').length === 1));
  assert.equal(ofType(s, 'command_applied')[0].id, stored.id);
  checkEvent(ofType(s, 'command_applied')[0].data);
  const meta = await getJson('/api/v1/meta');
  assert.equal(meta.body.cursor, stored.id, 'the envelope cursor is the newest event id');
  assert.deepEqual(meta.body.data.events.map(e => e.name), ['hello', 'heartbeat', 'model_changed', 'command_applied', 'freshness_changed', 'resync_required']);
  assert.deepEqual(eventTypes.map(e => e.name), meta.body.data.events.map(e => e.name));
});

test('valid: a stale tick appends one freshness_changed, and the cursor of an empty log is e-0', async t => {
  const { open, root } = await serve(t);
  assert.equal(cursor(root), 'e-0');
  const s = await open();
  await sleep(100);
  writeTick(root, Date.now() - 3 * 3600000);
  assert.ok(await until(() => ofType(s, 'freshness_changed').length === 1));
  assert.equal(ofType(s, 'freshness_changed')[0].data.freshness.state, 'stale');
  checkEvent(ofType(s, 'freshness_changed')[0].data);
});

test('boundary: two open streams and one tick give one appended event', async t => {
  const { open, root } = await serve(t);
  const a = await open();
  const b = await open();
  await sleep(100);
  writeTick(root, Date.now() - 400);
  assert.ok(await until(() => ofType(a, 'model_changed').length === 1 && ofType(b, 'model_changed').length === 1));
  await sleep(150);
  assert.equal(readSince(root, null).events.filter(e => e.type === 'model_changed').length, 1);
  assert.equal(ofType(a, 'model_changed')[0].id, ofType(b, 'model_changed')[0].id);
});

test('boundary: a reconnect at the newest id delivers nothing old, and an older id replays in order, none twice', async t => {
  const { open, root } = await serve(t);
  const ids = [1, 2, 3].map(n => append(root, { type: 'model_changed', models: [`m${n}`] }).id);
  const fresh = await open({ 'last-event-id': ids[2] });
  await sleep(200);
  assert.deepEqual(fresh.events.map(e => e.type).filter(type => type === 'model_changed'), []);
  const replay = await open({ 'last-event-id': ids[0] });
  assert.ok(await until(() => ofType(replay, 'model_changed').length === 2));
  await sleep(150);
  assert.deepEqual(ofType(replay, 'model_changed').map(e => e.id), [ids[1], ids[2]]);
  const byQuery = await open({}, `?cursor=${ids[1]}`);
  assert.ok(await until(() => ofType(byQuery, 'model_changed').length === 1));
  assert.equal(ofType(byQuery, 'model_changed')[0].id, ids[2]);
});

test('boundary: the log keeps 500 events, drops the oldest on the next append, and ids keep growing across a reload of the file', t => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1254-log-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  removeLater(root);
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  seed(root, MAX_EVENTS);
  assert.equal(readSince(root, null).events.length, 500);
  assert.equal(readSince(root, null).events[0].id, 'e-1');
  const last = append(root, { type: 'model_changed', models: ['meta'] });
  const all = readSince(root, null).events;
  assert.equal(all.length, 500);
  assert.equal(all[0].id, 'e-2');
  assert.equal(last.id, 'e-501');
  assert.equal(newestId(root), 'e-501');
  assert.equal(readSince(root, 'e-1').gap, false, 'e-1 is just before the oldest kept event, so nothing is missing');
  assert.equal(readSince(root, 'e-0').gap, true);
  assert.equal(append(root, { type: 'model_changed', models: [] }).id, 'e-502', 'the next id comes from the file, as after a restart');
});

test('invalid: an id older than the log gets resync_required with cursor_too_old; a malformed id is treated as none', async t => {
  const { open, root } = await serve(t);
  seed(root, 502);
  const old = await open({ 'last-event-id': 'e-1' });
  assert.ok(await until(() => ofType(old, 'resync_required').length === 1));
  assert.equal(ofType(old, 'resync_required')[0].data.reason_code, 'cursor_too_old');
  checkEvent(ofType(old, 'resync_required')[0].data);
  assert.equal(ofType(old, 'model_changed').length, 0, 'nothing is replayed after a resync');
  for (const bad of ['banana', 'e-', 'e--1', 'e-01', '5', 'e-9999999999999999999']) {
    const s = await open({ 'last-event-id': bad });
    await sleep(120);
    assert.deepEqual(s.events.filter(e => e.type !== 'heartbeat').map(e => e.type), ['hello'], `${bad} is no id`);
    s.close();
  }
});

test('invalid: a thirteenth stream answers 503 as JSON with a retry time, and a closed connection frees its place', async t => {
  const { open } = await serve(t);
  const streams = [];
  for (let n = 0; n < 12; n += 1) streams.push(await open());
  const refused = await open();
  assert.equal(refused.status, 503);
  assert.match(refused.res.headers['content-type'], /^application\/json/);
  assert.equal(refused.res.headers['retry-after'], '5');
  await sleep(50);
  assert.equal(JSON.parse(refused.raw).error.retry_after_seconds, 5);
  streams[0].close();
  await until(() => streams[0].closed);
  await sleep(100);
  const again = await open();
  assert.equal(again.status, 200);
});

test('HEAD answers 200 with no body and holds no stream open', async t => {
  const { open } = await serve(t);
  const head = await open({}, '', 'HEAD');
  assert.equal(head.status, 200);
  assert.match(head.res.headers['content-type'], /^text\/event-stream/);
  assert.ok(await until(() => head.closed), 'the response ends at once');
  assert.equal(head.raw, '');
  const streams = [];
  for (let n = 0; n < 12; n += 1) streams.push(await open());
  assert.equal(streams.every(s => s.status === 200), true, 'the HEAD took no place');
});

test('valid: heartbeats keep to the 15 second limit (here 120 ms) even while other events are sent between them', async t => {
  const { open, root } = await serve(t);
  const s = await open();
  for (let i = 0; i < 12; i++) { append(root, { type: 'model_changed', models: ['meta'] }); await sleep(40); }
  await until(() => ofType(s, 'heartbeat').length >= 4);
  const times = ofType(s, 'heartbeat').map(e => Date.parse(e.data.at));
  assert.ok(times.length >= 4, 'several heartbeats arrived');
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] <= 120, `gap ${times[i] - times[i - 1]} ms is within the limit`);
});
