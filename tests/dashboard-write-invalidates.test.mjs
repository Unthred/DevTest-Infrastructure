// Issue #467, review finding: a dashboard write (Mark as read, Watch, the allowance probe) must not be followed by a redirect page answered from the
// copy built before the write and marked current. These tests go through the real handler with the same reuse window the server uses (3 s), so the
// prepared copy really is served between requests.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { handler, DASHBOARD_VIEW_TTL_MS } from '../supervisor/dashserver.mjs';
import { readLastSeen } from '../supervisor/dashdata.mjs';

const NOW = Date.UTC(2026, 10, 2, 15, 0, 0);
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [11] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };

async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash467w-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }] }));
  const clock = { now: NOW };
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => { server.closeAllConnections?.(); server.close(); });
  const port = server.address().port;
  server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => clock.now, viewTtlMs: DASHBOARD_VIEW_TTL_MS }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); });
    r.on('error', reject); r.end(body);
  });
  const form = (p, body, extra = {}) => req('POST', p, { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: `${body}&proof=${writeToken(root)}` });
  return { clock, root, port, req, get: p => req('GET', p), markRead: at => form('/mark-read', `at=${at}`), watch: body => form('/watch', body) };
}

test('Mark as read: the page after the redirect shows the write, not the copy built before it, even inside the reuse window', async t => {
  const s = await serve(t);
  const before = (await s.get('/')).body;
  assert.match(before, /Last marked as read: never marked as read/);
  const r = await s.markRead(NOW - 3600000);
  assert.equal(r.status, 303); assert.equal(r.headers.location, '/');
  assert.equal(readLastSeen(s.root), NOW - 3600000);
  const after = (await s.get(r.headers.location)).body;   // well inside the 3 s reuse window: without the fix this is the old copy
  assert.match(after, /Last marked as read: <time[^>]*data-local>/, 'the redirect page shows the marker that was just written');
  assert.doesNotMatch(after, /never marked as read/);
});

test('Mark as read: the second click lands on the cooldown notice only because the user clicked twice, and the page already shows the first write', async t => {
  const s = await serve(t);
  await s.get('/');
  const first = await s.markRead(NOW - 7200000);
  assert.equal(first.headers.location, '/');
  const page = (await s.get('/')).body;
  assert.match(page, /Last marked as read: <time/, 'a stale display would invite the second click');
  const second = await s.markRead(NOW - 3600000);   // inside the 5 s shared cooldown: nothing moves, the notice is shown
  assert.equal(second.status, 303); assert.equal(second.headers.location, '/?notice=mark-read-cooldown');
  assert.equal(readLastSeen(s.root), NOW - 7200000, 'the second click did not move the marker');
  const noticePage = (await s.get(second.headers.location)).body;
  assert.match(noticePage, /Last marked as read: <time/); assert.match(noticePage, /ignored|too soon|cooldown/i);
});

test('Watch: the view read right after the redirect lists the change that was just followed', async t => {
  const s = await serve(t);
  const before = JSON.parse((await s.get('/api/view.json')).body);
  assert.equal((before.watching || []).length, 0);
  const r = await s.watch('kind=issue&number=10&action=watch&back=/');
  assert.equal(r.status, 303);
  const after = JSON.parse((await s.get('/api/view.json')).body);
  assert.equal((after.watching || []).length, 1, 'the write is visible at once');
  assert.ok(after.pageData.ageMs < 2500, `the view was rebuilt after the write (page data ${after.pageData.ageMs} ms old)`);
});

test('a refused write (wrong proof, foreign origin) invalidates nothing: the prepared copy keeps serving', async t => {
  const s = await serve(t);
  const built = async () => JSON.parse((await s.get('/api/view.json')).body).pageData.builtAt;
  const first = await built();
  const wrongProof = await s.req('POST', '/watch', { headers: { origin: `http://127.0.0.1:${s.port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: 'kind=issue&number=10&action=watch&proof=' + 'f'.repeat(64) });
  assert.equal(wrongProof.status, 403);
  const foreign = await s.req('POST', '/mark-read', { headers: { origin: 'http://example.invalid', 'content-type': 'application/x-www-form-urlencoded' }, body: 'at=' + (NOW - 1000) });
  assert.equal(foreign.status, 403);
  assert.equal(await built(), first, 'the copy was not rebuilt by refused writes');
});
