// Issue #976: the Inbox's bulk actions on holds and Snooze. A real dashboard handler over a temp state root; the posts only leave requests or a snooze file.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken, readSnoozed } from '../supervisor/dashwrite.mjs';
import { takeHomeownerRequests } from '../supervisor/homeownerqueue.mjs';

const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'holds976-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const at = Date.now() - 60000;
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at, status: 'ok', lastOkAt: at }, fetchedAt: at, pulls: [], issues: [] }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ implemented: { 9: 1, 10: 1 } }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port, clock = { now: Date.now() };
  server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => clock.now, supervised: () => false }));
  const post = (p, body, { proof = writeToken(root) } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.end(`${body}&proof=${proof}`);
  });
  return { root, clock, post };
}

test('holds: a bulk action queues one request per marked issue; unmarked issues, bad decisions and a wrong proof change nothing', async t => {
  const s = await serve(t);
  assert.equal((await s.post('/holds', 'decision=reopen&issue=9&issue=10')).status, 303);
  const q = takeHomeownerRequests(s.root);
  assert.deepEqual(q.map(r => [r.command, r.args[0]]).sort(), [['reopen', '10'], ['reopen', '9']]);
  s.clock.now += 5000;
  assert.equal((await s.post('/holds', 'decision=close&issue=77')).status, 400, 'an issue that is not marked');
  assert.equal((await s.post('/holds', 'decision=delete&issue=9')).status, 400);
  assert.equal((await s.post('/holds', 'decision=keep&issue=9', { proof: 'f'.repeat(64) })).status, 403);
  assert.deepEqual(takeHomeownerRequests(s.root).filter(r => !q.some(x => x.file === r.file)), []);
});

test('snooze: a fixed time hides the item and then expires; other lengths and ids are refused', async t => {
  const s = await serve(t), t0 = s.clock.now;
  assert.equal((await s.post('/snooze', 'id=inbox-holds&hours=24')).status, 303);
  assert.ok(readSnoozed(s.root, t0)['inbox-holds'] > t0);
  assert.equal(readSnoozed(s.root, t0 + 25 * 3600000)['inbox-holds'], undefined);
  s.clock.now += 5000;
  assert.equal((await s.post('/snooze', 'id=x&hours=5')).status, 400);
  assert.equal((await s.post('/snooze', 'id=a%20b&hours=1')).status, 400);
});
