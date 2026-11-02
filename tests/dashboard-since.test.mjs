// Issue #253: "Since you were last here" panel. Counts and items for a fixed log, Mark as read, the range picker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { rangeStart, sinceView } from '../supervisor/since.mjs';
import { makeNamer } from '../supervisor/naming.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { readLastSeen } from '../supervisor/dashdata.mjs';

const NOW = Date.UTC(2026, 10, 2, 15, 0, 0);          // 2 Nov 15:00 UTC
const H = h => NOW - h * 3600000;
const names = () => makeNamer({ repo: 'o/r', issues: [{ number: 10, title: 'Ten' }, { number: 11, title: 'Eleven' }], pulls: [{ number: 100, title: 'PR hundred' }, { number: 101, title: 'PR hundred-one' }], merged: [], mergeLog: [], stateJobs: {}, titles: {} });
const job = (c, over) => ({ id: c.repeat(32), provider: 'claude', kind: 'implement', issue: 10, status: 'completed', createdAt: H(30), updatedAt: H(2), usage: { inputTokens: 1000, outputTokens: 500 }, ...over });
const jobs = [
  job('a'),                                                                                         // implemented #10 two hours ago
  job('b', { kind: 'review', issue: 100, updatedAt: H(5), usage: { inputTokens: 200, outputTokens: 100 } }),
  job('c', { status: 'failed', issue: 11, updatedAt: H(1), usage: { inputTokens: 10, outputTokens: 5 }, lastEvent: 'retry_exhausted' }),
  job('d', { status: 'blocked', kind: 'fix', issue: 101, updatedAt: H(40), usage: { inputTokens: 7, outputTokens: 3 } }),   // old
  job('e', { updatedAt: H(3), usage: undefined })                                                  // no usage recorded
];
const state = {
  jobs: { ['a'.repeat(32)]: { kind: 'implement', issue: 10, pr: 100 }, ['e'.repeat(32)]: { kind: 'implement', issue: 11 } },
  mergeLog: [{ pr: 100, issue: 10, mergedAt: H(4) }, { pr: 101, issue: 11, mergedAt: H(26) }],
  verdicts: { [`100:${'1'.repeat(40)}`]: { verdict: 'CHANGES', at: H(6), reviewer: 'codex' }, [`100:${'2'.repeat(40)}`]: { verdict: 'PASS', at: H(5), reviewer: 'codex' }, [`101:${'3'.repeat(40)}`]: { verdict: 'PASS', at: H(50), reviewer: 'codex' } }
};
const ctx = { jobs, state, names: names(), describe: j => `desc ${j.id.slice(0, 1)}`, needsYou: [{ text: 'Answer #12' }], now: NOW };

test('range starts: visit uses the marker, 24h and today are fixed, no marker falls back to 24h', () => {
  assert.equal(rangeStart('visit', { lastSeen: H(7), now: NOW }), H(7));
  assert.equal(rangeStart('visit', { lastSeen: null, now: NOW }), NOW - 86400000);
  assert.equal(rangeStart('24h', { lastSeen: H(7), now: NOW }), NOW - 86400000);
  assert.equal(rangeStart('today', { lastSeen: H(7), now: NOW }), Date.UTC(2026, 10, 2));
});

test('fixed log, since 8 h ago: counts and items are number + title', () => {
  const v = sinceView(ctx, H(8)), r = v.ranges.visit;
  assert.deepEqual(r.counts, { merged: 1, opened: 1, reviews: 2, issuesDone: 1, failed: 1, needsYou: 1 });
  assert.equal(r.merged[0].text, 'PR #100 PR hundred');
  assert.deepEqual(r.opened.map(i => i.text), ['PR #100 PR hundred']);   // the implement job without a PR is not counted
  assert.deepEqual(r.reviews.map(i => i.verdict), ['PASS', 'CHANGES']);                  // newest first
  assert.equal(r.issuesDone[0].text, '#10 Ten');
  assert.equal(r.failed[0].text, 'Failed: desc c');
  assert.equal(r.tokens, 1500 + 300 + 15);                                               // jobs a, b, c only
  assert.equal(v.ranges.visit.fallback, false);
  assert.match(r.text, /PRs merged: 1\n- PR #100 PR hundred/);
  assert.match(r.text, /Tokens used: 1,815/);
});

test('wider window includes older work; empty window and no usage show zero and unknown', () => {
  const wide = sinceView(ctx, H(60)).ranges.visit;
  assert.equal(wide.counts.merged, 2); assert.equal(wide.counts.failed, 2); assert.equal(wide.counts.reviews, 3);
  assert.match(wide.failed.map(f => f.text).join('|'), /Blocked: desc d/);
  const none = sinceView({ ...ctx, jobs: [], state: {}, needsYou: [] }, H(8)).ranges.visit;
  assert.equal(none.tokens, null); assert.ok(Object.values(none.counts).every(n => n === 0));
  assert.match(none.text, /Tokens used: unknown/);
});

test('range picker: 24h and today differ from the visit window', () => {
  const v = sinceView(ctx, H(8)).ranges;
  assert.equal(v['24h'].counts.merged, 1); assert.equal(v['24h'].from, NOW - 86400000);
  assert.equal(v.today.from, Date.UTC(2026, 10, 2)); assert.equal(v.today.counts.merged, 1);
  assert.equal(sinceView(ctx, H(30)).ranges.visit.counts.merged, 2);
  assert.equal(sinceView(ctx, null).ranges.visit.fallback, true);
});

// ---- the real handler: the page, the picker and Mark as read
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [11] } } };
async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash253-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [{ pr: 100, issue: 10, mergedAt: H(4) }, { pr: 101, issue: 11, mergedAt: H(26) }] }));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => NOW }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject);
    r.end(body);
  });
  const post = (at, headers = {}) => req('POST', '/mark-read', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: `at=${at}` });
  return { root, port, get: p => req('GET', p), req, post };
}

test('page shows the panel with a copy button, a picker and Mark as read; page load does not move the marker', async t => {
  const s = await serve(t), body = (await s.get('/')).body;
  assert.match(body, /Since you were last here \(never marked as read\)/);
  assert.match(body, /data-copy="[^"]*PRs merged: 1/);
  assert.match(body, /<form method="post" action="\/mark-read"/);
  assert.match(body, /Last 24 h/); assert.match(body, /href="\/\?since=today"/);
  await s.get('/'); await s.get('/?since=today');
  assert.equal(readLastSeen(s.root), null);
});

test('range picker through the URL changes the window; an unknown value falls back to the default', async t => {
  const s = await serve(t);
  assert.match((await s.get('/?since=today')).body, /Showing today, from 2026-11-02 00:00 UTC/);
  assert.match((await s.get('/?since=nonsense')).body, /Showing since last visit/);
});

test('Mark as read moves the marker to the page time and the next view uses it', async t => {
  const s = await serve(t);
  const r = await s.post(H(2));
  assert.equal(r.status, 303); assert.equal(r.headers.location, '/');
  assert.equal(readLastSeen(s.root), H(2));
  const body = (await s.get('/')).body;
  assert.match(body, /Since you were last here \(2026-11-02 13:00 UTC\)/);
  assert.match(body, /PRs merged <span class="muted">\(0\)/);          // the merge 4 h ago is now before the marker
  assert.equal((await s.post(H(9))).status, 303); assert.equal(readLastSeen(s.root), H(2), 'never moves backwards');
});

test('Mark as read refuses a cross-origin or missing Origin, a future or malformed time, and other methods stay refused', async t => {
  const s = await serve(t);
  assert.equal((await s.post(H(1), { origin: 'http://evil.example' })).status, 403);
  assert.equal((await s.req('POST', '/mark-read', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `at=${H(1)}` })).status, 403);
  assert.equal((await s.post(NOW + 60000)).status, 400);
  assert.equal((await s.post('abc')).status, 400);
  assert.equal((await s.post(H(1), { host: 'evil.example' })).status, 421);
  assert.equal((await s.req('POST', '/')).status, 405);
  assert.equal((await s.req('PUT', '/mark-read')).status, 405);
  assert.equal((await s.get('/mark-read')).status, 404);
  assert.equal(readLastSeen(s.root), null);
});

test('responses keep the origin on same-origin POSTs so Mark as read works in a real browser (referrer-policy is not no-referrer)', async t => {
  const s = await serve(t);
  const r = await s.get('/');
  const policy = r.headers['referrer-policy'];
  assert.equal(policy, 'same-origin', 'no-referrer makes browsers send Origin: null on form POSTs, which markRead refuses');
});
