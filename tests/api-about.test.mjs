// Issue #1451: GET /api/v1/about through the real dashboard handler over a temporary state root holding install records and an issue cache.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const DAY = 86400000;
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => [name, JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'))];
const schemas = Object.fromEntries(['common.schema.json', 'about.schema.json'].map(readSchema));
const sha = prefix => prefix.padEnd(40, '0');
const OLD = sha('5b160d0');
const NEW = sha('f748e46');
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const at = (h, m, s = 0) => Date.UTC(2026, 10, 14, h, m, s);
const install = (from, to, prs, upgradedAt, verifiedAt) => [
  { at: upgradedAt, from, to, prs, result: 'upgraded' },
  ...(verifiedAt ? [{ at: verifiedAt, from, to, prs, result: 'verified' }] : []),
];
const restart = (sha40, when) => ({ at: when, from: sha40, to: sha40, result: 'dashboard_restarted', restarted: true });
const REAL = [...install(OLD, NEW, [1425], at(9, 18), at(9, 20)), restart(NEW, at(9, 20, 38))];
const CACHE = {
  merged: [{ number: 1425, title: 'Agent choice starts a job whenever an agent really has room for it', mergedAt: '2026-11-14T09:10:00Z', issue: 1424 }],
  issues: [{ number: 1424, title: 'Agent choice starts a job whenever an agent really has room for it and no longer holds all work on a projected overrun Roomgate', state: 'closed' }],
};

async function serve(t, { records = [], rawLines = null, cache = CACHE, state = null } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1451-'));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  const lines = rawLines ?? records.map(r => JSON.stringify(r));
  if (lines.length) fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), `${lines.join('\n')}\n`);
  if (state) fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify(state));
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick, ...cache }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => NOW }));
  const reply = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/v1/about', headers: { host: `127.0.0.1:${port}` } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    }).on('error', reject);
  });
  assert.equal(reply.status, 200);
  assert.deepEqual(validate(schemas['about.schema.json'], reply.body, schemas), []);
  assert.equal(reply.body.model, 'about');
  return reply.body.data;
}

test('the install of 14 Nov 2026 lists one version for f748e46 with its pull request and issue title, and the restart is not a second version', async t => {
  const data = await serve(t, { records: REAL });
  assert.equal(data.installed, NEW);
  assert.equal(data.installed_short, 'f748e46');
  assert.equal(data.installed_at, '2026-11-14T09:18:00.000Z');
  assert.equal(data.verified_at, '2026-11-14T09:20:00.000Z');
  assert.equal(data.installs.length, 1);
  const [first] = data.installs;
  assert.equal(first.commit, 'f748e46');
  assert.equal(first.result, 'verified');
  assert.equal(first.current, true);
  assert.deepEqual(first.pull_requests, [{ number: 1425, title: CACHE.merged[0].title, issue: { number: 1424, title: CACHE.issues[0].title } }]);
});

test('the version part names main, commits behind, the latch with its reason and the process versions', async t => {
  const state = { main: { sha: sha('abcdef1'), from: NEW, behind: 3 } };
  const data = await serve(t, { records: REAL, state });
  assert.equal(data.main, sha('abcdef1'));
  assert.equal(data.commits_behind, 3);
  assert.equal(data.hold, null);
  assert.equal(data.mcp_version, null);
  assert.ok(Array.isArray(data.processes));
  const refused = await serve(t, { records: REAL, state: { refusal: { kind: 'pre-check', from: OLD, to: NEW, at: at(10, 0), reason: 'tests failed on the new commit' } } });
  assert.deepEqual(refused.hold, { kind: 'refusal', reason: 'tests failed on the new commit', at: '2026-11-14T10:00:00.000Z' });
});

test('an install with two pull requests lists both', async t => {
  const data = await serve(t, { records: install(OLD, NEW, [1425, 1426], at(9, 18), at(9, 20)), cache: CACHE });
  assert.deepEqual(data.installs[0].pull_requests.map(p => p.number), [1425, 1426]);
});

test('a pull request the cache does not know is listed by number with a null title and no issue', async t => {
  const data = await serve(t, { records: install(OLD, NEW, [1425, 1999], at(9, 18), at(9, 20)) });
  assert.deepEqual(data.installs[0].pull_requests[1], { number: 1999, title: null, issue: null });
});

test('an issue the cache does not know keeps its number with a null title', async t => {
  const data = await serve(t, { records: REAL, cache: { merged: CACHE.merged, issues: [] } });
  assert.deepEqual(data.installs[0].pull_requests[0].issue, { number: 1424, title: null });
});

test('installs are newest first, the first is current, and one older than 7 days is left out', async t => {
  const a = sha('aaaaaaa'), b = sha('bbbbbbb'), c = sha('ccccccc');
  const records = [...install(OLD, a, [1], NOW - 8 * DAY, NOW - 8 * DAY + 1000), ...install(a, b, [2], NOW - 2 * DAY, NOW - 2 * DAY + 1000), ...install(b, c, [3], NOW - DAY, null)];
  const data = await serve(t, { records });
  assert.deepEqual(data.installs.map(i => i.commit), ['ccccccc', 'bbbbbbb']);
  assert.deepEqual(data.installs.map(i => i.current), [true, false]);
  assert.equal(data.installs[0].result, 'upgraded');
});

test('exactly 100 installs are kept when more exist, the newest ones', async t => {
  const records = [];
  let from = OLD;
  for (let n = 1; n <= 130; n += 1) {
    const to = sha(n.toString(16).padStart(7, '0'));
    records.push(...install(from, to, [n], NOW - DAY + n * 60000, NOW - DAY + n * 60000 + 1000));
    from = to;
  }
  const data = await serve(t, { records });
  assert.equal(data.installs.length, 100);
  assert.equal(data.installs[0].pull_requests[0].number, 130);
  assert.equal(data.installs[99].pull_requests[0].number, 31);
});

test('a retry of the same commit is one version and a damaged line is skipped while the rest are served', async t => {
  const lines = [JSON.stringify({ at: at(9, 10), from: OLD, to: NEW, prs: [1425], result: 'upgraded' }), '{"at":', 'not json',
    ...install(OLD, NEW, [1425], at(9, 18), at(9, 20)).map(r => JSON.stringify(r)), JSON.stringify(restart(NEW, at(9, 21)))];
  const data = await serve(t, { rawLines: lines });
  assert.equal(data.installs.length, 1);
  assert.equal(data.installs[0].at, '2026-11-14T09:10:00.000Z');
  assert.equal(data.installs[0].result, 'verified');
});

test('with no install records the model returns the version part and an empty list, not an error', async t => {
  const data = await serve(t, { records: [] });
  assert.deepEqual(data.installs, []);
  assert.equal(data.installed, null);
  assert.equal(data.installed_at, null);
  assert.equal(data.hold, null);
});
