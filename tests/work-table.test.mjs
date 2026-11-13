// Issue #1224: sort, filters, grouping, the Board columns, CSV and saved views of the Work page's Table (pure logic, no DOM).
import test from 'node:test';
import assert from 'node:assert/strict';
import { COLUMN_KEYS, boardColumns, csvCell, deleteView, emptyFilters, facetCounts, facetValues, filterRows, groupRows, saveView, sanitizeSaved,
  sanitizeState, sortRows, toCsv, toggleIn } from '../supervisor/dashui/worktable.mjs';
import { buildWorkRows } from '../supervisor/workrows.mjs';
import { workView } from './helpers/work-fixture.mjs';

const rows = (await (async () => buildWorkRows(await workView(Date.parse('2026-11-12T12:00:00Z'))).rows)());
const refs = list => list.map(r => r.ref);
const F = over => ({ ...emptyFilters(), ...over });

test('there are twenty columns, the ones the issue names', () => {
  assert.equal(COLUMN_KEYS.length, 20);
  assert.deepEqual(COLUMN_KEYS.slice(0, 6), ['ref', 'title', 'kind', 'agent', 'role', 'state']);
});

test('sort by rank ascending puts the queue in order and items finished today last; descending reverses the ranked ones', () => {
  const asc = sortRows(rows, 'rank', 'asc');
  assert.deepEqual(refs(asc).slice(0, 3), [1153, 1154, 1155]);
  assert.equal(asc.at(-1).state, 'done');
  const desc = sortRows(rows, 'rank', 'desc');
  assert.equal(desc[0].ref, 1180);
  assert.equal(desc.at(-1).state, 'done', 'a missing rank sorts last in both directions');
});

test('sort by title, by cost (missing last) and by state follow the column order, and a bad key falls back to rank', () => {
  assert.equal(sortRows(rows, 'title', 'asc')[0].title, 'Table view of the queue');
  const byCost = sortRows(rows, 'cost', 'desc');
  assert.equal(byCost[0].key, 'issue:1155');
  assert.equal(sortRows(rows, 'state', 'asc')[0].state, 'planned');
  assert.deepEqual(refs(sortRows(rows, 'nonsense')), refs(sortRows(rows, 'rank')));
});

test('a sort is stable: equal values keep their order', () => {
  const byAgent = sortRows(rows.filter(r => r.agent === 'claude'), 'agent', 'asc');
  assert.deepEqual(refs(byAgent), refs(rows.filter(r => r.agent === 'claude')));
});

test('filter by state: held shows only held items, including #1169 and PR #1180', () => {
  const held = filterRows(rows, F({ state: ['held'] }));
  assert.ok(held.every(r => r.state === 'held'));
  assert.ok(refs(held).includes(1169) && refs(held).includes(1180));
  assert.equal(filterRows(rows, F({ state: ['held', 'running'] })).length, held.length + 1);
});

test('filter by agent, by label and by the search box, and the kinds combine with AND', () => {
  assert.ok(filterRows(rows, F({ agent: ['codex'] })).every(r => r.agent === 'codex'));
  assert.deepEqual(refs(filterRows(rows, F({ label: ['docs'] }))), [1170]);
  assert.deepEqual(refs(filterRows(rows, F({ label: ['v2-ui', 'docs'] }))), [1169, 1170]);
  assert.deepEqual(refs(filterRows(rows, F({ q: '#1169' }))), [1169]);
  assert.deepEqual(refs(filterRows(rows, F({ q: 'retry cap' }))), [], 'the search reads ref, title, agent, hold reason and labels');
  assert.deepEqual(refs(filterRows(rows, F({ q: 'same cause' }))), [1180]);
  assert.deepEqual(refs(filterRows(rows, F({ agent: ['claude'], state: ['held'], label: ['v2-ui'] }))), [1169]);
  assert.equal(filterRows(rows, F({ q: 'zzzz' })).length, 0);
});

test('the buttons show counts of what pressing them would give', () => {
  const none = facetCounts(rows, emptyFilters());
  assert.equal(none.state.running, 1);
  assert.equal(none.agent.claude + none.agent.codex + (none.agent['(none)'] || 0), rows.length);
  const onlyHeld = facetCounts(rows, F({ state: ['held'] }));
  assert.equal(onlyHeld.agent.claude + onlyHeld.agent.codex, filterRows(rows, F({ state: ['held'] })).length);
  assert.equal(onlyHeld.state.running, 1, 'a state button counts without the state filter, so it says what choosing it adds');
  assert.deepEqual(facetValues(rows).label, ['docs', 'needs-homeowner', 'v2-ui']);
});

test('toggleIn adds then removes a value', () => {
  assert.deepEqual(toggleIn(toggleIn([], 'a'), 'b'), ['a', 'b']);
  assert.deepEqual(toggleIn(['a', 'b'], 'a'), ['b']);
});

test('group by hold reason: one group per reason, items without one last under (none)', () => {
  const groups = groupRows(sortRows(rows, 'rank'), 'holdReason');
  assert.equal(groups.at(-1).key, '(none)');
  const cap = groups.find(g => /stopped after 3 attempts/.test(g.key));
  assert.deepEqual(refs(cap.rows), [1180]);
  const dep = groups.find(g => /waiting for #1157/.test(g.key));
  assert.deepEqual(refs(dep.rows), [1169]);
  assert.equal(groups.reduce((n, g) => n + g.rows.length, 0), rows.length);
});

test('group by state follows the state order and by agent is alphabetical; no grouping is one group', () => {
  assert.deepEqual(groupRows(rows, 'state').map(g => g.key), ['planned', 'running', 'held', 'waiting-you', 'waiting-review', 'done']);
  assert.deepEqual(groupRows(rows, 'state')[2].label, 'Held');
  assert.deepEqual(groupRows(rows, 'agent').map(g => g.key), ['claude', 'codex', '(none)']);
  assert.equal(groupRows(rows, '').length, 1);
  assert.equal(groupRows(rows, 'bogus').length, 1);
});

test('the Board has the six columns and every item lands in exactly one', () => {
  const cols = boardColumns(rows);
  assert.deepEqual(cols.map(c => c.label), ['Held', 'Planned', 'Running', 'In review', 'Waiting for you', 'Merged today']);
  assert.equal(cols.reduce((n, c) => n + c.rows.length, 0), rows.length);
  assert.deepEqual(refs(cols[2].rows), [1155]);
  assert.deepEqual(refs(cols[3].rows), [1178]);
  assert.deepEqual(refs(cols[5].rows).sort(), [1152, 1179]);
});

test('CSV cells: commas, quotes and line breaks are quoted, quotes doubled', () => {
  assert.equal(csvCell('plain'), 'plain');
  assert.equal(csvCell('a, b'), '"a, b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell('two\nlines'), '"two\nlines"');
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(0), '0');
});

test('CSV: a title with a quote and a comma survives a parse back, and a formula title is neutralised', () => {
  const row = { ...rows[0], title: 'Fix "the, thing"', labels: ['a', 'b'] };
  const csv = toCsv([row, { ...rows[1], title: '=HYPERLINK("x")' }], ['ref', 'title', 'labels']);
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines[0], 'Ref,Title,Labels');
  assert.equal(lines[1], '#1153,"Fix ""the, thing""","a, b"');
  assert.match(lines[2], /^#1154,"'=HYPERLINK\(""x""\)",$/);
});

test('CSV: the header and one line per row for the chosen columns, times as ISO text, ends with a line break', () => {
  const csv = toCsv(sortRows(rows, 'rank'), ['ref', 'state', 'rank', 'lastActivity']);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Ref,State,Rank,Last activity');
  assert.equal(lines.length, rows.length + 2);
  assert.equal(lines.at(-1), '');
  assert.match(csv, /#1155,Running,3,2026-11-12T/);
});

test('the state of a view is sanitised: unknown columns, filters and sorts are dropped, widths are bounded', () => {
  const s = sanitizeState({ view: 'board', sortKey: 'nope', sortDir: 'sideways', group: 'agent', hidden: ['cost', 'nope'], widths: { title: 5000, nope: 3, ref: 'x' },
    filters: { state: ['held', 'bogus'], agent: ['claude'], label: [3, 'docs'], q: 'x'.repeat(500) } });
  assert.equal(s.view, 'board');
  assert.equal(s.sortKey, 'rank');
  assert.equal(s.sortDir, 'asc');
  assert.deepEqual(s.hidden, ['cost']);
  assert.deepEqual(s.widths, { title: 800 });
  assert.deepEqual(s.filters.state, ['held']);
  assert.deepEqual(s.filters.label, ['docs']);
  assert.equal(s.filters.q.length, 200);
  assert.equal(sanitizeState(null).view, 'cards');
});

test('saved views: save under a name, replace by name, delete, ignore a blank name, keep at most 20', () => {
  const a = sanitizeState({ view: 'table', group: 'state' });
  let saved = saveView([], '  Held items  ', a);
  assert.deepEqual(saved.map(v => v.name), ['Held items']);
  saved = saveView(saved, 'Held items', sanitizeState({ view: 'board' }));
  assert.equal(saved.length, 1);
  assert.equal(saved[0].state.view, 'board');
  assert.equal(saveView(saved, '   ', a).length, 1);
  assert.deepEqual(deleteView(saved, 'Held items'), []);
  let many = [];
  for (let i = 0; i < 25; i++) many = saveView(many, `v${i}`, a);
  assert.equal(many.length, 20);
  assert.deepEqual(sanitizeSaved('junk'), []);
});
