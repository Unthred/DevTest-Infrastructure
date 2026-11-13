// Issue #1217: the Inbox quick filters. The filter module on its own, then the real /inbox page route and the browser logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALL, STATE_BUTTONS, KIND_BUTTONS, applyFilters, chipQuery, countButtons, describeFilters, filtersOn, parseFilters } from '../supervisor/inbox-filter.mjs';
import { KEY, bindInboxFilter, restoreTarget, savable } from '../supervisor/dashui/inbox-filter.mjs';
import { renderRoute, matchRoute } from '../supervisor/dashrender.mjs';
import { overviewView } from './helpers/lists-fixture.mjs';

const rec = (id, kind, state, extra = {}) => ({ id, kind, state, title: `${kind} ${state} ${id}`, ...extra });
const RECORDS = [
  rec('a', 'prompt', 'pending'), rec('b', 'prompt', 'done', { title: 'Rules drift check read only Driftcheck' }), rec('c', 'issue_draft', 'done'),
  rec('d', 'action', 'running'), rec('e', 'action', 'approved'), rec('f', 'control', 'failed'), rec('g', 'host_value', 'posting'),
  rec('h', 'prompt', 'failed'), rec('i', 'issue_draft', 'refused'), rec('j', 'action', 'rejected'), rec('k', 'decision', 'pending', { decision: true }),
];
const q = s => new URLSearchParams(s);
const ids = (records, f) => applyFilters(records, f).map(r => r.id).join('');
const base = { state: 'all', kind: '', search: '' };

test('each state button selects exactly its states', () => {
  assert.equal(ids(RECORDS, { ...base, state: 'waiting' }), 'ak');
  assert.equal(ids(RECORDS, { ...base, state: 'running' }), 'deg');
  assert.equal(ids(RECORDS, { ...base, state: 'done' }), 'bc');
  assert.equal(ids(RECORDS, { ...base, state: 'failed' }), 'fh');
  assert.equal(ids(RECORDS, { ...base, state: 'refused' }), 'ij');
  assert.equal(ids(RECORDS, base), 'abcdefghijk');
});

test('each kind button selects its kind; Control also holds the internal host value kind', () => {
  assert.equal(ids(RECORDS, { ...base, kind: 'prompt' }), 'abh');
  assert.equal(ids(RECORDS, { ...base, kind: 'issue_draft' }), 'ci');
  assert.equal(ids(RECORDS, { ...base, kind: 'action' }), 'dej');
  assert.equal(ids(RECORDS, { ...base, kind: 'control' }), 'fg');
  assert.equal(ids(RECORDS, { ...base, kind: 'decision' }), 'k');
});

test('a state and a kind combine, and search works on top of both', () => {
  assert.equal(ids(RECORDS, { ...base, state: 'done', kind: 'prompt' }), 'b');
  assert.equal(ids(RECORDS, { ...base, state: 'failed', kind: 'prompt' }), 'h');
  assert.equal(ids(RECORDS, { state: 'done', kind: 'prompt', search: 'drift' }), 'b');
  assert.equal(ids(RECORDS, { state: 'done', kind: '', search: 'drift' }), 'b');
  assert.equal(ids(RECORDS, { state: 'failed', kind: '', search: 'drift' }), '');
});

test('an empty result is described by the filters in force', () => {
  const f = { state: 'running', kind: 'prompt', search: 'zzz' };
  assert.equal(ids(RECORDS, f), '');
  assert.deepEqual(describeFilters(f), ['Running', 'kind Prompt', 'search “zzz”']);
  assert.equal(filtersOn(f), true);
  assert.equal(filtersOn(base), false);
  assert.deepEqual(describeFilters(base), []);
});

test('the state counts sum to the total, and the kind counts cover every record', () => {
  const { states, kinds } = countButtons(RECORDS);
  assert.deepEqual(states, { all: 11, waiting: 2, running: 3, done: 2, failed: 2, refused: 2 });
  assert.equal(STATE_BUTTONS.reduce((n, b) => n + states[b.id], 0), states.all);
  assert.equal(KIND_BUTTONS.reduce((n, b) => n + kinds[b.id], 0), states.all);
  assert.deepEqual(kinds, { prompt: 3, issue_draft: 2, action: 3, control: 2, decision: 1 });
  const many = Array.from({ length: 354 }, (_, i) => rec(`r${i}`, KIND_BUTTONS[i % 5].id, ['pending', 'approved', 'running', 'posting', 'done', 'failed', 'refused', 'rejected'][i % 8]));
  const c = countButtons(many);
  assert.equal(STATE_BUTTONS.reduce((n, b) => n + c.states[b.id], 0), 354);
});

test('with no state in the address the view is Waiting for approval when anything waits, otherwise All', () => {
  assert.equal(parseFilters(q(''), countButtons(RECORDS)).state, 'waiting');
  assert.equal(parseFilters(q(''), countButtons(RECORDS.filter(r => r.state !== 'pending'))).state, 'all');
  assert.equal(parseFilters(q('state=all'), countButtons(RECORDS)).state, 'all', 'All chosen on purpose beats the default');
});

test('the address is parsed safely: old raw states map to their button, unknown values are ignored', () => {
  const counts = countButtons(RECORDS);
  assert.equal(parseFilters(q('state=pending'), counts).state, 'waiting');
  assert.equal(parseFilters(q('state=rejected'), counts).state, 'refused');
  assert.equal(parseFilters(q('state=bogus'), counts).state, 'waiting');
  assert.equal(parseFilters(q('kind=bogus'), counts).kind, '');
  assert.equal(parseFilters(q(`search=${'x'.repeat(300)}`), counts).search.length, 200);
});

test('buttons lead to the right address: toggling the one already on turns it off, search is kept', () => {
  const f = { state: 'waiting', kind: 'prompt', search: 'a b' };
  assert.equal(chipQuery(f, { state: 'failed' }), '/inbox?state=failed&kind=prompt&search=a+b');
  assert.equal(chipQuery(f, { state: 'waiting' }), '/inbox?state=all&kind=prompt&search=a+b');
  assert.equal(chipQuery(f, { kind: 'prompt' }), '/inbox?state=waiting&search=a+b');
  assert.equal(chipQuery(f, { kind: 'action' }), '/inbox?state=waiting&kind=action&search=a+b');
  assert.equal(chipQuery({ ...f, state: 'all' }, { state: ALL.id }), '/inbox?state=all&kind=prompt&search=a+b');
});

// ---- the real page route
async function page(search, records) {
  const view = await overviewView({});
  view.panels.inboxSearch = records;
  const out = renderRoute(view, matchRoute('/inbox'), { query: q(search), pathname: '/inbox' });
  return out.html;
}
const shown = html => [...html.matchAll(/<li class="inbox-item" id="[^"]*" data-inbox="([^"]+)"/g)].map(m => m[1]).join('');
const chipText = (html, id) => html.match(new RegExp(`data-chip="${id}"[^>]*>([^<]*)<span class="qf-n">(\\d+)`)).slice(1, 3).map(s => s.trim());

test('GET /inbox renders both button rows with counts, and the dropdowns match the buttons', async () => {
  const html = await page('', RECORDS.filter(r => !r.decision));
  assert.match(html, /<title>[^<]*Inbox/);
  assert.deepEqual(chipText(html, 'state:waiting'), ['Waiting for approval', '1']);
  assert.deepEqual(chipText(html, 'state:all'), ['All', '10']);
  assert.deepEqual(chipText(html, 'kind:control'), ['Control', '2']);
  assert.equal(shown(html), 'a', 'the default view is the waiting item');
  assert.match(html, /data-chip="state:waiting"[^>]*aria-current="true"/);
  assert.match(html, /<option value="waiting" selected>Waiting for approval/);
});

test('GET /inbox?state=failed shows only failed items and the dropdown follows the button', async () => {
  const html = await page('state=failed', RECORDS);
  assert.equal(shown(html), 'fh');
  assert.match(html, /<option value="failed" selected>/);
  assert.equal((await page('state=failed&kind=prompt', RECORDS)).match(/<li class="inbox-item"/g).length, 1);
});

test('an empty result names the filters and offers Clear filters; with nothing in the Inbox it does not', async () => {
  const html = await page('state=running&kind=prompt&search=zzz', RECORDS);
  assert.match(html, /No Inbox items match/);
  assert.match(html, /Filters on: Running, kind Prompt, search “zzz”/);
  assert.match(html, /data-clear-filters href="\/inbox\?state=all">Clear filters/);
  const none = await page('', []);
  assert.match(none, /No overseer proposals are waiting/);
  assert.doesNotMatch(none, /Clear filters/);
});

// ---- the browser logic
const fakeStore = (initial = {}) => { const m = new Map(Object.entries(initial)); return { getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m }; };
const fakeDoc = () => ({ selects: [], querySelectorAll() { return this.selects; } });

test('the saved choice is the state and kind only, and only when the address chose a state', () => {
  assert.equal(savable('?state=failed&kind=prompt&search=x'), 'state=failed&kind=prompt');
  assert.equal(savable('?state=all'), 'state=all');
  assert.equal(savable(''), null);
  assert.equal(savable('?search=x'), null);
});

test('a bare /inbox goes to the saved choice; an address with filters is left alone', () => {
  assert.equal(restoreTarget('', 'state=failed'), '/inbox?state=failed');
  assert.equal(restoreTarget('?search=x', 'state=failed'), null);
  assert.equal(restoreTarget('', null), null);
});

test('bindInboxFilter saves a chosen address, restores on a bare visit, and survives a store that throws', () => {
  const store = fakeStore();
  bindInboxFilter({ loc: { search: '?state=failed&kind=action', replace() { assert.fail('no redirect'); } }, store, doc: fakeDoc() });
  assert.equal(store.m.get(KEY), 'state=failed&kind=action');
  let went = null;
  bindInboxFilter({ loc: { search: '', replace: u => { went = u; } }, store, doc: fakeDoc() });
  assert.equal(went, '/inbox?state=failed&kind=action');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  bindInboxFilter({ loc: { search: '?state=done', replace() { assert.fail('no redirect'); } }, store: broken, doc: fakeDoc() });
});

test('changing a dropdown submits the form', () => {
  const doc = fakeDoc(); let submitted = 0, fire = null;
  doc.selects = [{ form: { requestSubmit: () => { submitted++; } }, addEventListener: (ev, fn) => { assert.equal(ev, 'change'); fire = fn; } }];
  bindInboxFilter({ loc: { search: '', replace() {} }, store: fakeStore(), doc });
  fire(); assert.equal(submitted, 1);
});
