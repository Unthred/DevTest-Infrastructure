// Dashboard v2 (issue #54): sorting, pagination, footers, filters, severity, idle-reason text, routes, layout, static files.
// Pure logic is tested directly (it is the same module the browser runs); pages are tested through the real request handler.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SEVERITIES, applyLayout, breakpointOf, compareValues, filterRows, footer, inRange, moveItem, paginate, severityOf, sortRows, tableState, worst } from '../supervisor/dashui/logic.mjs';
import { healthOf, freshness } from '../supervisor/dashboard.mjs';
import { matchRoute, table } from '../supervisor/dashrender.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { compactIssues, readVersion } from '../supervisor/dashdata.mjs';

const NOW = Date.UTC(2026, 9, 30, 13, 0, 0);
const H = n => String(n).repeat(40).slice(0, 40);

// ---- severity mapping
test('severity: every attention id maps to one of the four levels, and the level carries a label and an icon', () => {
  assert.deepEqual(Object.keys(SEVERITIES), ['action', 'warning', 'info', 'ok']);
  for (const s of Object.values(SEVERITIES)) { assert.ok(s.label && s.icon); }
  assert.deepEqual(['Action needed', 'Warning', 'Info', 'OK'], Object.values(SEVERITIES).map(s => s.label));
  for (const id of ['homeowner-5', 'tick-failed', 'job-abc']) assert.equal(severityOf(id), 'action', id);
  for (const id of ['ci-9', 'tick-stale', 'no-tick', 'idle-claude', 'pause-codex', 'drift']) assert.equal(severityOf(id), 'warning', id);
  assert.equal(severityOf('something-new'), 'info');
  assert.equal(severityOf(undefined), 'info');
  assert.equal(worst(['ok', 'warning', 'info']), 'warning'); assert.equal(worst(['ok', 'action', 'warning']), 'action'); assert.equal(worst([]), 'ok');
});
test('health: needs-you beats stuck beats paused beats running beats idle', () => {
  const st = (...s) => Object.fromEntries(s.map((x, i) => [`a${i}`, { state: x }]));
  const att = (...ids) => ids.map(id => ({ id, severity: severityOf(id) }));
  assert.equal(healthOf({ attention: att('homeowner-1', 'tick-stale'), states: st('running'), teamEnabled: true }).state, 'needs_you');
  assert.equal(healthOf({ attention: att('tick-stale'), states: st('running'), teamEnabled: true }).state, 'stuck');
  assert.equal(healthOf({ attention: att('idle-claude'), states: st('idle'), teamEnabled: true }).state, 'stuck');
  assert.equal(healthOf({ attention: att('ci-4'), states: st('paused', 'running'), teamEnabled: true }).state, 'paused');
  assert.equal(healthOf({ attention: [], states: st('running', 'idle'), teamEnabled: true }).state, 'running');
  assert.deepEqual(healthOf({ attention: [], states: st('idle'), teamEnabled: true }), { state: 'idle', label: 'Idle', severity: 'ok' });
  assert.equal(healthOf({ attention: [], states: st('idle'), teamEnabled: false }).severity, 'info');
});
test('freshness: fresh within ten minutes, amber then red as the data ages, red when there is none', () => {
  assert.equal(freshness(NOW - 60000, NOW).level, 'ok');
  assert.equal(freshness(NOW - 11 * 60000, NOW).level, 'warning');
  assert.equal(freshness(NOW - 31 * 60000, NOW).level, 'action');
  assert.equal(freshness(null, NOW).level, 'action'); assert.equal(freshness(undefined, NOW).label, 'No data');
});

// ---- sorting
const rows = [{ n: 'b', v: 10 }, { n: 'a', v: 2 }, { n: 'c', v: null }, { n: 'a10', v: 30 }, { n: 'a9', v: 5 }];
test('sorting: numbers numerically, text naturally, missing values last in both directions, stable, input untouched', () => {
  assert.deepEqual(sortRows(rows, 'v', 'asc').map(r => r.n), ['a', 'a9', 'b', 'a10', 'c']);
  assert.deepEqual(sortRows(rows, 'v', 'desc').map(r => r.n), ['a10', 'b', 'a9', 'a', 'c']);
  assert.deepEqual(sortRows(rows, 'n', 'asc').map(r => r.n), ['a', 'a9', 'a10', 'b', 'c']);
  assert.deepEqual(rows.map(r => r.n), ['b', 'a', 'c', 'a10', 'a9']);
  const ties = [{ k: 1, i: 'x' }, { k: 1, i: 'y' }, { k: 0, i: 'z' }];
  assert.deepEqual(sortRows(ties, 'k', 'asc').map(r => r.i), ['z', 'x', 'y']);
  assert.deepEqual(sortRows(ties, 'k', 'desc').map(r => r.i), ['x', 'y', 'z']);
  assert.deepEqual(sortRows(rows, null).map(r => r.n), rows.map(r => r.n));
  assert.equal(compareValues(NaN, 1), 1); assert.equal(compareValues(undefined, undefined), 0);
});
// ---- pagination
test('pagination: 25 by default, size selector, clamps bad pages and unknown sizes', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ i }));
  const p1 = paginate(many); assert.equal(p1.pageSize, 25); assert.equal(p1.pages, 3); assert.equal(p1.rows.length, 25); assert.deepEqual([p1.from, p1.to, p1.total], [1, 25, 60]);
  const p3 = paginate(many, 3); assert.equal(p3.rows.length, 10); assert.deepEqual([p3.from, p3.to], [51, 60]);
  assert.equal(paginate(many, 99).page, 3); assert.equal(paginate(many, -4).page, 1); assert.equal(paginate(many, 'x').page, 1); assert.equal(paginate(many, 1.9).page, 1);
  assert.equal(paginate(many, 1, 10).pages, 6); assert.equal(paginate(many, 1, 50).pages, 2);
  assert.equal(paginate(many, 1, 7).pageSize, 25, 'a size that is not offered falls back to the default');
  const none = paginate([]); assert.deepEqual([none.page, none.pages, none.from, none.to, none.total], [1, 1, 0, 0, 0]);
});
// ---- footer totals
test('footer: sums, averages and counts cover every filtered row, not only the visible page; unknowns are skipped, not zero', () => {
  const data = Array.from({ length: 40 }, (_, i) => ({ id: `j${i}`, tokens: i % 4 === 0 ? null : 100, rounds: 2 }));
  const st = tableState(data, { pageSize: 10, totals: { id: 'count', tokens: 'sum', rounds: 'avg' } });
  assert.equal(st.rows.length, 10); assert.equal(st.footer.id, 40); assert.equal(st.footer.tokens, 30 * 100); assert.equal(st.footer.rounds, 2);
  const f = tableState(data, { q: 'j1', searchKeys: ['id'], totals: { id: 'count', tokens: 'sum' } });
  assert.equal(f.footer.id, 11, 'j1 and j10..j19');
  assert.deepEqual(footer([{ a: null }], { a: 'sum' }), { a: null }); assert.deepEqual(footer([], { a: 'avg' }), { a: null });
  assert.equal(footer([{ a: 1 }, { a: 2 }, { a: 6 }], { a: 'avg' }).a, 3);
});
test('filter: case-insensitive over the listed keys only', () => {
  const d = [{ t: 'Fix CI', s: 'open' }, { t: 'Docs', s: 'fix later' }];
  assert.equal(filterRows(d, 'FIX', ['t']).length, 1); assert.equal(filterRows(d, 'fix', ['t', 's']).length, 2); assert.equal(filterRows(d, '  ', ['t']).length, 2); assert.equal(filterRows(d, 'zzz', ['t']).length, 0);
});
// ---- time range
test('time range: 24h, 7d, 30d; future points and unknown ranges are handled', () => {
  assert.equal(inRange(NOW - 23 * 3600000, NOW, '24h'), true); assert.equal(inRange(NOW - 25 * 3600000, NOW, '24h'), false);
  assert.equal(inRange(NOW - 6 * 86400000, NOW, '7d'), true); assert.equal(inRange(NOW - 8 * 86400000, NOW, '7d'), false); assert.equal(inRange(NOW - 29 * 86400000, NOW, '30d'), true);
  assert.equal(inRange(NOW - 8 * 86400000, NOW, 'bogus'), false, 'unknown range uses the 7d default');
  assert.equal(inRange(NOW + 3600000, NOW, '7d'), false); assert.equal(inRange(NaN, NOW, '7d'), false);
});
// ---- layout per breakpoint
test('layout: saved per breakpoint, phone is reorder-only, stale ids dropped and new cards appended', () => {
  assert.equal(breakpointOf(390), 'phone'); assert.equal(breakpointOf(768), 'tablet'); assert.equal(breakpointOf(1280), 'desktop');
  const ids = ['now', 'next', 'needs'];
  const saved = { order: ['needs', 'gone', 'now'], span: { now: 8, next: 99, gone: 3, needs: 1.5 } };
  assert.deepEqual(applyLayout(ids, saved, 'desktop'), { order: ['needs', 'now', 'next'], span: { now: 8 }, h: {}, collapsed: [] });
  assert.deepEqual(applyLayout(ids, saved, 'phone'), { order: ['needs', 'now', 'next'], span: {}, h: {}, collapsed: [] });
  assert.deepEqual(applyLayout(ids, null, 'desktop'), { order: ids, span: {}, h: {}, collapsed: [] }); assert.deepEqual(applyLayout(ids, { order: 'x', span: 3 }, 'desktop'), { order: ids, span: {}, h: {}, collapsed: [] });
  assert.deepEqual(moveItem(ids, 'next', -1), ['next', 'now', 'needs']); assert.deepEqual(moveItem(ids, 'now', -1), ids); assert.deepEqual(moveItem(ids, 'needs', 1), ids); assert.deepEqual(moveItem(ids, 'nope', 1), ids);
});
test('the browser script keys the saved layout by breakpoint and never reads or sends anything over the network', () => {
  const js = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
  assert.match(js, /dash\.layout\.\$\{page\}\.\$\{bpNow\(\)\}/);
  assert.doesNotMatch(js, /XMLHttpRequest|WebSocket|sendBeacon|eval\(|new Function|innerHTML|document\.write|import\(/);
  // Issue #61: the one network use is a same-origin GET of the page's own address to update a table in place; nothing is sent.
  assert.equal((js.match(/fetch\(/g) || []).length, 2, 'exactly two fetches: the table update and the app bar Next stat refresh (both same-origin GETs)');
  assert.match(js, /url = location\.pathname \+ \(qs/); assert.match(js, /fetch\(url, \{ headers: \{ accept: 'text\/html' \}, credentials: 'same-origin' \}\)/);
  assert.doesNotMatch(js, /method:\s*['"](?!GET)|body:\s/, 'no request carries a body');
});

// ---- rendered tables
const T = (over = {}) => table({ id: 't', path: '/x', query: new URLSearchParams(over.query || ''), noun: 'things', rows: over.rows || rows, searchKeys: ['n'], totals: { n: 'count', v: 'sum' },
  cols: [{ key: 'n', label: 'Name' }, { key: 'v', label: 'Value', num: true }] });
test('table: header links sort, the active column is aria-sorted and toggles direction, other state is preserved', () => {
  const html = T({ query: 't.sort=v&t.dir=asc&range=30d' });
  assert.match(html, /aria-sort="ascending"/); assert.match(html, /href="\/x\?t\.sort=v&amp;t\.dir=desc&amp;range=30d&amp;t\.page=1"/);
  assert.match(html, /href="\/x\?[^"]*t\.sort=n&amp;t\.dir=asc/);
  assert.ok(html.indexOf('>a<') < html.indexOf('>b<'), 'rendered in sorted order');
  assert.match(T({ query: 't.sort=v&t.dir=desc' }), /aria-sort="descending"/);
  assert.doesNotMatch(T({ query: 't.sort=__proto__' }), /aria-sort/, 'an unknown sort key is ignored');
});
test('table: footer shows count and sum over all matching rows; pagination links and page-size selector; filter box', () => {
  const big = Array.from({ length: 30 }, (_, i) => ({ n: `r${i}`, v: 1 }));
  const html = T({ rows: big, query: 't.page=2' });
  assert.match(html, /<tfoot>[\s\S]*30 of 30 things[\s\S]*30[\s\S]*<\/tfoot>/); assert.match(html, /26–30 of 30/); assert.match(html, /Page 2 of 2/);
  assert.match(html, /rel="prev"/); assert.doesNotMatch(html, /rel="next"/); assert.match(html, /<option selected>25<\/option>/);
  assert.match(html, /type="search" name="t\.q"/); assert.match(html, /<option>10<\/option><option selected>25<\/option><option>50<\/option><option>100<\/option>/);
  const filtered = T({ rows: big, query: 't.q=r2' }); assert.match(filtered, /<tfoot>[\s\S]*11 of 30 things/); assert.match(filtered, /Clear/);
  assert.match(T({ rows: big, query: 't.q=zzz' }), /No things match the filter/);
  assert.match(T({ rows: big, query: 't.size=10&t.page=9' }), /Page 3 of 3/, 'an out-of-range page is clamped');
  assert.doesNotMatch(T({ query: 't.size=7' }), /<option selected>7/, 'unoffered size ignored');
});
test('table: empty data renders a designed empty state, values are escaped, phone cards carry data-label', () => {
  assert.match(table({ id: 't', path: '/x', query: new URLSearchParams(), rows: [], cols: [{ key: 'n', label: 'Name' }], noun: 'things' }), /class="empty"/);
  const evil = T({ rows: [{ n: '<img src=x onerror=alert(1)>', v: 1 }] });
  assert.doesNotMatch(evil, /<img/); assert.match(evil, /&lt;img/); assert.match(T(), /<td data-label="Name"/);
});

// ---- pages through the real handler
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } }
};
// A clone-like fixture with docs/DECISIONS.md on origin/main, so the dashboard can read the register (issue #130). Never a linked worktree.
function registerRepo(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'dash2-repo-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main'); fs.mkdirSync(path.join(d, 'docs')); fs.writeFileSync(path.join(d, 'docs', 'DECISIONS.md'), '# Decision register\n');
  git('add', '.'); git('commit', '-q', '-m', 'register'); git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  return d;
}
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
async function serve(t, { jobs = [], cache, state, snapshots, upgrades, repo } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash2-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true }); fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true }); fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  for (const j of jobs) fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache));
  if (state) fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify(state));
  if (snapshots) fs.writeFileSync(path.join(root, 'dashboard', 'snapshots.jsonl'), snapshots.map(s => JSON.stringify(s)).join('\n') + '\n');
  if (upgrades) fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), upgrades.map(s => JSON.stringify(s)).join('\n') + '\n');
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config: repo ? { ...config, repo_path: repo } : config, host: '127.0.0.1', port, now: () => NOW }));
  return { get: p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject)) };
}
const jb = (over = {}) => ({ id: 'a'.repeat(32), provider: 'claude', kind: 'implement', issue: 30, branch: 'claude/issue-30-x', status: 'running', createdAt: NOW - 600000, updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 2, usage: { inputTokens: 900, outputTokens: 100, costUsdEstimate: 0.5 }, ...over });
const cache = (extra = {}) => ({ tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, delivered: [],
  pulls: [{ number: 41, title: 'PR forty-one', headRefName: 'claude/issue-30-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green }],
  issues: [{ number: 30, title: 'Thirty', state: 'OPEN', labels: [], prerequisites: [5, 2] }, { number: 5, title: 'Five', state: 'OPEN', labels: [], prerequisites: [] }, { number: 2, title: 'Two', state: 'CLOSED', labels: [], prerequisites: [] },
    { number: 3, title: 'Three <b>x</b>', state: 'OPEN', labels: ['needs-homeowner'], prerequisites: [], question: { question: 'Should the team continue with issue three?', yes: 'work resumes.', no: 'it stays held.' } }], ...extra });

test('every page has its own URL, answers 200 with the navigation bar, and marks the current page', async t => {
  const s = await serve(t, { jobs: [jb()], cache: cache(), state: { verdicts: { [`41:${H(1)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 5000, findings: ['<b>bad</b> thing'] } }, jobs: {} } });
  const urls = ['/', '/agents', '/agents/claude', '/work', '/work/pr/41', '/work/issue/30', '/activity', '/usage', '/reviews', '/system'];
  for (const u of urls) {
    const r = await s.get(u); assert.equal(r.status, 200, u); assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.body, /<nav class="nav" id="nav" aria-label="Pages">/); assert.match(r.body, /aria-current="page"/); assert.match(r.body, /<main id="main" aria-labelledby="page-title">/); assert.match(r.body, /class="skip"/);
    for (const label of ['Overview', 'Agents', 'Work', 'Activity', 'Usage &amp; cost', 'Reviews', 'System']) assert.match(r.body, new RegExp(`<span>${label}</span>`), `${u} ${label}`);
  }
  assert.match((await s.get('/work/pr/41')).body, /<a href="\/work"[^>]*>Work<\/a><span class="sep" aria-hidden="true">›<\/span><\/li><li><span aria-current="page">PR #41 PR forty-one \(for #30 Thirty\)<\/span>/);
  assert.match((await s.get('/agents/claude')).body, /aria-current="page"><svg[^>]*><use href="#i-users"/, 'an agent page highlights Agents');
  assert.match((await s.get('/work/issue/30')).body, /aria-current="page"><svg[^>]*><use href="#i-list"/);
  assert.doesNotMatch((await s.get('/work')).body, /<b>x<\/b>/); assert.doesNotMatch((await s.get('/work/pr/41')).body, /<b>bad<\/b>/);
});
test('drill-down: unknown agent, PR, issue and path give 404; hostile path segments never reach a file', async t => {
  const s = await serve(t, { cache: cache() });
  for (const u of ['/agents/nobody', '/work/pr/999', '/work/issue/999']) { const r = await s.get(u); assert.equal(r.status, 404, u); assert.match(r.body, /not in the dashboard data/); }
  for (const u of ['/nope', '/work/pr/abc', '/work/pr/1/2', '/agents/..%2f..%2fetc', '/static/../server.mjs', '/static/', '/static/secret.txt', '/work/pr/99999999999']) assert.equal((await s.get(u)).status, 404, u);
});
test('PR drill-down: timeline, each round of findings, rounds count, CI; issue drill-down: dependencies, blockers and dependents', async t => {
  const state = { verdicts: { [`41:${H(1)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 90000, findings: ['first finding', { summary: 'second finding' }] }, [`41:${H(2)}`]: { verdict: 'PASS', reviewer: 'codex', at: NOW - 30000, findings: [] } },
    fixAttempts: { [`41:${H(1)}`]: 1 }, rebaseAttempts: { [`41:${H(1)}`]: 2 }, jobs: { ['b'.repeat(32)]: { kind: 'fix', pr: 41 } } };
  const fixJob = jb({ id: 'b'.repeat(32), kind: 'fix', issue: 41, status: 'completed', usage: { inputTokens: 400, outputTokens: 100, costUsdEstimate: null } });
  const s = await serve(t, { jobs: [fixJob], cache: cache(), state });
  const pr = (await s.get('/work/pr/41')).body;
  assert.match(pr, /first finding/); assert.match(pr, /second finding/); assert.match(pr, /1 fix · 2 rebase|2 review · 1 fix · 2 rebase/); assert.match(pr, /CI green/); assert.match(pr, /Verdict history/); assert.match(pr, /Timeline/);
  assert.ok(pr.indexOf('CHANGES') < pr.indexOf('PASS') || pr.indexOf('PASS') < pr.indexOf('CHANGES')); assert.match(pr, /<td data-label="Tokens"[^>]*>500</, 'tokens of the PR job');
  const is = (await s.get('/work/issue/30')).body;
  assert.match(is, /Blocking[\s\S]*>#5 /); assert.match(is, /Done[\s\S]*>#2 /);
  const dep = (await s.get('/work/issue/5')).body; assert.match(dep, /Waiting on this issue[\s\S]*>#30 /);
  assert.match((await s.get('/work/issue/3')).body, /Needs homeowner[\s\S]*Yes/);
});
test('Overview: four labelled panels, KPI tiles and charts all link to detail pages; no inline script', async t => {
  const s = await serve(t, { jobs: [jb()], cache: cache() });
  const body = (await s.get('/')).body;
  for (const id of ['now', 'next', 'needs', 'warnings']) assert.match(body, new RegExp(`data-card="${id}"`));
  for (const h of ['>Now<', '>Next<', '>Needs you', '>Warnings']) assert.ok(body.includes(h), h);
  assert.match(body, /<body class="overview">/);
  for (const href of ['/agents', '/work', '/reviews', '/usage', '/system', '/activity']) assert.ok(body.includes(`href="${href}"`), href);
  assert.match(body, /data-reset-layout/); assert.match(body, /<script type="module" src="\/static\/app\.js"><\/script>/); assert.equal((body.match(/<script/g) || []).length, 3, 'the early dock script, the early layout script and the module');
  assert.match(body, /data-tick-state="(scheduled|starting|overdue)"/);
});
test('Needs you lists every needs-homeowner item with what, why, the decision needed, a link and the exact command; Warnings holds the rest', async t => {
  const s = await serve(t, { cache: { ...cache(), tick: { at: NOW - 20 * 60000, status: 'error', error: 'gh failed', lastOkAt: NOW - 3 * 3600000 } } });
  const body = (await s.get('/')).body;
  const needs = body.slice(body.indexOf('data-card="needs"'), body.indexOf('data-card="warnings"'));
  assert.match(needs, /#3 [^<]*: Should the team continue with issue three\?/); assert.match(needs, /href="\/work\/issue\/3"/); assert.match(needs, /Decision: Answer on the issue/); assert.match(needs, /Action needed/);
  assert.match(needs, /Last tick failed[\s\S]*Decision: Read the tick error/); assert.match(needs, /<code class="cmd mono">ai-supervisor team tick --dry-run<\/code>/);
  const warn = body.slice(body.indexOf('data-card="warnings"'));
  assert.match(warn, /No tick for 20 minutes/); assert.match(warn, /sev-warning/); assert.doesNotMatch(needs, /No tick for/);
  const calm = cache(); calm.issues = calm.issues.filter(i => i.number !== 3);
  const quiet = (await (await serve(t, { cache: calm, repo: registerRepo(t) })).get('/')).body;
  assert.match(quiet, /Nothing needs you/); assert.match(quiet, /No warnings/);
  // Same quiet state but the register cannot be read: a warning says so.
  const blind = (await (await serve(t, { cache: calm })).get('/')).body;
  assert.match(blind, /Cannot read docs\/DECISIONS\.md from origin\/main/); assert.doesNotMatch(blind, /No warnings/);
});
test('Now panel: a running agent shows its job, issue link, elapsed time and attempt; an idle agent shows why in plain words', async t => {
  const s = await serve(t, { jobs: [jb()], cache: cache() });
  const body = (await s.get('/')).body, now = body.slice(body.indexOf('data-card="now"'), body.indexOf('data-card="next"'));
  assert.match(now, /<a href="\/job\/[^"]*"|<a href="\/work\/job\/[^"]*"[^>]*>Implementer · implement · #30[^<]*<\/a>/); assert.match(now, /attempt 2/); assert.match(now, /elapsed 10m/); assert.match(now, /Running/);
  assert.match(now, /Idle: /, 'codex has no job'); assert.doesNotMatch(now, /No current job/);
});
test('idle-reason text is plain English and names the blocker (issue #50 wording reaches the page)', async t => {
  const s = await serve(t, { cache: cache() });
  const j = JSON.parse((await s.get('/api/view.json')).body);
  const codex = j.agents.find(a => a.name === 'codex');
  assert.equal(codex.state, 'idle'); assert.ok(codex.idleReason.text.length > 10);
  assert.match(codex.idleReason.text, /homeowner|#3|about to start|no open/i);
  const body = (await s.get('/')).body; assert.ok(body.includes(codex.idleReason.text.replace(/&/g, '&amp;')) || body.includes(codex.idleReason.text.replace(/[<>"']/g, '')), 'the same sentence is on the page');
});
test('Next panel shows the dispatcher plan and a live countdown to the next tick; status bar has health, tick, freshness, loop and version', async t => {
  const s = await serve(t, { cache: cache(), upgrades: [{ at: NOW - 1000, from: H(1), to: H(2), result: 'refused', reason: 'x' }] });
  const body = (await s.get('/')).body;
  // NOW is exactly on a cron slot, so the slot after the last tick (12:59) is just due: the tick is starting (grace before overdue) (the countdown states are tested in dashboard-next-tick.test.mjs)
  assert.match(body, new RegExp(`data-overdue="${Math.floor((NOW - 60000) / 300000) * 300000 + 300000}"`)); assert.match(body, /data-tick-state="starting"><span data-overdue="\d+">tick due, starting<\/span>/);
  const bar = body.slice(body.indexOf('class="statusbar"'), body.indexOf('<nav class="nav"'));
  for (const w of ['Overall health', 'Last tick', 'Tick ok', 'Next', 'Data', 'Fresh', 'Team loop', 'Enabled', 'Version', 'Deploy needed']) assert.ok(bar.includes(w), w);
  assert.match(bar, /1m ago/); assert.match(bar, /badge sev-warning[^>]*>[\s\S]*1111111 → 2222222/);
  const offline = (await (await serve(t, { cache: { ...cache(), tick: undefined } })).get('/')).body;
  assert.match(offline, /No tick yet/); assert.match(offline, /sev-action[^>]*>[\s\S]*No data/);
});
test('version drift: parsed from the self-upgrade records only; installed means the last upgraded or verified commit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ver-')); fs.mkdirSync(path.join(root, 'team'));
  try {
    assert.equal(readVersion(root), null);
    const w = rs => fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), rs.map(r => JSON.stringify(r)).join('\n') + '\nnot json\n');
    w([{ from: H(1), to: H(2), result: 'upgraded' }]); assert.equal(readVersion(root).drift, false);
    w([{ from: H(1), to: H(2), result: 'upgraded' }, { from: H(2), to: H(3), result: 'refused' }]); const v = readVersion(root); assert.equal(v.drift, true); assert.equal(v.installed, H(2)); assert.equal(v.main, H(3));
    w([{ from: H(2), to: H(3), result: 'verified' }]); assert.equal(readVersion(root).drift, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('charts: a time-range selector, expand, legend toggles per series, tooltips, agent colours consistent across charts', async t => {
  const snap = (at, u) => ({ at, status: 'ok', plan: [], agents: {}, allowance: { claude: { observedAt: at, windows: [{ type: 'five_hour', utilization: u, resetsAt: at + 1000 }, { type: 'seven_day', utilization: u / 2, resetsAt: at + 5000 }] }, codex: { observedAt: at, windows: [{ type: 'primary', windowMinutes: 300, utilization: 0.1, resetsAt: at + 9 }] } } });
  const s = await serve(t, { jobs: [jb()], cache: cache(), snapshots: [snap(NOW - 20 * 86400000, 0.9), snap(NOW - 3 * 86400000, 0.5), snap(NOW - 2 * 3600000, 0.3)] });
  const week = (await s.get('/usage')).body, day = (await s.get('/usage?range=24h')).body, month = (await s.get('/usage?range=30d')).body;
  assert.match(week, /aria-current="true">7d/); assert.match(day, /aria-current="true">24h/); assert.match(month, /aria-current="true">30d/);
  const pts = b => (b.match(/<circle class="pt"/g) || []).length;
  assert.ok(pts(day) > 0 && pts(day) < pts(week) && pts(week) < pts(month), `${pts(day)} < ${pts(week)} < ${pts(month)}`);
  assert.match(week, /<button type="button" aria-pressed="true" data-series="claude 5-hour">/); assert.match(week, /<g data-series="claude 5-hour">/); assert.match(week, /<title[^>]*>claude 5-hour: 30% at /);
  assert.match(week, /data-expand/); assert.match(week, /stroke="var\(--claude\)"/); assert.match(week, /stroke="var\(--codex\)"/);
  assert.match(week, /<svg viewBox="0 0 900 320" role="img" aria-label="allowance used over time">/, 'larger viewBox than the 520x170 of v1');
  assert.match((await s.get('/?range=24h')).body, /Allowance used \(24h\)/);
  assert.doesNotMatch((await s.get('/usage?range=%3Cscript%3E')).body, /<script>/);
});
test('charts: empty data gives a designed empty state instead of a blank or bare line', async t => {
  const s = await serve(t, { cache: cache() });
  assert.match((await s.get('/usage')).body, /No allowance history in this range/); assert.match((await s.get('/reviews')).body, /No verdicts recorded/);
});
test('usage and reviews tables: sortable, with footers (total tokens, job count, average review rounds)', async t => {
  const jobs = [jb(), jb({ id: 'c'.repeat(32), createdAt: NOW - 5000, usage: { inputTokens: 50, outputTokens: 50, costUsdEstimate: 0.25 }, issue: 31 })];
  const s = await serve(t, { jobs, cache: cache(), state: { verdicts: { [`41:${H(1)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 2000, findings: ['a', 'b'] }, [`41:${H(2)}`]: { verdict: 'PASS', reviewer: 'codex', at: NOW - 1000, findings: [] } } } });
  const u = (await s.get('/usage?jobs.sort=inTokens&jobs.dir=desc')).body;
  assert.match(u, /aria-sort="descending"/); assert.ok(u.indexOf('>900</td>') < u.indexOf('>50</td>'));
  assert.match(u, /<tfoot>[\s\S]*2 jobs[\s\S]*950[\s\S]*150[\s\S]*\$0\.75/);
  const r = (await s.get('/reviews')).body;
  assert.match(r, /<tfoot>[\s\S]*2 verdicts[\s\S]*avg 1/); const w = (await s.get('/work')).body;
  assert.match(w, /<tfoot>[\s\S]*1 pull requests[\s\S]*avg 2/); assert.match(w, /4 issues/);
  const act = (await s.get('/agents/claude?jobs.size=10&jobs.q=implement')).body; assert.match(act, /Job history \(2\)/); assert.match(act, /2 jobs/);
});
test('phone design: tables carry labels for card layout, tap-to-expand rows, bottom tab bar and 44px targets are in the stylesheet', async t => {
  const s = await serve(t, { jobs: [jb()], cache: cache() });
  assert.match((await s.get('/work')).body, /<tr tabindex="0">/);
  const css = (await s.get('/static/style.css')).body;
  assert.match(css, /@media\(max-width:639px\)[\s\S]*\.nav\{position:fixed;bottom:0/); assert.match(css, /min-height:44px;min-width:44px/); assert.match(css, /td::before\{content:attr\(data-label\)/);
  assert.match(css, /\.resize,\.wide-only\{display:none!important\}/, 'no free resizing on a phone');
  for (const bp of ['@media(min-width:1100px)', '@media(max-width:1099px)', '@media(max-width:639px)', 'prefers-reduced-motion:reduce', 'prefers-color-scheme:dark', ':root[data-theme=dark]', ':focus-visible']) assert.ok(css.includes(bp), bp);
  assert.doesNotMatch(css, /@import|url\(|https?:\/\//);
});
test('design tokens: every severity has foreground and background tokens in both themes; contrast of text on severity backgrounds is at least 4.5:1', () => {
  const css = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
  const block = sel => { const i = css.indexOf(sel); return css.slice(i, css.indexOf('}', i)); };
  const lum = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m); return (x + 0.05) / (y + 0.05); };
  for (const [name, sel] of [['light', ':root{'], ['dark', ':root[data-theme=dark]{']]) {
    const b = block(sel), tok = n => (new RegExp(`--${n}:(#[0-9a-f]{6})`).exec(b) || [])[1];
    for (const level of ['action', 'warning', 'info', 'ok']) { const fg = tok(level), bg = tok(`${level}-bg`); assert.ok(fg && bg, `${name} ${level}`); assert.ok(ratio(fg, bg) >= 4.5, `${name} ${level} ${ratio(fg, bg).toFixed(2)}`); }
    assert.ok(ratio(tok('fg'), tok('bg')) >= 7, `${name} body text`); assert.ok(ratio(tok('mut'), tok('surface')) >= 4.5, `${name} muted text`); assert.ok(ratio(tok('link'), tok('surface')) >= 4.5, `${name} link`);
    for (const a of ['claude', 'codex']) assert.ok(ratio(tok(a), tok('surface')) >= 3, `${name} ${a} series vs surface (graphics 3:1)`);
  }
});

// ---- static files and headers
test('static files: fixed whitelist, correct types, same headers; the page makes no external request', async t => {
  const s = await serve(t, { cache: cache() });
  const js = await s.get('/static/app.js'), css = await s.get('/static/style.css'), lg = await s.get('/static/logic.mjs');
  assert.equal(js.status, 200); assert.match(js.headers['content-type'], /javascript/); assert.equal(css.status, 200); assert.match(css.headers['content-type'], /text\/css/); assert.match(lg.headers['content-type'], /javascript/);
  assert.match(js.body, /from '\.\/logic\.mjs'/); assert.equal(lg.body, fs.readFileSync(new URL('../supervisor/dashui/logic.mjs', import.meta.url), 'utf8'));
  assert.match(js.headers['content-security-policy'], /script-src 'self'/); assert.match(js.headers['x-content-type-options'], /nosniff/);
  for (const p of ['/', '/work', '/usage']) { const b = (await s.get(p)).body; assert.doesNotMatch(b, /(?:src|href|action)="(?:https?:)?\/\/(?!github\.com\/o\/r\/)/, p); assert.doesNotMatch(b, /<(?:img|iframe|object|embed)\b|cdn\./i, p); }
});
test('routes: matchRoute accepts only the documented shapes', () => {
  assert.deepEqual(matchRoute('/'), { page: 'overview' }); assert.deepEqual(matchRoute('/work/pr/12'), { page: 'pr', id: 12 }); assert.deepEqual(matchRoute('/agents/'), { page: 'agents' });
  for (const bad of ['/work/pr/', '/work/pr/-1', '/agents/a b', '/agents/a/b', '/WORK', '/work/issue/1e3']) assert.equal(matchRoute(bad), null, bad);
});

// ---- issue #141: the Needs you panel lists every open needs-homeowner item and clears when it is resolved
const red = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
const calmCache = (pull = {}, extra = {}) => { const c = cache(extra); c.issues = c.issues.filter(i => i.number !== 3); c.pulls = [{ ...c.pulls[0], ...pull }]; return c; };
const needsOf = async (s) => JSON.parse((await s.get('/api/view.json')).body);
test('#141 a blocked job gives exactly one card with what, tried, action and links; closing the PR clears it', async t => {
  const blocked = jb({ status: 'blocked', kind: 'cifix', issue: 41, provider: 'claude', lastEvent: 'blocked_needs_input', updatedAt: NOW - 1000 });
  const v = await needsOf(await serve(t, { jobs: [blocked], cache: calmCache() }));
  assert.equal(v.panels.needsYou.length, 1); const c = v.panels.needsYou[0];
  assert.match(c.text, /is blocked/); assert.ok(c.tried && c.decision); assert.ok(c.links.some(l => l.url === 'https://github.com/o/r/pull/41')); assert.ok(c.links.some(l => /^(Implementer|Reviewer) · /.test(l.text) && /^\/work\/job\//.test(l.url)));
  assert.equal(v.health.label, 'Needs you (1)'); assert.equal(v.health.count, 1);
  const gone = calmCache(); gone.pulls = [{ ...gone.pulls[0], number: 99 }];
  assert.equal((await needsOf(await serve(t, { jobs: [blocked], cache: gone }))).panels.needsYou.length, 0, 'the PR is no longer open');
});
test('#141 a fix-limit PR gives one card instead of a CI warning; fewer fix rounds leaves the warning', async t => {
  const state = { fixAttempts: { [`41:${H(1)}`]: 2 }, verdicts: {}, jobs: {} };
  const v = await needsOf(await serve(t, { cache: calmCache({ statusCheckRollup: red, labels: ['needs-homeowner'] }), state }));
  assert.equal(v.panels.needsYou.length, 1, 'label and limit are one card');
  assert.match(v.panels.needsYou[0].id, /^fixlimit-41$/); assert.match(v.panels.needsYou[0].tried, /2 fix rounds/);
  assert.ok(!v.panels.warnings.some(w => w.id === 'ci-41'), 'the CI warning became the card');
  const early = await needsOf(await serve(t, { cache: calmCache({ statusCheckRollup: red }), state: { fixAttempts: { [`41:${H(1)}`]: 1 }, verdicts: {}, jobs: {} } }));
  assert.equal(early.panels.needsYou.length, 0); assert.ok(early.panels.warnings.some(w => w.id === 'ci-41'));
});
test('#211 no Action needed while the final fix round is planned; Action needed once the final round has failed', async t => {
  const state = { fixAttempts: { [`41:${H(1)}`]: 2 }, verdicts: {}, jobs: {} };
  const planned = await needsOf(await serve(t, { cache: calmCache({ statusCheckRollup: red }), state }));
  assert.ok(!planned.panels.needsYou.some(c => /^fixlimit-/.test(c.id)), 'Foreman has a next step, so nothing is asked of the homeowner');
  assert.equal(planned.health.label === 'Needs you (1)', false);
  assert.ok(!planned.panels.warnings.some(w => w.id === 'ci-41'));
  assert.match(JSON.stringify(planned), /Foreman is handling: one final fix round.*no action needed/, 'the page says what Foreman is doing');
  const failed = await needsOf(await serve(t, { cache: calmCache({ statusCheckRollup: red }), state: { ...state, unblock: { escalated: { 41: true }, pr: {}, day: {}, log: [] } } }));
  assert.deepEqual(failed.panels.needsYou.map(c => c.id), ['fixlimit-41']);
  assert.match(failed.panels.needsYou[0].overseer, /Action needed/);
  // the usual path (the final round ran and was rejected, no write block) gives the same choices, history included
  const card = failed.panels.needsYou[0];
  assert.match(card.action, /wait for another agent to be able to review.*split the PR into smaller pieces.*fix it by hand/); assert.doesNotMatch(card.action, /pay|credit|paid/i);
  assert.match(card.tried, /fresh session on the same model/); assert.match(card.tried, /final round could split/); assert.match(card.tried, /never moves a fix to a stronger model/);
  assert.match(failed.panels.needsYou[0].overseer, /\(filtered: only ticks mentioning PR #41; other ticks are omitted\)/);
});
test('#141 no limit card while the final review or fix job is still running', async t => {
  const rv = await needsOf(await serve(t, { jobs: [jb({ kind: 'review', issue: 41, status: 'running' })], cache: calmCache(), state: { reviewAttempts: { [`41:${H(1)}:codex`]: 2 }, verdicts: {}, jobs: {} } }));
  assert.equal(rv.panels.needsYou.length, 0); assert.notEqual(rv.health.label, 'Needs you (1)');
  const fx = await needsOf(await serve(t, { jobs: [jb({ kind: 'fix', issue: 41, status: 'running' })], cache: calmCache({ statusCheckRollup: red }), state: { fixAttempts: { [`41:${H(1)}`]: 2 }, verdicts: {}, jobs: {} } }));
  assert.ok(!fx.panels.needsYou.some(c => /^fixlimit-/.test(c.id)));
});
// Issue #184: the hold covers every active status and every final-round kind, and it ends when the job does.
const reviewLimitState = () => ({ reviewAttempts: { [`41:${H(1)}:codex`]: 2 }, verdicts: {}, jobs: {} });
const fixLimitState = () => ({ fixAttempts: { [`41:${H(1)}`]: 2 }, verdicts: {}, jobs: {}, unblock: { escalated: { 41: true }, pr: {}, day: {}, log: [] } });
for (const status of ['queued', 'running', 'paused_limit', 'paused_manual']) {
  test(`#184 no review limit card while the review job is ${status}`, async t => {
    const v = await needsOf(await serve(t, { jobs: [jb({ kind: 'review', issue: 41, status })], cache: calmCache(), state: reviewLimitState() }));
    assert.ok(!v.panels.needsYou.some(c => /^reviewlimit-/.test(c.id)));
  });
  for (const kind of ['fix', 'cifix', 'rebase']) {
    test(`#184 no fix limit card while the ${kind} job is ${status}`, async t => {
      const v = await needsOf(await serve(t, { jobs: [jb({ kind, issue: 41, status })], cache: calmCache({ statusCheckRollup: red }), state: fixLimitState() }));
      assert.ok(!v.panels.needsYou.some(c => /^(fixlimit|escalating)-/.test(c.id)));
    });
  }
}
for (const status of ['completed', 'failed', 'blocked', 'stopped']) {
  test(`#184 the limit cards come back once the final job is ${status}`, async t => {
    const rv = await needsOf(await serve(t, { jobs: [jb({ kind: 'review', issue: 41, status })], cache: calmCache(), state: reviewLimitState() }));
    assert.ok(rv.panels.needsYou.some(c => c.id === 'reviewlimit-41'), 'review limit card returns');
    for (const kind of ['fix', 'cifix', 'rebase']) {
      const fx = await needsOf(await serve(t, { jobs: [jb({ kind, issue: 41, status })], cache: calmCache({ statusCheckRollup: red }), state: fixLimitState() }));
      assert.ok(fx.panels.needsYou.some(c => c.id === 'fixlimit-41'), `${kind}: fix limit card returns`);
    }
  });
}
test('#184 a job paused by hand still shows on the agent card and the header says Paused', async t => {
  const v = await needsOf(await serve(t, { jobs: [jb({ kind: 'fix', issue: 41, status: 'paused_manual', lastEvent: 'manual_pause' })], cache: calmCache({ statusCheckRollup: red }), state: fixLimitState() }));
  assert.ok(!v.panels.needsYou.some(c => /^(fixlimit|escalating)-/.test(c.id)));
  const shown = Object.values(v.agents).flatMap(a => a.jobs || []).filter(j => j.paused && j.status === 'paused_manual');
  assert.equal(shown.length, 1, 'the paused job is listed on its agent card');
  assert.equal(v.health.label, 'Paused');
});
test('#141 a review-limit PR gives one card', async t => {
  const v = await needsOf(await serve(t, { cache: calmCache(), state: { reviewAttempts: { [`41:${H(1)}:codex`]: 2 }, verdicts: {}, jobs: {} } }));
  assert.deepEqual(v.panels.needsYou.map(c => c.id), ['reviewlimit-41']);
});
test('#141 a labelled PR gives one card, removing the label clears it, and the empty state shows only when nothing is open', async t => {
  const labelled = await serve(t, { cache: calmCache({ labels: ['needs-homeowner'] }) });
  const v = await needsOf(labelled); assert.deepEqual(v.panels.needsYou.map(c => c.id), ['homeowner-pr-41']);
  assert.match(v.health.label, /^Needs you \(1\)$/);
  const page = (await labelled.get('/')).body; assert.match(page, /Needs you \(1\)/); assert.doesNotMatch(page, /Nothing needs you/); assert.match(page, /Tried: Foreman labelled this PR/);
  const clear = await serve(t, { cache: calmCache({ labels: [] }), repo: registerRepo(t) });
  assert.equal((await needsOf(clear)).panels.needsYou.length, 0); assert.equal((await needsOf(clear)).health.label, 'Idle');
  assert.match((await clear.get('/')).body, /Nothing needs you/);
});
test('#212 an issue in no agent list is eligible: no Needs-you card; exclusions are listed with reasons; a closed-unmerged PR raises a card', async t => {
  const c = calmCache();
  // Built through compactIssues, as the tick writes the cache: no body survives, only what was parsed from it.
  const cached = compactIssues([{ number: 77, title: 'Unlisted', state: 'OPEN', labels: [] }, { number: 78, title: 'Closed', state: 'CLOSED', labels: [] },
    { number: 79, title: 'Epic', state: 'OPEN', labels: ['epic'] }, { number: 80, title: 'Wait', state: 'OPEN', labels: [], body: 'Follow-up to PR #201' },
    { number: 81, title: 'Gone', state: 'OPEN', labels: [], body: 'Follow-up to PR #202' }, { number: 82, title: 'Merged', state: 'OPEN', labels: [], body: 'Follow-up to PR #203' }]);
  assert.ok(cached.every(i => !('body' in i)), 'the cache keeps no issue body');
  c.issues.push(...cached);
  c.pulls.push({ number: 201, title: 'The open PR', headRefName: 'feature/x', headRefOid: 'a'.repeat(40), isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [], labels: [] });
  c.mergedNumbers = [203];
  const v = await needsOf(await serve(t, { cache: c }));
  assert.ok(!v.panels.needsYou.some(x => x.id === 'unqueued'));
  assert.ok(v.panels.needsYou.some(x => x.id === 'prclosed-81'), 'closed without merging needs the homeowner');
  assert.ok(!v.panels.needsYou.some(x => x.id === 'prclosed-80' || x.id === 'prclosed-82'));
  const ex = Object.fromEntries((v.excluded || []).map(e => [e.number, e]));
  assert.match(ex[79].reason, /labelled epic/); assert.match(ex[80].reason, /waiting for PR #201 The open PR to merge/); assert.match(ex[81].reason, /closed without merging/);
  assert.ok(!ex[77] && !ex[82] && !ex[78], 'eligible, merged-PR and closed issues are not excluded');
});
test('legend (issue #160): hiding keeps the item in the legend, the last visible series cannot be hidden, Show all restores', async () => {
  const { toggleSeries, sanitizeHidden } = await import('../supervisor/dashui/logic.mjs');
  const all = ['a', 'b', 'c'];
  let h = toggleSeries([], 'a', all); assert.deepEqual(h, ['a']);
  h = toggleSeries(h, 'a', all); assert.deepEqual(h, [], 'clicking again restores');
  h = toggleSeries(toggleSeries([], 'a', all), 'b', all); assert.deepEqual(h.sort(), ['a', 'b']);
  assert.deepEqual(toggleSeries(h, 'c', all).sort(), ['a', 'b'], 'the last visible series is not hidden');
  assert.deepEqual(toggleSeries([], 'only', ['only']), [], 'a single-series chart never hides it');
  assert.deepEqual(toggleSeries([], 'zzz', all), [], 'unknown key ignored');
  assert.deepEqual(sanitizeHidden(['a', 'gone', 7], all), ['a'], 'stale or malformed stored keys are dropped');
  assert.deepEqual(sanitizeHidden(['a', 'b', 'c'], all).length, 2, 'stored state can never hide everything');
  assert.deepEqual(sanitizeHidden('junk', all), []); assert.deepEqual(sanitizeHidden(null, all), []);
  assert.equal(sanitizeHidden(['a', 'b', 'c', 'c'], all).length, 2, 'duplicates are removed before the all-hidden guard (issue #190)');
  assert.deepEqual(sanitizeHidden(['a', 'a'], all), ['a']);
  // marker-only keys never count as a series
  const data = ['claude', 'codex'], marks = ['reset', 'expected'];
  assert.deepEqual(toggleSeries(['claude'], 'codex', data, marks), ['claude'], 'last data series stays even though markers exist');
  assert.deepEqual(toggleSeries(['claude'], 'reset', data, marks).sort(), ['claude', 'reset'], 'markers toggle freely');
  assert.deepEqual(toggleSeries(['reset'], 'reset', data, marks), []);
  assert.deepEqual(sanitizeHidden(['claude', 'codex', 'reset'], data, marks), ['claude', 'reset'], 'stored state hiding every data series is trimmed, markers kept');
});
// A tiny fake DOM: enough of Element for initLegends (issue #190), so behaviour is tested rather than source text.
function fakeEl(tag, attrs = {}, kids = []) {
  let cls;
  const el = { tag, attrs: { ...attrs }, children: [], parent: null, listeners: {}, classes: new Set(), hidden: false, textContent: '',
    get className() { return cls; }, set className(v) { cls = v; el.attrs.class = v; },
    get dataset() { return new Proxy({}, { get: (_, k) => el.attrs['data-' + k], set: (_, k, v) => { el.attrs['data-' + k] = v; return true; } }); },
    setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute: k => el.attrs[k] ?? null,
    classList: { toggle: (c, on) => { on ? el.classes.add(c) : el.classes.delete(c); }, contains: c => el.classes.has(c) },
    append(...n) { for (const c of n) { c.parent = el; el.children.push(c); } },
    addEventListener(t, f) { (el.listeners[t] ||= []).push(f); }, click() { for (const f of el.listeners.click || []) f(); },
    all: () => el.children.flatMap(c => [c, ...c.all()]),
    contains: n => n === el || el.children.some(c => c.contains(n)),
    closest: () => null,
    querySelectorAll: sel => el.all().filter(c => sel === 'figure.chart' ? c.tag === 'figure' : sel === '.legend' ? c.attrs.class === 'legend' : sel === 'svg' ? c.tag === 'svg' : sel === 'button[data-series]' ? c.tag === 'button' && 'data-series' in c.attrs : sel === '[data-series]' ? 'data-series' in c.attrs : sel === '[data-reset-layout]' ? 'data-reset-layout' in c.attrs : false),
    querySelector: sel => el.querySelectorAll(sel)[0] ?? null };
  el.append(...kids); return el;
}
function legendPage(stored) {
  const item = (k, marker) => fakeEl('button', { 'data-series': k, ...(marker ? { 'data-marker': 'true' } : {}), 'aria-pressed': 'true' });
  const line = k => fakeEl('g', { 'data-series': k });
  const fig = fakeEl('figure', {}, [fakeEl('svg', { 'aria-label': 'allowance' }, [line('claude'), line('codex'), line('reset')]), fakeEl('div', { class: 'legend' }, [item('claude'), item('codex'), item('reset', true)])]);
  const doc = fakeEl('body', {}, [fig]); doc.createElement = tag => fakeEl(tag);
  const mem = new Map(stored ? [['k', JSON.stringify(stored)]] : []);
  const store = { get: k => (mem.has(k) ? JSON.parse(mem.get(k)) : null), set: (k, v) => mem.set(k, JSON.stringify(v)), del: k => mem.delete(k) };
  const by = k => fig.all().filter(c => c.attrs['data-series'] === k);
  return { doc, store, mem, fig, btn: k => by(k).find(c => c.tag === 'button'), shape: k => by(k).find(c => c.tag === 'g'), showAll: () => fig.all().find(c => c.attrs.class === 'legend-all') };
}
test('legend (issue #190): driven through a fake DOM: hide, restore, persist, guard ignores reset markers, Show all', async () => {
  const { initLegends } = await import('../supervisor/dashui/legend.mjs');
  const pg = legendPage(); initLegends({ document: pg.doc, store: pg.store, legendKey: 'k' });
  assert.equal(pg.showAll().hidden, true, 'Show all is hidden while nothing is hidden');
  pg.btn('claude').click();
  assert.ok(pg.shape('claude').classes.has('off')); assert.equal(pg.btn('claude').attrs['aria-pressed'], 'false'); assert.equal(pg.showAll().hidden, false);
  assert.deepEqual(JSON.parse(pg.mem.get('k')).allowance, ['claude'], 'persisted by chart id');
  pg.btn('codex').click();
  assert.ok(!pg.shape('codex').classes.has('off'), 'the last data series cannot be hidden although the reset marker is still visible');
  pg.btn('reset').click(); assert.ok(pg.shape('reset').classes.has('off'), 'the marker hides on its own');
  pg.btn('claude').click(); assert.ok(!pg.shape('claude').classes.has('off'), 'clicking again restores');
  pg.btn('claude').click(); pg.showAll().click();
  assert.ok(![pg.shape('claude'), pg.shape('reset')].some(e => e.classes.has('off'))); assert.equal(pg.mem.has('k'), false, 'Show all clears the stored state');
  assert.ok(![...pg.fig.all()].some(c => c.attrs.class === 'legend' && c.classes.has('off')), 'the legend itself is never hidden');
});
test('legend (issue #190): stored state is re-applied, and a tampered list cannot hide every data series', async () => {
  const { initLegends } = await import('../supervisor/dashui/legend.mjs');
  const ok = legendPage({ allowance: ['claude', 'reset'] }); initLegends({ document: ok.doc, store: ok.store, legendKey: 'k' });
  assert.ok(ok.shape('claude').classes.has('off') && ok.shape('reset').classes.has('off') && !ok.shape('codex').classes.has('off'));
  const bad = legendPage({ allowance: ['claude', 'codex', 'codex', 'reset'] }); initLegends({ document: bad.doc, store: bad.store, legendKey: 'k' });
  assert.ok(!bad.shape('codex').classes.has('off') && bad.shape('claude').classes.has('off'), 'duplicate-padded list still leaves a data series visible');
});
test('legend (issue #190): Reset layout exists on Overview and Usage, markers are flagged in the rendered legend', async () => {
  const src = fs.readFileSync(new URL('../supervisor/dashrender.mjs', import.meta.url), 'utf8');
  assert.equal((src.match(/data-reset-layout/g) || []).length, 2, 'both chart pages offer Reset layout');
  assert.match(src, /data-marker="true"/); assert.equal((src.match(/marker: true/g) || []).length, 2);
});
test('legend (issue #190): clicking Reset layout clears the layout and legend state on /usage and /, then reloads', async () => {
  const { initLegends, initResetLayout } = await import('../supervisor/dashui/legend.mjs');
  for (const [path, layout] of [['/usage', 'dash.layout.usage.desktop'], ['/', 'dash.layout.overview.desktop']]) {
    const pg = legendPage(); const legendKey = 'dash.legend.' + path;
    const reset = fakeEl('button', { 'data-reset-layout': '' }); pg.doc.append(reset);
    initLegends({ document: pg.doc, store: pg.store, legendKey });
    pg.btn('claude').click(); pg.store.set(layout, { a: 1 }); pg.store.set('dash.layout.other', { b: 1 });
    assert.ok(pg.mem.has(legendKey) && pg.mem.has(layout));
    let reloads = 0; initResetLayout({ document: pg.doc, store: pg.store, layoutKey: () => layout, legendKey, reload: () => reloads++ });
    reset.click();
    assert.equal(pg.mem.has(legendKey), false, path + ': legend state cleared'); assert.equal(pg.mem.has(layout), false, path + ': layout cleared');
    assert.ok(pg.mem.has('dash.layout.other'), 'unrelated keys untouched'); assert.equal(reloads, 1);
  }
});
test('legend (issue #160): app.js uses the shared handler, never hides the legend itself, persists safely and clears on Reset layout', () => {
  const js = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
  assert.match(js, /initLegends\(\{ document, store, legendKey \}\)/, 'app.js delegates to the tested legend module');
  assert.match(js, /initResetLayout\(\{ document, store, layoutKey: key, legendKey, reload/, 'app.js delegates Reset layout to the tested module');
  assert.match(js, /try \{ return JSON\.parse\(localStorage/, 'storage access is wrapped in try/catch');
});

// ---- issue #244: a too-large issue shows one Accept-split card; failed attempts show their tokens and cost
test('#244 a proposed split is one Needs you card with the Accept split path and the spend; no duplicate job or label card', async t => {
  const blocked = jb({ status: 'blocked', lastEvent: 'context_too_large', issue: 30, updatedAt: NOW - 1000, usage: { inputTokens: 3000000, outputTokens: 700000, costUsdEstimate: 2 } });
  const c = cache(); c.issues = c.issues.map(i => (i.number === 30 ? { ...i, labels: ['needs-homeowner'] } : i));
  const state = { jobs: {}, verdicts: {}, splits: { 30: { status: 'proposed', implementJob: blocked.id, agent: 'claude', wasted: { tokens: 3700000, cost: 2, attempts: 4 }, children: [{ title: 'A', scope: 'a' }, { title: 'B', scope: 'b' }] } } };
  const v = await needsOf(await serve(t, { jobs: [blocked], cache: c, state }));
  const ids = v.panels.needsYou.map(x => x.id).filter(id => id !== 'unqueued' && id !== 'homeowner-3');   // fixture noise: no agent queues, issue 3 already labelled
  assert.deepEqual(ids, ['split-30']);
  const card = v.panels.needsYou.find(x => x.id === 'split-30');
  assert.equal(card.id, 'split-30'); assert.match(card.action, /Accept split.*team accept-split 30/); assert.match(card.tried, /3,700,000 tokens.*\$2\.00/);
  // Drafting is not yet a decision; an accepted split is no longer one either.
  for (const status of ['drafting', 'accepted']) {
    state.splits[30].status = status;
    const done = await needsOf(await serve(t, { jobs: [blocked], cache: c, state }));
    assert.ok(!done.panels.needsYou.some(x => x.id === 'split-30'), status);
    assert.ok(!done.panels.needsYou.some(x => x.id.startsWith('job-')), 'the blocked implement job is explained by the split, not a second card');
  }
});
test('#244 failed attempts: tokens and cost are summed on the dashboard and shown on the Usage page', async t => {
  const failed = jb({ id: 'b'.repeat(32), status: 'blocked', lastEvent: 'context_too_large', issue: 30, usage: { inputTokens: 3000000, outputTokens: 700000, costUsdEstimate: 2 } });
  const ok = jb({ id: 'c'.repeat(32), status: 'completed', issue: 5, usage: { inputTokens: 500, outputTokens: 100, costUsdEstimate: 0.25 } });
  const s = await serve(t, { jobs: [failed, ok], cache: cache() });
  const v = JSON.parse((await s.get('/api/view.json')).body);
  assert.equal(v.failedSpend.jobs, 1); assert.equal(v.failedSpend.tokens, 3700000); assert.equal(v.failedSpend.cost, 2);
  assert.equal(v.failedSpend.rows.length, 1);
  const page = (await s.get('/usage')).body;
  assert.match(page, /Failed attempts: 1 job, 3,700,000 tokens, \$2\.00/);
  const none = JSON.parse((await (await serve(t, { jobs: [ok], cache: cache() })).get('/api/view.json')).body);
  assert.deepEqual([none.failedSpend.jobs, none.failedSpend.tokens, none.failedSpend.cost], [0, null, null]);
});

// ---- issue #186: review follow-ups to the Needs you panel
test('#186 a failed job on a PR at the review or fix limit folds into the limit card', async t => {
  const failed = jb({ status: 'failed', kind: 'review', issue: 41, provider: 'codex', lastEvent: 'failed', updatedAt: NOW - 1000 });
  const rl = await needsOf(await serve(t, { jobs: [failed], cache: calmCache(), state: { reviewAttempts: { [`41:${H(1)}:codex`]: 2 }, verdicts: {}, jobs: {} } }));
  assert.deepEqual(rl.panels.needsYou.map(c => c.id), ['reviewlimit-41']);
  assert.equal(rl.health.label, 'Needs you (1)');
  const fixJob = jb({ status: 'failed', kind: 'fix', issue: 41, provider: 'claude', lastEvent: 'failed', updatedAt: NOW - 1000 });
  const fl = await needsOf(await serve(t, { jobs: [fixJob], cache: calmCache({ statusCheckRollup: red }), state: { fixAttempts: { [`41:${H(1)}`]: 2 }, verdicts: {}, jobs: {}, unblock: { escalated: { 41: true }, pr: {}, day: {}, log: [] } } }));
  assert.deepEqual(fl.panels.needsYou.map(c => c.id), ['fixlimit-41']);
  // negative: with no limit reached the failed job still gets its own card
  const alone = await needsOf(await serve(t, { jobs: [failed], cache: calmCache() }));
  assert.equal(alone.panels.needsYou.length, 1); assert.match(alone.panels.needsYou[0].id, /^job-/);
});
test('#186 a failed PR job is dropped when no PR is open at all; kept while its PR is open', async t => {
  const failed = jb({ status: 'failed', kind: 'fix', issue: 41, provider: 'claude', lastEvent: 'failed', updatedAt: NOW - 1000 });
  const none = calmCache(); none.pulls = [];
  assert.equal((await needsOf(await serve(t, { jobs: [failed], cache: none }))).panels.needsYou.length, 0, 'merged PR, no open PRs');
  assert.equal((await needsOf(await serve(t, { jobs: [failed], cache: calmCache() }))).panels.needsYou.length, 1);
});
test('#186 a failed issue job whose issue is older than the cached issue window is dropped; kept while the issue is cached and open', async t => {
  const failed = jb({ status: 'failed', kind: 'implement', issue: 9999, branch: 'claude/issue-9999-x', provider: 'claude', lastEvent: 'failed', updatedAt: NOW - 1000 });
  assert.equal((await needsOf(await serve(t, { jobs: [failed], cache: calmCache() }))).panels.needsYou.length, 0, 'issue not in the cache');
  const c = calmCache(); c.issues.push({ number: 9999, title: 'x', state: 'OPEN', labels: [] });
  assert.equal((await needsOf(await serve(t, { jobs: [failed], cache: c }))).panels.needsYou.filter(x => /^job-/.test(x.id)).length, 1);
});

// Issue #405: Needs you shows a fix-limit item only when the homeowner must act.
test('#405 fix limit: a real CHANGES on the current head is Needs you, with or without the label', async t => {
  const state = { ...fixLimitState(), verdicts: { [`41:${H(1)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: 1 } } };
  const v = await needsOf(await serve(t, { jobs: [], cache: calmCache(), state }));
  assert.ok(v.panels.needsYou.some(c => c.id === 'fixlimit-41'), 'listed although the PR carries no needs-homeowner label');
});
test('#405 fix limit: a PR only awaiting review is queued, not Needs you, even with a stale needs-homeowner label', async t => {
  const state = fixLimitState();   // fix limit reached earlier, no verdict on the current head
  for (const pull of [{}, { labels: ['needs-homeowner'] }]) {
    const v = await needsOf(await serve(t, { jobs: [], cache: calmCache(pull), state }));
    assert.ok(!v.panels.needsYou.some(c => /^(fixlimit|homeowner-pr)-41$/.test(c.id)), JSON.stringify(v.panels.needsYou.map(c => c.id)));
  }
});
test('#405 fix limit: a CHANGES verdict recorded on an older head does not make the current head Needs you', async t => {
  const state = { ...fixLimitState(), verdicts: { [`41:${H(7)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: 1 } } };
  const v = await needsOf(await serve(t, { jobs: [], cache: calmCache(), state }));
  assert.ok(!v.panels.needsYou.some(c => c.id === 'fixlimit-41'));
});
// Issue #550: a review whose verdict file was refused shows the reason, the file and the next action.
test('#550 Needs you names the refused verdict file, the reason and what to do', async t => {
  const refusal = { count: 1, error: 'verdict has an unknown field', job: 'ab12cd34'.repeat(4), pr: 41, head: H(1), file: '/state/team/inbox/t1/verdict.json' };
  const maxed = { [`41:${H(1)}:codex`]: 2 };
  const v = await needsOf(await serve(t, { cache: calmCache(), state: { reviewAttempts: maxed, reviewRefusals: { [`41:${H(1)}:codex`]: refusal }, verdicts: {}, jobs: {} } }));
  const card = v.panels.needsYou.find(c => c.id === 'reviewrefused-41');
  assert.ok(card, 'a refused-verdict card ' + JSON.stringify(v.panels.needsYou.map(c => c.id)));
  assert.match(card.text, /verdict file was refused \(verdict has an unknown field\)/);
  assert.match(card.tried, /\/state\/team\/inbox\/t1\/verdict\.json/);
  assert.match(card.text, /review limit of 2 attempts is reached/, 'the card names the review limit when it is hit');
  assert.match(card.action, /Read the verdict file and the review job ab12cd34/);
  assert.ok(!v.panels.needsYou.some(c => c.id === 'reviewlimit-41'), 'one card, not two');
  const under = await needsOf(await serve(t, { cache: calmCache({ labels: ['needs-homeowner'] }), state: { reviewAttempts: { [`41:${H(1)}:codex`]: 0 }, reviewRefusals: { [`41:${H(1)}:codex`]: refusal }, verdicts: {}, jobs: {} } }));
  const ucard = under.panels.needsYou.find(c => c.id === 'reviewrefused-41');
  assert.ok(ucard, 'the under-limit refusal still makes a card ' + JSON.stringify(under.panels.needsYou.map(c => c.id)));
  assert.doesNotMatch(ucard.text, /review limit/);
  assert.match(ucard.text, /verdict has an unknown field/);
  const other = await needsOf(await serve(t, { cache: calmCache(), state: { reviewAttempts: maxed, reviewRefusals: { [`41:${H(2)}:codex`]: { ...refusal, head: H(2) } }, verdicts: {}, jobs: {} } }));
  assert.deepEqual(other.panels.needsYou.map(c => c.id), ['reviewlimit-41'], 'a refusal for another head does not apply');
});
test('#583 the PR card names the job holding needs-homeowner and the command that clears it', async t => {
  const state = { fixAttempts: {}, verdicts: {}, jobs: {}, unblock: { flags: { 41: { 'job:cb82e026aaaa0123456789abcdef0123': { key: 'job:cb82e026aaaa0123456789abcdef0123', kind: 'job', job: 'cb82e026aaaa0123456789abcdef0123', tk: 'pull' } } } } };
  const v = await needsOf(await serve(t, { cache: calmCache({ labels: ['needs-homeowner'] }), state }));
  const card = v.panels.needsYou.find(c => c.id === 'homeowner-pr-41');
  assert.match(card.tried, /job cb82e026/); assert.match(card.action, /ai-agent --supervisor resume cb82e026aaaa0123456789abcdef0123 /); assert.match(card.action, /unpushed/);
  const stopped = await needsOf(await serve(t, { jobs: [jb({ id: 'cb82e026aaaa0123456789abcdef0123', kind: 'rebase', issue: 41, status: 'stopped' })], cache: calmCache({ labels: ['needs-homeowner'] }), state }));
  const sc = stopped.panels.needsYou.find(c => c.id === 'homeowner-pr-41');
  assert.doesNotMatch(sc.action, /supervisor resume/, 'a stopped job cannot be resumed'); assert.match(sc.action, /stopped job cannot be resumed/); assert.match(sc.action, /inspect the job's worktree/);
  const plain = await needsOf(await serve(t, { cache: calmCache({ labels: ['needs-homeowner'] }), state: { fixAttempts: {}, verdicts: {}, jobs: {} } }));
  assert.doesNotMatch(plain.panels.needsYou.find(c => c.id === 'homeowner-pr-41').action, /supervisor resume/);
});
