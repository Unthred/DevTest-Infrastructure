// Issue #1219: the Inbox view switch. The pure logic, each renderer (long title, no result, apostrophe, waiting, done, failed),
// the same item ids in all three views for the same filter, and the real /inbox route.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { handler, STATIC } from '../supervisor/dashserver.mjs';
import { inboxViews, tableRow, compactRow } from '../supervisor/inbox-views.mjs';
import { COLUMNS, ageText, defaultView, rowOf, sanitizePrefs, sortRows, stateMark } from '../supervisor/dashui/inbox-views.mjs';
import { buildInbox, LONG_TITLE } from './helpers/inbox-views-fixture.mjs';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const ctx = { esc, highlight: esc };
const NOW = 1_000_000_000_000;
const rec = (o = {}) => ({ id: 'a'.repeat(32), kind: 'prompt', state: 'done', title: 'A title', createdAt: NOW - 3 * 86400000, text: 'done text', reason: 'done text', ...o });

test('every renderer keeps a long title whole and inside its cell', () => {
  const row = rowOf(rec({ title: LONG_TITLE }), NOW);
  assert.ok(LONG_TITLE.length > 150);
  assert.ok(tableRow(row, ctx).includes(esc(LONG_TITLE)));
  assert.ok(compactRow(row, ctx).includes(esc(LONG_TITLE)));
});
test('an item with no result shows a dash in the table and "No result yet" in the compact list', () => {
  const row = rowOf(rec({ state: 'done', text: '', reason: '' }), NOW);
  assert.equal(row.result, '');
  assert.match(tableRow(row, ctx), /<span class="iv-none">–<\/span>/);
  assert.match(compactRow(row, ctx), /No result yet/);
});
test('an apostrophe in a title is escaped in both renderers and never breaks an attribute', () => {
  const row = rowOf(rec({ title: "Tower's disk check, it can't start" }), NOW);
  for (const html of [tableRow(row, ctx), compactRow(row, ctx)]) { assert.ok(html.includes('Tower&#39;s disk check, it can&#39;t start')); assert.ok(!html.includes("Tower's")); }
});
test('a waiting, a done and a failed item each show their state, marker and the right text', () => {
  const waiting = rowOf(rec({ state: 'pending', text: 'Fix the link', reason: undefined }), NOW);
  const done = rowOf(rec({ text: 'No drift found.\nSecond line' , reason: 'No drift found.\nSecond line' }), NOW);
  const failed = rowOf(rec({ state: 'failed', reason: "It can't read the drive.", text: '' }), NOW);
  assert.deepEqual([waiting.result, waiting.prompt], ['', 'Fix the link']);
  assert.deepEqual([done.result, done.full.includes('Second line')], ['No drift found.', true]);
  assert.equal(failed.result, "It can't read the drive.");
  assert.deepEqual(['pending', 'done', 'failed', 'other'].map(s => stateMark(s)[1]), ['waiting', 'done', 'failed', 'other']);
  assert.match(compactRow(waiting, ctx), /iv-more-prompt/);
  assert.doesNotMatch(compactRow(waiting, ctx), /iv-more-result/);
  assert.match(compactRow(done, ctx), /Second line/);
  assert.match(tableRow(done, ctx), /No drift found\.<\/span>/);
  assert.doesNotMatch(tableRow(done, ctx), /Second line/, 'the table shows the first line only');
  assert.match(compactRow(failed, ctx), /data-state="failed"/);
});
test('the table has the six columns and the compact list has the marker, title, kind and age', () => {
  assert.deepEqual(COLUMNS.map(c => c.label), ['Title', 'Kind', 'State', 'Age', 'Source', 'Result']);
  const html = compactRow(rowOf(rec(), NOW), ctx);
  assert.match(html, /class="iv-mark"[\s\S]*class="iv-title"[\s\S]*class="iv-kind"[\s\S]*class="iv-age"/);
});
test('sorting by Age puts the newest first ascending and the oldest first descending; a missing age is last either way', () => {
  const rows = [rec({ id: 'o', createdAt: 1000 }), rec({ id: 'n', createdAt: 9000 }), rec({ id: 'x', createdAt: null })].map(r => rowOf(r, 10000));
  assert.deepEqual(sortRows(rows, 'age', 'asc').map(r => r.id), ['n', 'o', 'x']);
  assert.deepEqual(sortRows(rows, 'age', 'desc').map(r => r.id), ['o', 'n', 'x']);
  assert.deepEqual(sortRows(rows, 'nope', 'asc').map(r => r.id), ['o', 'n', 'x'], 'an unknown column keeps the order');
  assert.equal(ageText(NOW - 90_000, NOW), '1 min');
  assert.equal(ageText(null, NOW), '–');
});
test('saved preferences: phone defaults to Compact list, desktop to Table; junk is dropped; at least one column stays', () => {
  assert.deepEqual([defaultView(true), defaultView(false)], ['compact', 'table']);
  assert.equal(sanitizePrefs(null, { phone: true }).view, 'compact');
  assert.equal(sanitizePrefs({ view: 'cards' }, { phone: true }).view, 'cards', 'a saved choice wins over the default');
  assert.equal(sanitizePrefs({ view: 'bogus' }).view, 'table');
  assert.deepEqual(sanitizePrefs({ hidden: ['source', 'nope', 'source'] }).hidden, ['source']);
  assert.deepEqual(sanitizePrefs({ hidden: COLUMNS.map(c => c.key) }).hidden, []);
  assert.deepEqual(sanitizePrefs({ widths: { title: 5, kind: 99999, state: 'x', age: 120.4 } }).widths, { title: 48, kind: 800, age: 120 });
});

const idsIn = (html, re) => [...html.matchAll(re)].map(m => m[1]);
test('the three views list the same item ids in the same order for the same filter', () => {
  const records = ['c', 'a', 'b'].map((c, i) => rec({ id: c.repeat(32), title: `Item ${c}`, createdAt: NOW - i * 1000 }));
  const cardsHtml = `<ul>${records.map(r => `<li class="inbox-item" data-inbox="${r.id}"></li>`).join('')}</ul>`;
  const html = inboxViews({ records, now: NOW, ...ctx, cardsHtml });
  const cards = idsIn(html, /data-inbox="([a-f0-9]{32})"/g), table = idsIn(html, /<tr data-id="([a-f0-9]{32})"/g), compact = idsIn(html, /<li class="iv-crow" data-id="([a-f0-9]{32})"/g);
  assert.deepEqual(cards, records.map(r => r.id));
  assert.deepEqual(table, cards);
  assert.deepEqual(compact, cards);
});
test('only the Cards pane is visible without script', () => {
  const html = inboxViews({ records: [rec()], now: NOW, ...ctx, cardsHtml: '<ul></ul>' });
  assert.match(html, /<div data-pane="cards"><ul><\/ul>/);
  assert.match(html, /data-pane="table" hidden/);
  assert.match(html, /data-pane="compact" hidden/);
});

// ---- the real /inbox route
async function serve(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iv1219-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [] }));
  const inboxDir = path.join(root, 'inbox');
  buildInbox(inboxDir);
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } }, inbox: { dir: inboxDir } };
  const server = http.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const port = server.address().port;
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  const get = p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject));
  return { get };
}
test('GET /inbox serves the switch and the three views with the same ids, and the filters apply to all three', async t => {
  const s = await serve(t);
  const all = await s.get('/inbox?state=all');
  assert.equal(all.status, 200);
  assert.match(all.body, /Inbox/);
  for (const label of ['Cards', 'Table', 'Compact list']) assert.ok(all.body.includes(`>${label}</button>`), label);
  const ids = html => ({ cards: idsIn(html, /class="inbox-item" id="att-inbox-([a-f0-9]{32})"/g), table: idsIn(html, /<tr data-id="([a-f0-9]{32})"/g), compact: idsIn(html, /<li class="iv-crow" data-id="([a-f0-9]{32})"/g) });
  const a = ids(all.body);
  assert.ok(a.cards.length >= 5);
  assert.deepEqual(a.table, a.cards);
  assert.deepEqual(a.compact, a.cards);
  for (const q of ['?state=done', '?state=all&search=drift', '?kind=issue_draft&state=done']) {
    const f = ids((await s.get(`/inbox${q}`)).body);
    assert.deepEqual(f.table, f.cards, q);
    assert.deepEqual(f.compact, f.cards, q);
    assert.ok(f.cards.length < a.cards.length && f.cards.length > 0, q);
  }
  assert.ok(all.body.includes('Tower&#39;s disk check'), 'an apostrophe is escaped on the real page');
});
test('the Inbox scripts and the shared column rules are served as scripts', () => {
  assert.equal(STATIC['/static/inbox-views.mjs'][1], 'text/javascript; charset=utf-8');
  assert.equal(STATIC['/static/inbox-views-ui.mjs'][0], 'inbox-views-ui.mjs');
  assert.equal(STATIC['/static/table-columns.mjs'][0], 'table-columns.mjs');
});
