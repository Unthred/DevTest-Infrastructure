// Dashboard v2 polish part 2 (issue #61): collapsing cards, in-place table updates, live filters, page size without Apply,
// back to top, status colours, clickable header pills. Pure logic directly (the browser runs the same module); pages through the
// real renderer and request handler; the script's structure is checked statically (a real-browser run is listed in the PR).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { FILTER_DEBOUNCE_MS, applyLayout, countText, debounce, filterRows, mergeTableParams, pillLinks, sanitizeCollapsed, showBackToTop, tableChange, tableState, toggleCollapsed, versionStatus } from '../supervisor/dashui/logic.mjs';
import { currentView, handler } from '../supervisor/dashserver.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const H = n => String(n).repeat(40).slice(0, 40);
const read = f => fs.readFileSync(new URL(`../supervisor/dashui/${f}`, import.meta.url), 'utf8');
const css = read('style.css'), appJs = read('app.js');
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } }
};
const cache = (tick = { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }) => ({ tick, fetchedAt: NOW - 60000, delivered: [],
  pulls: [
    { number: 41, title: 'Alpha pull', headRefName: 'claude/issue-30-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    { number: 42, title: 'Beta pull', headRefName: 'codex/issue-2-y', headRefOid: H(2), baseRefName: 'main', isDraft: true, mergeable: 'MERGEABLE', statusCheckRollup: [] }],
  issues: [{ number: 30, title: 'Thirty', state: 'OPEN', labels: [], prerequisites: [5] }, { number: 5, title: 'Five', state: 'OPEN', labels: [], prerequisites: [] }] });
async function serve(t, { link, tick, upgrades = [], latch } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash61-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache(tick)));
  if (link) fs.symlinkSync(`versions/${link}`, path.join(root, 'current'));
  if (upgrades.length) fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), upgrades.map(u => JSON.stringify(u)).join('\n') + '\n');
  if (latch) fs.writeFileSync(path.join(root, 'team', 'self-upgrade.latch'), JSON.stringify(latch));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => NOW }));
  return { root, get: p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject)) };
}

// ---- 4. live filter: number, title, agent, status
const rows = [
  { number: 41, name: 'PR #41 Alpha', title: 'Alpha pull', agent: 'claude', status: 'open' },
  { number: 42, name: 'PR #42 Beta', title: 'Beta pull', agent: 'codex', status: 'draft' },
  { number: 143, name: 'PR #143 Gamma', title: 'Gamma', agent: 'claude', status: 'merged' }];
const keys = ['name', 'title', 'agent', 'status', 'number'];
test('filter matches number, title, agent and status, case-insensitively; #41 matches the number as the page shows it', () => {
  const nums = q => filterRows(rows, q, keys).map(r => r.number);
  assert.deepEqual(nums('alpha'), [41]); assert.deepEqual(nums('BETA'), [42]);        // title
  assert.deepEqual(nums('codex'), [42]); assert.deepEqual(nums('claude'), [41, 143]); // agent
  assert.deepEqual(nums('draft'), [42]); assert.deepEqual(nums('merged'), [143]);     // status
  assert.deepEqual(nums('42'), [42]); assert.deepEqual(nums('#41'), [41]); assert.deepEqual(nums('14'), [143]); // number
  assert.deepEqual(nums('  '), [41, 42, 143], 'blank filter shows everything'); assert.deepEqual(nums('zzz'), [], 'nothing matches');
});
test('the footer says "n of m": n rows match the filter, m rows exist', () => {
  const st = tableState(rows, { q: 'claude', searchKeys: keys }); assert.equal(st.total, 2); assert.equal(st.all, 3);
  assert.equal(countText(st.total, st.all, 'pull requests'), '2 of 3 pull requests');
  assert.equal(tableState(rows, { searchKeys: keys }).all, 3);
});
test('the Work tables filter by number, title, agent and status on the real page, with "n of m" in the footer', async t => {
  const s = await serve(t);
  const pr = async q => (await s.get(`/work?${q}`)).body;
  const only = (body, id) => body.slice(body.indexOf(`data-table="${id}"`), body.indexOf('</table>', body.indexOf(`data-table="${id}"`)));
  const alpha = only(await pr('prs.q=thirty'), 'prs');
  assert.match(alpha, /1 of 2 pull requests/); assert.match(alpha, /href="\/work\/pr\/41"/); assert.doesNotMatch(alpha, /href="\/work\/pr\/42"/);
  assert.match(only(await pr('prs.q=codex'), 'prs'), /href="\/work\/pr\/42"/); assert.match(only(await pr('prs.q=draft'), 'prs'), /1 of 2 pull requests/);
  assert.match(only(await pr('prs.q=%2342'), 'prs'), /href="\/work\/pr\/42"/);
  assert.match(only(await pr('prs.q=nomatch'), 'prs'), /0 of 2 pull requests/); assert.match(await pr('prs.q=nomatch'), /No pull requests match the filter/);
  assert.match(only(await pr('issues.q=thirty'), 'issues'), /1 of 2 issues/); assert.match(only(await pr('issues.q=claude'), 'issues'), /2 of 2 issues/);
  assert.match(only(await pr('issues.q=thirty'), 'prs'), /2 of 2 pull requests/, 'the other table is untouched');
});

// ---- 5. page size applies on change; there is no Apply button anywhere
test('items per page: the selector is wired to apply on change, honours every offered size and ignores others; no Apply button exists on any page', async t => {
  const s = await serve(t);
  for (const p of ['/', '/work', '/agents', '/agents/claude', '/activity', '/usage', '/reviews', '/system', '/supervisor', '/supervisor/ticks', '/supervisor/upgrades']) {
    const body = (await s.get(p)).body; assert.doesNotMatch(body, />\s*Apply\s*</i, `${p}: no Apply button`); assert.doesNotMatch(body.replace(/<form method="post" action="\/(?:mark-read|watch|probe\/[\w-]+)".*?<\/form>/gs, ''), /<button[^>]*type="submit"/, `${p}: no submit button besides Mark as read (issue #253) , Refresh allowance (issue #110) and Watch (issue #430)`);
  }
  const body = (await s.get('/work?prs.size=10')).body; assert.match(body, /name="prs\.size"[^>]*>[^]*?<option selected>10<\/option>/);
  assert.equal(tableState(Array.from({ length: 60 }, (_, i) => ({ i })), { pageSize: 10 }).rows.length, 10);
  assert.equal(tableState(Array.from({ length: 60 }, (_, i) => ({ i })), { pageSize: 50 }).rows.length, 50);
  assert.equal(tableState(Array.from({ length: 60 }, (_, i) => ({ i })), { pageSize: 7 }).rows.length, 25, 'an unoffered size falls back to the default');
  // the script applies a change at once, back on page 1, keeping the filter
  assert.match(appJs, /\$\('select', region\)\?\.addEventListener\('change'/); assert.match(appJs, /tableChange\(location\.search, id, \{ size: e\.target\.value/);
  assert.equal(tableChange('prs.q=a&prs.page=3&issues.page=2', 'prs', { size: 50, q: 'a' }), 'prs.q=a&issues.page=2&prs.size=50', 'page size resets that table to page 1 and keeps other tables');
});

// ---- 2. updates happen in place, scroll is kept
test('table state changes are merged per table into the current address, so a sort, filter, page or size change touches only that table', () => {
  assert.equal(mergeTableParams('prs.q=a&issues.sort=number', '/work?prs.sort=tokens&prs.dir=desc&prs.page=1'.split('?')[1], 'prs'), 'issues.sort=number&prs.sort=tokens&prs.dir=desc&prs.page=1');
  assert.equal(mergeTableParams('prs.q=a', 'prs.page=2&issues.q=x', 'prs'), 'prs.page=2', 'a link only contributes its own table, and the old state of that table is replaced');
  assert.equal(mergeTableParams('range=7d&prs.size=50', 'prs.size=10', 'prs'), 'range=7d&prs.size=10');
  assert.equal(tableChange('', 'prs', { q: 'x' }), 'prs.q=x'); assert.equal(tableChange('prs.q=x&prs.page=4', 'prs', { q: '' }), '', 'an empty filter removes the parameter and resets the page');
  assert.equal(tableChange('prs.page=2', 'prs', { page: 3 }), 'prs.page=3');
});
test('the script updates tables in place: one same-origin fetch, no navigation unless it fails, scroll and focus kept, address follows', () => {
  assert.match(appJs, /\.replaceWith\(\$\('\[data-tdata\]', next\)\)/); assert.match(appJs, /history\.replaceState\(/); assert.match(appJs, /scrollTo\(scrollX, y\)/);
  assert.match(appJs, /catch \{ if \(tableSeq\.get\(id\) === seq\) fallbackNavigate\(url\); \}/, 'a failure falls back to a normal navigation');
  const fb = /function fallbackNavigate[\s\S]*?\n\}/.exec(appJs)[0]; assert.match(fb, /sessionStorage\.setItem\('dash\.scroll\./, 'the scroll position is stored for the address it is about to open'); assert.match(fb, /scrollY/);
  assert.equal((appJs.match(/location\.assign\(/g) || []).length, 1, 'location.assign is used only in that fallback');
  assert.match(appJs, /tableSeq\.get\(id\) !== seq\) return/, 'a slower, older response never overwrites a newer one');
  assert.match(appJs, /e\.preventDefault\(\); typed\.cancel\(\);\s*loadTable\(region, mergeTableParams/, 'sort and page links are intercepted');
  assert.match(appJs, /e\.button > 0 \|\| e\.metaKey \|\| e\.ctrlKey/, 'open-in-new-tab clicks keep working');
  const body = fs.readFileSync(new URL('../supervisor/dashrender.mjs', import.meta.url), 'utf8');
  assert.match(body, /data-tregion/); assert.match(body, /data-tdata/);
});
test('the table markup is replaceable: data-tregion wraps the bar and data-tdata holds the rows, footer and pager', async t => {
  const s = await serve(t); const body = (await s.get('/work')).body;
  for (const id of ['prs', 'issues']) assert.match(body, new RegExp(`<div class="tregion" data-tregion="${id}"><form class="tbar"[^>]*>[\\s\\S]*?</form><div data-tdata><div class="tbl-wrap"><table data-table="${id}">[\\s\\S]*?<nav class="pager"[\\s\\S]*?</nav></div></div>`));
  assert.match(body, /<span data-tclear>/);
});
test('debounce: a burst of keystrokes causes one update after the pause, and cancel drops it', () => {
  const calls = [], timers = []; let id = 0;
  const clock = { set: (fn, ms) => { timers.push({ fn, ms, id: ++id, live: true }); return id; }, clear: n => { const x = timers.find(t => t.id === n); if (x) x.live = false; } };
  const d = debounce(v => calls.push(v), FILTER_DEBOUNCE_MS, clock);
  d('a'); d('al'); d('alp');
  assert.equal(timers.length, 3); assert.equal(timers.filter(t => t.live).length, 1, 'only the last timer is alive'); assert.equal(timers[2].ms, FILTER_DEBOUNCE_MS);
  timers.filter(t => t.live).forEach(t => { t.live = false; t.fn(); }); assert.deepEqual(calls, ['alp']);
  d('x'); d.cancel(); timers.filter(t => t.live).forEach(t => t.fn()); assert.deepEqual(calls, ['alp'], 'cancelled');
  assert.ok(FILTER_DEBOUNCE_MS >= 150 && FILTER_DEBOUNCE_MS <= 500);
});

// ---- 1. collapse cards
test('collapsing is saved per breakpoint with the layout; unknown, duplicate and malformed saved ids are dropped', () => {
  assert.deepEqual(toggleCollapsed([], 'a'), ['a']); assert.deepEqual(toggleCollapsed(['a', 'b'], 'a'), ['b']); assert.deepEqual(toggleCollapsed(undefined, 'z'), ['z']);
  assert.deepEqual(sanitizeCollapsed(['a', 'a', 'gone', 7, null], ['a', 'b']), ['a']); assert.deepEqual(sanitizeCollapsed('a', ['a']), []);
  const saved = { order: ['b'], collapsed: ['a'] };
  assert.deepEqual(applyLayout(['a', 'b'], saved, 'desktop').collapsed, ['a']); assert.deepEqual(applyLayout(['a', 'b'], saved, 'phone').collapsed, ['a'], 'collapsing also applies on a phone');
  assert.deepEqual(applyLayout(['b'], saved, 'desktop').collapsed, [], 'a card that no longer exists is forgotten');
  assert.match(appJs, /dash\.layout\.\$\{layoutPage\}\.\$\{bpNow\(\)\}/, 'the same per-breakpoint key as the layout');
});
test('every card has a chevron (hidden until the script runs, labelled, aria-expanded); a double-click on the header and the chevron both toggle', async t => {
  const s = await serve(t);
  for (const p of ['/', '/work', '/system', '/supervisor']) {
    const body = (await s.get(p)).body, cards = body.split('<section ').slice(1);
    assert.ok(cards.length >= 2, p);
    for (const c of cards) {
      assert.match(c, /<button class="tbtn" type="button" data-collapse aria-expanded="true" aria-label="Collapse [^"]+"[^>]* hidden>/, `${p}: chevron`);
      assert.match(c, / id="c-[^"]+"/, `${p}: card has an anchor`);
    }
  }
  assert.match(appJs, /addEventListener\('dblclick'/); assert.match(appJs, /closest\?\.\('\.card > header'\)/); assert.match(appJs, /e\.target\.closest\('button,a,input,select,textarea,\.resize'\)/, 'a double-click on a control in the header does not collapse');
  assert.match(appJs, /closest\?\.\('\[data-collapse\]'\)/); assert.match(appJs, /setAttribute\('aria-expanded', String\(!on\)\)/);
  assert.match(css, /\.card\.collapsed>\*:not\(header\)\{display:none!important\}/); assert.match(css, /\.card\.collapsed\{min-height:0\}/);
});
test('a pill that targets a collapsed card opens it, and the layout editor keeps the collapsed state', () => {
  assert.match(appJs, /function revealTarget\(\)[\s\S]*?closest\?\.\('\.card\.collapsed'\)[\s\S]*?toggleCard\(c\)/); assert.match(appJs, /addEventListener\('hashchange', revealTarget\)/);
  assert.match(appJs, /saveFlow = \(\) => store\.set\(key\(\), \{ \.\.\.lay, collapsed: readCollapsed\(\) \}\)/, 'reordering on a phone does not lose the collapsed state');
  assert.match(appJs, /persist = \(\) => \{ if \(st\) store\.set\(key\(\), toSaved\(st, readCollapsed\(\)\)\); \}/, 'moving or resizing a card does not lose the collapsed state');
});

// ---- 3. back to top
test('back to top: appears after scrolling, is a labelled button, smooth unless reduced motion, never covers the phone tab bar', async t => {
  assert.equal(showBackToTop(0), false); assert.equal(showBackToTop(400), false); assert.equal(showBackToTop(401), true); assert.equal(showBackToTop(NaN), false); assert.equal(showBackToTop(undefined), false);
  const s = await serve(t); const body = (await s.get('/')).body;
  assert.match(body, /<button type="button" id="to-top" class="to-top" aria-label="Back to top" title="Back to top" hidden>/);
  assert.match(appJs, /behavior: matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches \? 'auto' : 'smooth'/); assert.match(appJs, /btn\.hidden = !showBackToTop\(scrollY\)/);
  assert.match(appJs, /main\.focus\(\{ preventScroll: true \}\)/, 'keyboard focus returns to the page start');
  assert.match(css, /\.to-top\{position:fixed;[^}]*width:44px;height:44px/);
  const phone = /@media\(max-width:639px\)\{\.to-top\{bottom:calc\(var\(--nav-h\)/.test(css); assert.ok(phone, 'on a phone it sits above the bottom tab bar');
  assert.match(css, /html\[data-dock=bottom\] \.to-top\{bottom:calc\(var\(--nav-h\)/);
});

// ---- 6. status colours
test('version status: up to date is green, deploy/restart needed is amber with a label, failed or latched is red, unknown is neutral', () => {
  const v = o => ({ installed: H(1), main: H(1), drift: false, running: H(1), result: 'verified', latched: false, ...o });
  assert.deepEqual([versionStatus(v()).level, versionStatus(v()).label], ['ok', 'Up to date (1111111)']);
  assert.equal(versionStatus(v({ running: null })).level, 'ok', 'an unknown running version is not an alarm');
  const dep = versionStatus(v({ main: H(2), drift: true })); assert.equal(dep.level, 'warning'); assert.match(dep.label, /^Deploy needed: 1111111 → 2222222$/);
  const rst = versionStatus(v({ running: H(3) })); assert.equal(rst.level, 'warning'); assert.match(rst.label, /^Restart needed: 3333333 running, 1111111 installed$/);
  for (const result of ['rolled_back', 'rollback_failed']) { const f = versionStatus(v({ result })); assert.equal(f.level, 'action'); assert.match(f.label, /^Upgrade failed/); }
  assert.equal(versionStatus(v({ latched: true })).level, 'action'); assert.match(versionStatus(v({ latched: true })).label, /latched/);
  assert.equal(versionStatus(v({ latched: true, drift: true, main: H(2) })).level, 'action', 'red wins over amber');
  assert.equal(versionStatus(null).level, 'info');
  assert.equal(versionStatus(v({ result: 'refused' })).level, 'ok', 'a refused attempt on its own, with nothing to deploy, is not an alarm');
});
test('the header and the System page show the same version severity; a latch in the real state is red', async t => {
  const up = await serve(t, { link: H(5) });
  // issue #924: the version left the app bar; the System page is its one place
  const bar = b => b.slice(b.indexOf('class="statusbar"'), b.indexOf('<nav class="nav"'));
  const ok = (await up.get('/')).body; assert.doesNotMatch(bar(ok), /Version<|Up to date/, 'the app bar no longer carries the version');
  assert.match((await up.get('/system')).body, /<dt>State<\/dt><dd><span class="badge sev-ok[^>]*>[^]*?Up to date/);
  const failed = await serve(t, { link: H(5), upgrades: [{ at: NOW - 3600000, from: H(5), to: H(6), result: 'rolled_back', reason: 'live tick failed' }] });
  const fsys = (await failed.get('/system')).body; assert.match(fsys, /<dt>State<\/dt><dd><span class="badge sev-action[^>]*>[^]*?Upgrade failed/);
  const latched = await serve(t, { link: H(5), latch: { at: NOW - 1000, from: H(5), to: H(6), reason: 'rollback' } });
  const view = await currentView({ root: latched.root, config, now: NOW });
  if (view.version.latched) assert.match((await latched.get('/system')).body, /<dt>State<\/dt><dd><span class="badge sev-action[^>]*>[^]*?latched/);
  assert.equal(typeof view.version.latched, 'boolean', 'the view carries the latch');
});

// ---- 7. clickable header pills
test('pill targets: Inbox → that item, Stuck / Tick error / Data → the tick card, Version → the version card, Team loop → dispatcher facts', () => {
  const att = (...a) => a.map(([id, severity]) => ({ id, severity }));
  assert.equal(pillLinks({ health: { state: 'needs_you' }, attention: att(['ci-4', 'warning'], ['homeowner-9', 'action']) }).health, '/system#att-homeowner-9');
  assert.equal(pillLinks({ health: { state: 'stuck' }, attention: att(['tick-stale', 'warning']) }).health, '/supervisor#c-h-tick');
  assert.equal(pillLinks({ health: { state: 'stuck' }, attention: att(['idle-claude', 'warning']) }).health, '/system#att-idle-claude');
  assert.equal(pillLinks({ health: { state: 'running' }, attention: [] }).health, '/agents');
  const l = pillLinks({ health: { state: 'idle' }, version: { installed: H(1), main: H(1) } });
  assert.deepEqual([l.tick, l.data, l.team, l.version], ['/supervisor#c-h-tick', '/supervisor#c-h-tick', '/system#c-sys', '/supervisor#c-h-version']);
});
test('every header pill is a link, and each link lands on an element that exists on the target page, highlighted with :target', async t => {
  const s = await serve(t, { link: H(5), tick: { at: NOW - 60000, status: 'error', error: 'boom: cannot read x', lastOkAt: NOW - 7200000 } });
  const home = (await s.get('/')).body, bar = home.slice(home.indexOf('class="statusbar"'), home.indexOf('<nav class="nav"'));
  const hrefs = [...bar.matchAll(/<a class="pill" href="([^"]+)"/g)].map(m => m[1]);
  assert.equal(hrefs.length, 2, 'health and last tick (data, team loop and version moved to the System page, issue #924)');
  for (const h of hrefs) {
    const [p, frag] = h.split('#'); const page = (await s.get(p)).body;
    assert.equal(page.includes(`id="${frag}"`), true, `${h}: target exists`);
  }
  const tickPill = new RegExp(`<a class="pill" href="/supervisor#c-h-tick"[^>]*><span class="badge sev-action[^>]*>[^]*?Tick error`); assert.match(bar, tickPill);
  assert.match(css, /li:target\{outline/); assert.match(css, /\.card:target\{outline/);
  // a "Inbox" item: the pill leads to the exact item and that item carries the anchor
  const needs = (await s.get('/')).body.match(/Inbox \(\d+\)/);
  const view = await currentView({ root: s.root, config, now: NOW });
  const first = view.attention.find(a => a.severity === 'action');
  if (needs && first) { const link = /<a class="pill" href="([^"]+)"[^>]*><span class="badge sev-action[^>]*>[^]*?Inbox/.exec(bar)[1]; assert.equal(link, `/system#att-${first.id}`); assert.match((await s.get('/system')).body, new RegExp(`<li class="sev-action" id="att-${first.id}"`)); }
  assert.ok(needs && first, 'the tick error produced a Inbox item');
});
test('pills are keyboard reachable links with a visible focus ring and an explanatory title', async t => {
  const s = await serve(t); const body = (await s.get('/')).body;
  assert.ok([...body.matchAll(/<a class="pill" href="[^"]+" title="[^"]+">/g)].length >= 2);
  assert.match(css, /a\.pill:focus-visible\{outline-offset/); assert.match(css, /:focus-visible\{outline:3px solid var\(--focus\)/);
});
test('renderRoute still escapes everything in the new markup', () => {
  const v = { generatedAt: NOW, health: { state: 'idle', label: '<b>x</b>', severity: 'ok' }, attention: [{ id: 'x"><i>', severity: 'action', text: 'T', ref: null }], panels: { needsYou: [{ id: 'x"><i>', text: 'T', severity: 'action', decision: 'd' }], warnings: [], next: [] }, agents: [], tick: null, freshness: { level: 'ok', label: 'Fresh' }, version: null, graphs: { allowance: {} }, queues: {}, issues: [], prs: [], jobs: [], usage: {}, refs: {} };
  const html = renderRoute(v, { page: 'system' }).html;
  assert.doesNotMatch(html, /<i>/); assert.doesNotMatch(html, /<b>x<\/b>/);
});

test('the periodic refresh is script-driven so it keeps an in-place table address (issue #61)', async t => {
  const html = (await (await serve(t)).get('/work')).body;
  assert.match(html, /<noscript><meta http-equiv="refresh" content="60"><\/noscript>/);
  assert.doesNotMatch(html.replace(/<noscript>.*?<\/noscript>/s, ''), /http-equiv="refresh"/);
  assert.match(appJs, /startRefresh\(\{/); assert.doesNotMatch(appJs, /location\.reload\(\)/, 'no timed full reload (issue #930)');
  assert.doesNotMatch(appJs, /\bscrollKey\b/);   // the key is computed from the current address at save and restore time
  assert.match(appJs, /scrollKeyNow\(\)/);
});

test('debounce: the default timers call setTimeout unbound (a browser throws Illegal invocation otherwise)', async () => {
  const real = globalThis.setTimeout, realClear = globalThis.clearTimeout, seen = [];
  globalThis.setTimeout = function (f, ms) { seen.push(this); return real(f, ms); };
  globalThis.clearTimeout = function (t) { seen.push(this); return realClear(t); };
  try {
    const calls = [], d = debounce(v => calls.push(v), 5);
    d(1); d(2);
    await new Promise(r => real(r, 40));
    assert.deepEqual(calls, [2]);
    assert.ok(seen.every(t => t === undefined || t === globalThis), 'setTimeout/clearTimeout must not be called with the timers object as this');
  } finally { globalThis.setTimeout = real; globalThis.clearTimeout = realClear; }
});
