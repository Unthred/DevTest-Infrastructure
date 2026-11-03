// Issue #430: watch a change from start to installed. Store, steps, tick advance and alerts, and the POST /watch write.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { applyAction, readWatchlist, advanceWatchlist, describeWatch, factsFromCache, resolve, CLEAR_AFTER_INSTALL_MS } from '../supervisor/watchlist.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { githubClient } from '../supervisor/github.mjs';

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);
const H1 = 'a'.repeat(40), H2 = 'b'.repeat(40), MERGE = 'c'.repeat(40), OLD = 'd'.repeat(40);
const tmp = t => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'watch430-')); t.after(() => fs.rmSync(r, { recursive: true, force: true })); for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(r, d)); return r; };
const green = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }];
const pull = (over = {}) => ({ number: 12, title: 'T', headRefName: 'claude/issue-10-x', headRefOid: H1, isDraft: false, labels: [], statusCheckRollup: green, ...over });
const checksOf = p => ((p.statusCheckRollup || []).every(c => c.conclusion === 'SUCCESS') ? 'green' : 'pending');
const run = (root, o) => { const alerts = []; return advanceWatchlist({ root, now: NOW, checksOf, alert: async x => { alerts.push(x); }, factsFor: factsFromCache({ cache: o.cache, state: o.state || {}, now: NOW, checksOf }), ...o }).then(r => ({ ...r, alerts })); };

test('watching an issue keeps the watch when it becomes a PR, and when the PR gets a new head', () => {
  const issueOnly = resolve({ kind: 'issue', number: 10 }, { pulls: [] });
  assert.deepEqual(issueOnly, { pr: null, issue: 10 });
  const withPr = resolve({ kind: 'issue', number: 10, pr: null }, { pulls: [pull()] });
  assert.deepEqual(withPr, { pr: 12, issue: 10 });
  const newHead = resolve({ kind: 'issue', number: 10, pr: 12 }, { pulls: [pull({ headRefOid: H2 })] });
  assert.deepEqual(newHead, { pr: 12, issue: 10 });
  assert.deepEqual(resolve({ kind: 'issue', number: 10, pr: 12 }, { pulls: [pull({ number: 15 })] }), { pr: 15, issue: 10 }, 'a replacement PR for the same issue is followed');
  assert.deepEqual(resolve({ kind: 'pr', number: 12 }, { pulls: [pull()] }), { pr: 12, issue: 10 });
});

test('the tick keeps one item through issue -> PR -> new head and the sentence names the current head', async t => {
  const root = tmp(t); applyAction(root, { kind: 'issue', number: 10, action: 'watch', now: NOW - 1000 });
  await run(root, { cache: { pulls: [], issues: [{ number: 10, state: 'OPEN', labels: [] }], merged: [] } });
  let it = readWatchlist(root).items; assert.equal(it.length, 1); assert.equal(it[0].pr, null);
  await run(root, { cache: { pulls: [pull()], issues: [], merged: [] } });
  it = readWatchlist(root).items; assert.equal(it.length, 1); assert.equal(it[0].pr, 12);
  await run(root, { cache: { pulls: [pull({ headRefOid: H2 })], issues: [], merged: [] } });
  it = readWatchlist(root).items; assert.equal(it.length, 1); assert.equal(it[0].issue, 10);
  const d = describeWatch(it[0], factsFromCache({ cache: { pulls: [pull({ headRefOid: H2 })] }, state: {}, now: NOW, checksOf })(it[0], { pr: 12, issue: 10 }), NOW);
  assert.match(d.sentence, /^Stuck at Review for .*head bbbbbbb, no review of this head yet\.$/);
  assert.deepEqual(d.steps.map(s => s.label), ['Implement', 'CI', 'Review', 'Fix', 'Merged', 'Installed', 'Verified']);
});

test('the install step reads the installed version: not installed until it contains the merge commit', async t => {
  const root = tmp(t); applyAction(root, { kind: 'pr', number: 12, action: 'watch', now: NOW - 1000 });
  const cache = { pulls: [], merged: [{ number: 12, issue: 10, mergedAt: new Date(NOW - 60000).toISOString(), mergeSha: MERGE }] };
  const before = await run(root, { cache, installed: OLD, isAncestor: (a, b) => a === MERGE && b === H1 });
  assert.equal(readWatchlist(root).items[0].installedAt, undefined); assert.deepEqual(before.alerts, []);
  const f = factsFromCache({ cache, state: {}, now: NOW, checksOf })(readWatchlist(root).items[0], { pr: 12, issue: 10 });
  assert.equal(describeWatch(readWatchlist(root).items[0], f, NOW).steps.find(s => s.key === 'installed').status, 'active');
  const after = await run(root, { cache, installed: H1, running: H1, isAncestor: (a, b) => a === MERGE && b === H1 });
  const item = readWatchlist(root).items[0];
  assert.equal(item.installedAt, NOW); assert.equal(item.installedSha, H1); assert.equal(item.verifiedAt, NOW);
  assert.equal(after.alerts.length, 1); assert.match(after.alerts[0], /merged and installed/);
});

test('alerts: one on merged-and-installed, none again; none for ordinary progress; a failed delivery is retried', async t => {
  const root = tmp(t); applyAction(root, { kind: 'pr', number: 12, action: 'watch', now: NOW - 1000 });
  const open = { pulls: [pull()], merged: [] };
  assert.deepEqual((await run(root, { cache: open })).alerts, [], 'progress alone is silent');
  const merged = { pulls: [], merged: [{ number: 12, issue: 10, mergedAt: new Date(NOW).toISOString(), mergeSha: MERGE }] };
  assert.deepEqual((await run(root, { cache: merged, installed: OLD })).alerts, [], 'merged but not installed is silent');
  let calls = 0;
  const flaky = await advanceWatchlist({ root, cache: merged, state: {}, now: NOW, installed: H1, isAncestor: () => true, alert: async () => { calls++; throw new Error('down'); }, factsFor: factsFromCache({ cache: merged, now: NOW, checksOf }) });
  assert.equal(calls, 1); assert.deepEqual(flaky.sent, []); assert.equal(readWatchlist(root).items[0].alerts.done, undefined);
  assert.equal((await run(root, { cache: merged, installed: H1, isAncestor: () => true })).alerts.length, 1, 'retried and delivered');
  assert.deepEqual((await run(root, { cache: merged, installed: H1, isAncestor: () => true })).alerts, [], 'never twice');
});

test('alerts: one when the change needs the homeowner, not again, and again only for a new stop', async t => {
  const root = tmp(t); applyAction(root, { kind: 'pr', number: 12, action: 'watch', now: NOW - 1000 });
  const stopped = { pulls: [pull({ labels: ['needs-homeowner'] })], merged: [] };
  const a = await run(root, { cache: stopped }); assert.equal(a.alerts.length, 1); assert.match(a.alerts[0], /^Needs the homeowner:/);
  assert.deepEqual((await run(root, { cache: stopped })).alerts, []);
  assert.deepEqual((await run(root, { cache: { pulls: [pull()], merged: [] } })).alerts, [], 'cleared');
  assert.equal((await run(root, { cache: stopped })).alerts.length, 1, 'a second, separate stop alerts again');
});

test('an installed item clears after the grace period unless pinned', async t => {
  const root = tmp(t);
  for (const n of [12, 13]) applyAction(root, { kind: 'pr', number: n, action: 'watch', now: NOW - 1000 });
  applyAction(root, { kind: 'pr', number: 13, action: 'pin', now: NOW });
  const merged = { pulls: [], merged: [12, 13].map(n => ({ number: n, mergedAt: new Date(NOW).toISOString(), mergeSha: MERGE })) };
  await run(root, { cache: merged, installed: H1, isAncestor: () => true });
  assert.equal(readWatchlist(root).items.length, 2, 'still shown right after the install');
  const later = NOW + CLEAR_AFTER_INSTALL_MS + 1;
  await advanceWatchlist({ root, cache: merged, state: {}, now: later, installed: H1, isAncestor: () => true, alert: async () => {}, factsFor: factsFromCache({ cache: merged, now: later, checksOf }) });
  assert.deepEqual(readWatchlist(root).items.map(i => i.number), [13]);
});

test('applyAction: watch is idempotent, unwatch and pin work, bad input is refused', t => {
  const root = tmp(t);
  assert.ok(applyAction(root, { kind: 'issue', number: 5, action: 'watch', now: 1 }).ok); applyAction(root, { kind: 'issue', number: 5, action: 'watch', now: 2 });
  assert.equal(readWatchlist(root).items.length, 1);
  applyAction(root, { kind: 'issue', number: 5, action: 'pin', now: 3 }); assert.equal(readWatchlist(root).items[0].pinned, true);
  applyAction(root, { kind: 'issue', number: 5, action: 'unwatch', now: 4 }); assert.equal(readWatchlist(root).items.length, 0);
  for (const bad of [{ kind: 'job', number: 5, action: 'watch' }, { kind: 'pr', number: -1, action: 'watch' }, { kind: 'pr', number: 5, action: 'start' }]) assert.equal(applyAction(root, { ...bad, now: 1 }).ok, false);
});

// ---- the real handler
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [11] } } };
async function serve(t) {
  const root = tmp(t);
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [pull()], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }, { number: 11, title: 'Eleven', state: 'OPEN', labels: [] }], merged: [] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => NOW }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }); r.on('error', reject); r.end(body);
  });
  const post = (body, headers = {}) => req('POST', '/watch', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  return { root, port, get: p => req('GET', p), req, post };
}
const snapshot = root => ['jobs', 'team'].map(d => JSON.stringify(fs.readdirSync(path.join(root, d)).sort().map(f => [f, fs.readFileSync(path.join(root, d, f), 'utf8')])));

test('POST /watch adds the item, shows the Watching card on Overview, and changes nothing else', async t => {
  const s = await serve(t), before = snapshot(s.root);
  assert.match((await s.get('/')).body, /Nothing watched/);
  const r = await s.post('kind=issue&number=10&action=watch&back=/work');
  assert.equal(r.status, 303); assert.equal(r.headers.location, '/work');
  assert.deepEqual(snapshot(s.root), before, 'no job, lease or team state was touched');
  const body = (await s.get('/')).body;
  assert.match(body, /id="c-watching"/); assert.match(body, /data-watch="i10"/);
  for (const label of ['Implement', 'CI', 'Review', 'Fix', 'Merged', 'Installed', 'Verified']) assert.match(body, new RegExp(`<span class="wlabel">${label}</span>`));
  assert.match(body, /Stuck at Review for .*head aaaaaaa/);
  assert.ok(body.indexOf('id="c-watching"') < body.indexOf('id="c-since"'), 'Watching is the top card');
  assert.match((await s.get('/work')).body, /action="\/watch"/, 'Work shows a Watch button');
  assert.match((await s.get('/work/pr/12')).body, /name="kind" value="pr"/);
  assert.equal((await s.post('kind=issue&number=10&action=unwatch')).status, 303);
  assert.equal(readWatchlist(s.root).items.length, 0);
});

test('POST /watch refuses another origin, a wrong host, bad input, unknown targets and other methods', async t => {
  const s = await serve(t);
  const form = 'kind=issue&number=10&action=watch';
  assert.equal((await s.req('POST', '/watch', { headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form })).status, 403, 'no Origin');
  assert.equal((await s.post(form, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await s.post(form, { origin: 'null' })).status, 403);
  assert.equal((await s.post(form, { host: 'evil.example' })).status, 421);
  assert.equal((await s.post('kind=job&number=10&action=watch')).status, 400);
  assert.equal((await s.post('kind=issue&number=abc&action=watch')).status, 400);
  assert.equal((await s.post('kind=issue&number=10&action=start')).status, 400);
  assert.equal((await s.post('kind=issue&number=999&action=watch')).status, 404);
  assert.equal((await s.post(`kind=issue&number=10&action=watch&pad=${'x'.repeat(2000)}`)).status, 413);
  assert.equal((await s.post(form + '&back=//evil.example')).headers.location, '/', 'an off-site back target is ignored');
  assert.equal((await s.req('PUT', '/watch')).status, 405); assert.equal((await s.get('/watch')).status, 404);
  assert.equal(readWatchlist(s.root).items.length, 1, 'only the one valid request wrote');
});

test('an issue is followed to an open PR whose branch name has no issue number, via closingIssuesReferences', async () => {
  const odd = pull({ number: 40, headRefName: 'feature/watch-thing', closingIssuesReferences: [{ number: 10 }] });
  assert.deepEqual(resolve({ kind: 'issue', number: 10, pr: null }, { pulls: [odd] }), { pr: 40, issue: 10 });
  let fields = '';
  const gh = args => { fields = args[args.indexOf('--json') + 1]; return JSON.stringify([odd]); };
  const pulls = await githubClient({ repository: 'o/r' }, gh).listPulls();
  assert.ok(fields.split(',').includes('closingIssuesReferences'), 'listPulls asks GitHub for the closing issues');
  assert.deepEqual(resolve({ kind: 'issue', number: 10, pr: null }, { pulls }), { pr: 40, issue: 10 });
});
