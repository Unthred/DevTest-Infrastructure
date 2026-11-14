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
import { COLUMNS, ageText, decisionForms, defaultView, rowOf, sanitizePrefs, sortRows, stateMark } from '../supervisor/dashui/inbox-views.mjs';
import { buildInbox, LONG_TITLE } from './helpers/inbox-views-fixture.mjs';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const fakeForm = (id, decision, label, cls) => `<form class="inbox-form"><button class="btn ${cls}">${label}</button></form>`;
const ctx = { esc, highlight: esc, form: fakeForm };
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
test('the table has the six columns and the compact list has the chips, title and the age and source text', () => {
  assert.deepEqual(COLUMNS.map(c => c.label), ['Kind', 'State', 'Title', 'Age', 'Source', 'Result']);
  const html = compactRow(rowOf(rec(), NOW), ctx);
  assert.match(html, /class="iv-chips"[\s\S]*class="iv-title"[\s\S]*class="iv-age"[\s\S]*class="iv-source"/);
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
  const cards = idsIn(html, /<li class="inbox-item" data-inbox="([a-f0-9]{32})"/g), table = idsIn(html, /<tr data-id="([a-f0-9]{32})"/g), compact = idsIn(html, /<li class="iv-crow" data-id="([a-f0-9]{32})"/g);
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
async function serve(t, jobs = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iv1219-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [] }));
  for (const job of jobs) fs.writeFileSync(path.join(root, 'jobs', `${job.id}.json`), JSON.stringify(job));
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

// ---- Issue #1262: Approve and Reject on table and compact rows
const rctx = ctx;
const formsIn = html => [...html.matchAll(/<form /g)].length;
const rowFor = o => rowOf(rec({ state: 'pending', ...o }), NOW);
test('a waiting item renders both forms in a table row and in a compact row, outside the expanding part', () => {
  const row = rowFor({});
  for (const html of [tableRow(row, rctx), compactRow(row, rctx)]) {
    assert.equal(formsIn(html), 2);
    assert.match(html, /inbox-approve[\s\S]*inbox-reject/);
    assert.match(html, /class="inbox-err" role="alert" hidden/);
    assert.match(html, /class="inbox-outcome" hidden/);
    assert.ok(html.includes(`data-inbox="${row.id}"`));
  }
  assert.doesNotMatch(compactRow(row, rctx).match(/<div class="iv-more">[^]*?<\/details>/)[0], /<form/, 'the buttons are not inside the expanding part');
  assert.match(compactRow(row, rctx), /<\/details><div class="acts iv-acts">/);
});
test('the Actions column is last, is not in COLUMNS and has no sort button or grip', () => {
  const html = inboxViews({ records: [rec({ state: 'pending' })], now: NOW, ...rctx, cardsHtml: '' });
  assert.ok(!COLUMNS.some(c => c.key === 'actions'));
  assert.match(html, /<th scope="col" data-col="actions">Actions<\/th><\/tr><\/thead>/);
  assert.doesNotMatch(html, /data-sort="actions"|data-grip="actions"|<input type="checkbox" data-col="actions"/);
  assert.match(tableRow(rowFor({}), rctx), /<td data-col="actions"[^>]*><div class="acts iv-acts">[^]*<\/td><\/tr>$/);
});
test('a done item, a failed item and an item with a decision render no forms and an empty Actions cell', () => {
  for (const o of [{ state: 'done' }, { state: 'failed' }, { decision: 'approve' }]) {
    const row = rowFor(o);
    assert.equal(formsIn(tableRow(row, rctx)) + formsIn(compactRow(row, rctx)), 0, JSON.stringify(o));
    assert.match(tableRow(row, rctx), /<td data-col="actions" data-label="Actions"><\/td>/);
    assert.doesNotMatch(compactRow(row, rctx), /inbox-outcome/);
  }
});
test('a broken waiting item renders Reject only', () => {
  const row = rowFor({ broken: true });
  for (const html of [tableRow(row, rctx), compactRow(row, rctx)]) { assert.equal(formsIn(html), 1); assert.match(html, /inbox-reject/); assert.doesNotMatch(html, /inbox-approve/); }
});
test('an apostrophe in a waiting title keeps the rows well formed', () => {
  const row = rowFor({ title: "Tower's \"disk\" <check>" });
  for (const html of [tableRow(row, rctx), compactRow(row, rctx)]) {
    assert.ok(html.includes('Tower&#39;s &quot;disk&quot; &lt;check&gt;'));
    assert.equal(formsIn(html), 2);
    assert.equal((html.match(/<(tr|li)[ >]/g) || []).length, 1);
  }
});
test('the card and the rows share one rule: the same item gets the same buttons from decisionForms', () => {
  for (const o of [{}, { broken: true }, { state: 'done' }, { decision: 'reject' }]) {
    const item = rec({ state: 'pending', ...o }), forms = decisionForms(item, fakeForm), viaRow = decisionForms(rowOf(item, NOW), fakeForm);
    assert.deepEqual(viaRow, forms, JSON.stringify(o));
    assert.equal(formsIn(tableRow(rowOf(item, NOW), rctx)), Number(!!forms.approve) + Number(!!forms.reject));
  }
});
test('the real /inbox page puts the buttons on the Draftchain draft in all three views and none on the Driftcheck prompt', async t => {
  const s = await serve(t);
  const body = (await s.get('/inbox?state=all')).body;
  const table = body.match(/<tbody>[^]*?<\/tbody>/)[0], compact = body.match(/<ul class="iv-compact"[^]*?<\/ul>/)[0];
  const rowOfTitle = (html, re, title) => html.match(re).find(r => r.includes(title));
  for (const [html, re] of [[table, /<tr [^]*?<\/tr>/g], [compact, /<li class="iv-crow"[^]*?<\/li>/g]]) {
    assert.equal(formsIn(rowOfTitle(html, re, 'Draftchain')), 2);
    assert.equal(formsIn(rowOfTitle(html, re, 'Driftcheck')), 0);
  }
});
test('showOutcomeInViews writes the outcome into every view of the item and drops the buttons of the list views only', async () => {
  const { showOutcomeInViews } = await import('../supervisor/dashui/inbox-ui.mjs');
  const view = (id, cls) => {
    const attrs = {}, acts = { gone: false, remove() { this.gone = true; } }, outcome = { hidden: true, className: '', setAttribute: (k, v) => { attrs[k] = v; } };
    return { dataset: { inbox: id }, classList: { contains: c => c === cls }, querySelector: s => (s === '.inbox-outcome' ? outcome : acts), outcome, acts, attrs };
  };
  const card = view('x', 'inbox-item'), row = view('x', 'iv-crow'), tr = view('x', 'iv-row'), other = view('y', 'iv-crow');
  const localized = [];
  showOutcomeInViews({ querySelectorAll: () => [card, row, tr, other] }, { id: 'x', decision: 'approve', decidedAt: 5, pressed: card, localize: v => localized.push(v) });
  assert.deepEqual([card, row, tr].map(v => v.outcome.hidden), [false, false, false]);
  assert.equal(card.outcome.className, 'inbox-outcome approved');
  assert.match(card.attrs['data-tpl'], /Approved/);
  assert.deepEqual([card.acts.gone, row.acts.gone, tr.acts.gone], [false, true, true], 'the pressed card moves to Decided; the rows lose their buttons');
  assert.deepEqual([other.outcome.hidden, other.acts.gone], [true, false], 'another item is untouched');
  assert.equal(localized.length, 3);
});

test('lowerWaitingChip lowers the waiting chip by one and stops at zero', async () => {
  const { lowerWaitingChip } = await import('../supervisor/dashui/inbox-ui.mjs');
  const n = { textContent: '1' };
  const doc = { querySelector: sel => (sel === '[data-chip="state:waiting"] .qf-n' ? n : null) };
  lowerWaitingChip(doc);
  assert.equal(n.textContent, '0');
  lowerWaitingChip(doc);
  assert.equal(n.textContent, '0');
  assert.doesNotThrow(() => lowerWaitingChip({ querySelector: () => null }));
});

// Issue #1466: the Running button lists the jobs running now. Real data of 14 Nov 2026, 16:15 UTC.
const { runningJobRecords, runningView } = await import('../supervisor/inbox-running.mjs');
const { inboxPage } = await import('../supervisor/inbox-page.mjs');
const { placeholderIssue } = await import('../supervisor/inbox.mjs');
const AT = Date.UTC(2026, 10, 14, 16, 15);
const REVIEW_NAME = 'Review follow-ups: foreman-mcp (#1433)';
const ABOUT_NAME = 'About box in the web UI shows the version and a collapsible plain words list of what is new Aboutpanel';
const jobRow = (o = {}) => ({
  id: 'abcd1234', fullId: 'abcd1234'.padEnd(32, '0'), name: 'A job', agent: 'claude', kind: 'implement', model: 'sonnet', status: 'running',
  attempts: 1, startedAt: AT - 600000, elapsedMs: 600000, ref: 1, hasTranscript: true, ...o,
});
const reviewJob = jobRow({
  id: 'aaaa1111', fullId: 'a'.repeat(32), name: REVIEW_NAME, kind: 'review', model: 'opus', attempts: 0,
  startedAt: Date.UTC(2026, 10, 14, 16, 13), ref: 1457,
});
const implementJob = jobRow({
  id: 'bbbb2222', fullId: 'b'.repeat(32), name: ABOUT_NAME, kind: 'implement', startedAt: Date.UTC(2026, 10, 14, 16, 3), ref: 1449,
});
const fixJob = jobRow({ id: 'cccc3333', fullId: 'c'.repeat(32), name: 'Fix PR #1443', kind: 'fix', startedAt: Date.UTC(2026, 10, 14, 13, 5), ref: 1443 });
const aboutCard = rec({ id: 'd'.repeat(32), kind: 'issue_draft', state: 'done', title: ABOUT_NAME, number: 525, reference: 'C525, issue #1449', issue: 1449 });
const pageHelpers = { card: ({ body }) => body, decided: () => '', esc, form: fakeForm, grid: (_id, html) => html, tag: () => '' };
const pageOf = (jobs, inboxItems, q = 'state=running') => {
  const view = { generatedAt: AT, jobs, panels: { inbox: inboxItems, approvals: [] } };
  return inboxPage(view, new URLSearchParams(q), pageHelpers).body;
};
const tableRows = html => (html.match(/<tbody>[^]*?<\/tbody>/)?.[0].match(/<tr [^]*?<\/tr>/g)) || [];
const runningChip = html => Number(html.match(/data-chip="state:running"[^>]*>Running <span class="qf-n">(\d+)/)[1]);

test('runningJobRecords lists running, queued and paused jobs, newest start first, and nothing else', () => {
  const queued = jobRow({ id: 'eeee5555', fullId: 'e'.repeat(32), status: 'queued', startedAt: AT - 5000 });
  const paused = jobRow({ id: 'ffff6666', fullId: 'f'.repeat(32), status: 'paused_limit', startedAt: AT - 9000 });
  const done = jobRow({ status: 'completed' });
  const out = runningJobRecords([fixJob, done, implementJob, paused, reviewJob, queued], []);
  assert.deepEqual(out.map(r => r.id), ['e', 'f', 'a', 'b', 'c'].map(c => c.repeat(32)));
  assert.deepEqual(out.map(r => r.state), ['running', 'paused', 'running', 'running', 'running']);
  assert.ok(out.every(r => r.kind === 'job' && r.job.href.startsWith('/jobs/')));
  assert.deepEqual(runningJobRecords([], []), []);
  assert.deepEqual(runningJobRecords(undefined, []), []);
});
test('a job on an issue posted from an Inbox card carries the card reference; a job with no card, or a card that matches nothing, shows none', () => {
  const [review, implement, fix] = runningJobRecords([reviewJob, implementJob, fixJob], [aboutCard]);
  assert.equal(implement.reference, 'C525, issue #1449');
  assert.equal(review.reference, '');
  assert.equal(review.pr, 1457);
  assert.equal(fix.reference, '');
  assert.equal(fix.pr, 1443);
  assert.equal(implement.issue, 1449);
  assert.equal(runningJobRecords([implementJob], [{ ...aboutCard, issue: 77 }])[0].reference, '', 'a card for another issue is not linked');
  assert.equal(runningJobRecords([reviewJob], [{ ...aboutCard, issue: 1457 }])[0].reference, '', 'a review job works on a pull request, not on an issue');
});
test('an Inbox prompt whose own job runs appears once, as the job row with the item reference; a draft being posted with no job still appears', () => {
  const prompt = rec({ id: '0'.repeat(32), kind: 'prompt', state: 'running', reference: 'C530', title: 'Check the logs' });
  const posting = rec({ id: '1'.repeat(32), kind: 'issue_draft', state: 'posting', reference: 'C531', title: 'Draft being posted' });
  const own = jobRow({ id: 'ab12cd34', fullId: 'ab12cd34'.padEnd(32, '0'), name: 'Check the logs', kind: 'inbox', ref: placeholderIssue(prompt.id) });
  const view = runningView([own], [prompt, posting, aboutCard]);
  assert.deepEqual(view.rows.map(r => r.id), [own.fullId, posting.id]);
  assert.equal(view.rows[0].reference, 'C530');
  assert.equal(view.rows[0].job.role, 'inbox');
  assert.equal(view.jobsRunning, 1);
});
test('a job row with no name or an unknown kind still draws with its id', () => {
  const [r] = runningJobRecords([jobRow({ name: '', kind: undefined, model: null, agent: undefined, ref: null, startedAt: undefined })], []);
  assert.match(r.title, /abcd1234/);
  const html = pageOf([jobRow({ name: '', kind: 'mystery', ref: null })], []);
  assert.match(html, /Job abcd1234/);
  assert.equal(tableRows(html).length, 1);
});
test('the Running view draws three job rows in the Table, Compact list and Cards, newest first, and the count reads 3', () => {
  const html = pageOf([fixJob, reviewJob, implementJob], [aboutCard]);
  assert.equal(runningChip(html), 3);
  assert.match(html, /3 jobs running now/);
  const rows = tableRows(html);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map(r => /data-job="(.)/.exec(r)[1]), ['a', 'b', 'c']);
  assert.match(rows[0], /Job<\/span><\/td>|Job<\/span>/);
  assert.match(rows[0], /running/);
  assert.match(rows[0], /claude · opus · reviewer · review/);
  assert.match(rows[1], /C525, issue #1449/);
  assert.match(rows[1], /claude · sonnet · implementer · implement · attempt 1 · elapsed 12 min/);
  assert.match(rows[2], /attempt 1 · elapsed 3 h/);
  assert.match(rows[0], /<a class="iv-watch" href="\/jobs\/a{32}">Watch live<\/a>/);
  assert.equal((html.match(/<li class="iv-crow"/g) || []).length, 3);
  assert.equal((html.match(/<li class="inbox-item inbox-job"/g) || []).length, 3);
  assert.match(html, /<a class="iv-joblink" href="\/jobs\/b{32}">/);
});
test('job rows appear only under Running; the other buttons, their counts and All are unchanged', () => {
  const jobs = [fixJob, reviewJob, implementJob];
  for (const q of ['state=all', 'state=done', 'state=waiting', 'state=failed']) {
    const jobRowsShown = tableRows(pageOf(jobs, [aboutCard], q)).filter(r => r.includes('data-job='));
    assert.equal(jobRowsShown.length, 0, q);
  }
  const withJobs = pageOf(jobs, [aboutCard], 'state=all'), without = pageOf([], [aboutCard], 'state=all');
  const chipRe = /data-chip="(state|kind):(\w+)"[^>]*>[^<]*<span class="qf-n">(\d+)/g;
  const chips = html => [...html.matchAll(chipRe)].map(m => m.slice(1).join(':')).filter(c => !c.includes('running'));
  assert.deepEqual(chips(withJobs), chips(without));
  assert.equal(tableRows(withJobs).length, 1);
  assert.match(withJobs, /3 jobs running now/, 'the line shows whatever filter is on');
});
test('with nothing running the line says 0 jobs and the Running view says Nothing is running now; a draft being posted still shows', () => {
  const none = pageOf([], [aboutCard]);
  assert.match(none, /0 jobs running now/);
  assert.match(none, /Nothing is running now/);
  assert.equal(runningChip(none), 0);
  assert.match(pageOf([], [aboutCard], 'state=all'), /0 jobs running now/);
  const posting = rec({ id: '1'.repeat(32), kind: 'issue_draft', state: 'posting', reference: 'C531', title: 'Draft being posted' });
  const html = pageOf([], [posting]);
  assert.doesNotMatch(html, /Nothing is running now/);
  assert.equal(runningChip(html), 1);
  assert.match(html, /1 job running now|0 jobs running now/);
  assert.match(pageOf([jobRow()], []), /1 job running now/);
});
test('a paused job shows the paused chip and is not counted as running now; a job without a transcript has no Watch live link', () => {
  const html = pageOf([jobRow({ status: 'paused_manual', hasTranscript: false })], []);
  assert.match(html, /<span aria-hidden="true">⏸<\/span> paused/);
  assert.doesNotMatch(html, /Watch live/);
  assert.match(html, /0 jobs running now/);
  assert.equal(runningChip(html), 1);
});
test('the real /inbox page, from job records on disk, shows the Running rows and the line', async t => {
  const review = { id: 'a'.repeat(32), status: 'running', kind: 'review', provider: 'claude', model: 'opus', pr: 1457, issue: 1457, attempts: 0 };
  const s = await serve(t, [{ ...review, createdAt: Date.now() - 120000 }]);
  const running = await s.get('/inbox?state=running');
  assert.equal(running.status, 200);
  assert.match(running.body, /1 job running now/);
  assert.match(running.body, /data-job="a{32}"/);
  assert.match(running.body, /claude · opus · reviewer · review/);
  const all = await s.get('/inbox');
  assert.match(all.body, /running now/);
  assert.doesNotMatch(all.body, /data-job=/);
});
