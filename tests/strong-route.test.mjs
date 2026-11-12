// Issue #1158: the strong tier through the dashboard's real POST /inbox route and page: the card shows the head and the number box, and the route
// refuses a wrong number, a moved head, a lowered tier and a bare approve, leaving the item pending; the right request is recorded with its head.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { removeLater } from './_tmp-leaks.mjs';
import * as inbox from '../supervisor/inbox.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';

const HEAD = 'ab'.repeat(20), OLD = 'cd'.repeat(20);
const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const MERGE = { kind: 'action', title: 'Merge PR 5', action: 'merge_pr', target: '5', reason: 'The homeowner wants it in.' };

async function serve(t, pulls) {
  const dir = tmp(t, 'strong-route-'), root = tmp(t, 'strong-root-');
  fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls, issues: [{ number: 10, title: 'T', state: 'OPEN', labels: [], body: '' }] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); })); removeLater(root);
  const port = server.address().port;
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } }, inbox: { dir } };
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); r.on('error', reject); r.end(body); });
  let at = 0;
  const post = fields => { at += 2000; return req('POST', '/inbox', { headers: { origin: `http://127.0.0.1:${port}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ proof: writeToken(root), ...fields }).toString() }); };
  return { dir, get: p => req('GET', p), post, sleep: () => new Promise(r => setTimeout(r, 1100)) };
}
const pull = head => ({ number: 5, title: 'PR five', headRefName: 'claude/issue-5-x', headRefOid: head, isDraft: false, mergeable: 'MERGEABLE', labels: [], statusCheckRollup: [] });
function dropItem(dir) { const id = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(MERGE)); inbox.scan(dir, Date.now() - 1000); return id; }

test('page: a strong card shows the full head and the number box; the dropdown row points to it and has no Approve form', async t => {
  const s = await serve(t, [pull(HEAD)]), id = dropItem(s.dir);
  const page = (await s.get('/')).body;
  assert.ok(page.includes(`<code>${HEAD}</code>`)); assert.match(page, /name="confirm"/); assert.match(page, /name="tier" value="strong"/);
  assert.match(page, /Type 5 to confirm/);
  const row = page.split('<li ').find(x => x.includes('data-tier="strong"')) || '';
  assert.ok(row && !/value="approve"/.test(row), 'no Approve form in the dropdown row'); assert.ok(row.includes(`#att-inbox-${id}`));
});
test('page: a strong card for a pull request that is not open offers no Approve', async t => {
  const s = await serve(t, []); dropItem(s.dir);
  const page = (await s.get('/')).body;
  assert.match(page, /cannot be read \(it may be closed\)/); assert.ok(!/class="inbox-form inbox-strong"/.test(page));
});
test('route: wrong number, moved head, lowered tier and a bare approve are refused and leave it pending; the right request records the head', async t => {
  const s = await serve(t, [pull(HEAD)]), id = dropItem(s.dir);
  const refused = async (fields, re) => { const r = await s.post({ id, decision: 'approve', ...fields }); const j = JSON.parse(r.body); assert.equal(j.ok, false); assert.match(j.reason, re); assert.equal(inbox.statusOf(s.dir, id).state, 'pending'); await s.sleep(); };
  await refused({}, /does not match pull request 5/);
  await refused({ confirm: '6', head: HEAD, tier: 'strong' }, /does not match pull request 5/);
  await refused({ confirm: '5', head: OLD, tier: 'strong' }, /new head since this card was shown/);
  await refused({ confirm: '5', head: HEAD, tier: 'click' }, /cannot be lowered/);
  const ok = await s.post({ id, decision: 'approve', confirm: '5', head: HEAD, tier: 'strong' });
  assert.equal(JSON.parse(ok.body).ok, true);
  const st = inbox.statusOf(s.dir, id);
  assert.equal(st.state, 'approved'); assert.equal(st.confirm.head, HEAD); assert.equal(st.confirm.typed, '5'); assert.equal(st.confirm.by, 'homeowner');
});
test('route: a head that moved in the dashboard\'s data after the card was shown is refused', async t => {
  const s = await serve(t, [pull(OLD)]), id = dropItem(s.dir);
  const r = JSON.parse((await s.post({ id, decision: 'approve', confirm: '5', head: HEAD, tier: 'strong' })).body);
  assert.equal(r.ok, false); assert.match(r.reason, /new head/); assert.equal(inbox.statusOf(s.dir, id).state, 'pending');
});
test('route: rejecting a strong item needs no number', async t => {
  const s = await serve(t, [pull(HEAD)]), id = dropItem(s.dir);
  assert.equal(JSON.parse((await s.post({ id, decision: 'reject' })).body).ok, true);
  assert.equal(inbox.statusOf(s.dir, id).state, 'rejected');
});
