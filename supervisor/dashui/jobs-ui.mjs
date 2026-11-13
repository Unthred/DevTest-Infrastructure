// Jobs view in the browser (issue #1220): hide and resize columns, saved views per viewer, a row click that opens the side panel, and the CSV
// of the current table. The table itself, its filters, groups and totals are drawn by the server from the address. All the choices here are
// kept in localStorage, like the card layout. Pure helpers are exported so the tests run the code the page runs.
import { bindResize, sanitizeColumns as sanitizeKeys } from './table-columns.mjs';
import { COLUMN_KEYS, allJobRows, applyFilters, jobsQuery, parseJobsQuery, sortRows, toCsv } from './jobs-table.mjs';

export const KEYS = { cols: 'dash.jobs.cols', views: 'dash.jobs.views', last: 'dash.jobs.last' };

const readJson = (store, key, fallback) => { try { const v = JSON.parse(store.getItem(key)); return v ?? fallback; } catch { return fallback; } };
const writeJson = (store, key, v) => { try { store.setItem(key, JSON.stringify(v)); return true; } catch { return false; } };

// Column choices: which columns are hidden and how wide the others are (the shared rules in table-columns.mjs).
export const sanitizeColumns = raw => sanitizeKeys(raw, COLUMN_KEYS);
export const visibleColumns = cols => COLUMN_KEYS.filter(k => !cols.hidden.includes(k));

// A saved view is the address query of the table plus the column choices. Names are short plain text; there are at most 20.
export const cleanName = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
export function sanitizeViews(raw) {
  const out = {};
  for (const [name, v] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
    if (!cleanName(name) || typeof v?.query !== 'string' || Object.keys(out).length >= 20) continue;
    out[cleanName(name)] = { query: v.query.slice(0, 600), columns: sanitizeColumns(v.columns) };
  }
  return out;
}
export const saveView = (views, name, query, columns) => {
  const n = cleanName(name);
  return n ? sanitizeViews({ ...views, [n]: { query, columns } }) : views;
};
// Where a bare Jobs address goes: the view the viewer last saved or applied, or null when the address already chose something.
export function restoreTarget(search, last) {
  const q = new URLSearchParams(search);
  if (!last || q.get('view') !== 'jobs' || [...q.keys()].some(k => k !== 'view')) return null;
  return `/work?${last}`;
}
// The address query of the table as a saved view keeps it: the filters, grouping and sort, in the one canonical form (never the open job or
// the page), so it is never a bare address and opening it cannot redirect to itself. null when this is not the Jobs view.
export function lastQuery(search) {
  const q = new URLSearchParams(search);
  return q.get('view') === 'jobs' ? jobsQuery({ ...parseJobsQuery(q), job: '', page: 1 }) : null;
}

// ---- the rows of the current table, for the CSV ----
export async function currentCsv(fetchFn, search, columns) {
  const r = await fetchFn('/api/view.json', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
  if (!r.ok) throw new Error(`The dashboard answered ${r.status}`);
  const view = await r.json();
  const f = parseJobsQuery(new URLSearchParams(search));
  const rows = sortRows(applyFilters(allJobRows(view), f, view.generatedAt ?? Date.now()), f.sort, f.dir);
  return toCsv(rows, columns);
}

// ---- DOM ----
function applyColumns(doc, cols) {
  for (const k of COLUMN_KEYS) {
    const off = cols.hidden.includes(k);
    for (const el of doc.querySelectorAll(`.jobs-table .c-${k}`)) el.classList.toggle('col-off', off);
    const box = doc.querySelector(`[data-col-toggle="${k}"]`);
    if (box) box.checked = !off;
    const th = doc.querySelector(`.jobs-table th.c-${k}`);
    if (th) { th.style.width = cols.widths[k] ? `${cols.widths[k]}px` : ''; th.style.minWidth = th.style.width; }
  }
}

// The tools bar and the views list are drawn by the server inside a card that a refresh in place replaces, so they are made ready again after
// every swap, and every listener sits on the document (like the column toggle and the grips) so a swapped-in button still works.
function fillViews(doc, store, chosen = null) {
  const select = doc.querySelector('[data-jobs-views] select');
  if (!select || (select.dataset.filled && chosen === null)) return;   // a new select (after a swap) is not filled yet
  select.dataset.filled = '1';
  const names = Object.keys(sanitizeViews(readJson(store, KEYS.views, {})));
  select.replaceChildren(new Option('Choose a view', ''), ...names.map(n => new Option(n, n)));
  if (chosen) select.value = chosen;
}

function downloadCsv(doc, csv) {
  const a = doc.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = 'jobs.csv'; doc.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function bindJobs({ loc = location, store = localStorage, doc = document, fetchFn = fetch } = {}) {
  const target = restoreTarget(loc.search, store.getItem?.(KEYS.last));
  if (target) { loc.replace(target); return; }
  const cols = sanitizeColumns(readJson(store, KEYS.cols, {}));
  const status = text => { const el = doc.querySelector('[data-jobs-status]'); if (el) el.textContent = text; };
  const commit = () => writeJson(store, KEYS.cols, cols);
  const ready = () => { doc.querySelector('[data-jobs-tools]')?.removeAttribute('hidden'); fillViews(doc, store); applyColumns(doc, cols); };
  ready();
  new MutationObserver(ready).observe(doc.querySelector('main'), { childList: true, subtree: true });   // a refresh in place swaps the whole card

  doc.addEventListener('change', e => {
    const k = e.target.dataset?.colToggle;
    if (!k) return;
    Object.assign(cols, sanitizeColumns({ ...cols, hidden: e.target.checked ? cols.hidden.filter(h => h !== k) : [...cols.hidden, k] }));
    applyColumns(doc, cols); commit();
  });
  bindResize(doc, cols.widths, { apply: () => applyColumns(doc, cols), commit });

  doc.addEventListener('submit', e => {
    if (!e.target.matches?.('[data-jobs-views]')) return;
    e.preventDefault();
    const name = cleanName(e.target.elements.name.value);
    if (!name) { status('Give the view a name first.'); return; }
    const q = lastQuery(loc.search);
    writeJson(store, KEYS.views, saveView(sanitizeViews(readJson(store, KEYS.views, {})), name, q, cols));
    try { store.setItem(KEYS.last, q); } catch { /* not remembered */ }
    fillViews(doc, store, name); status(`Saved view “${name}”. It opens again the next time you open Jobs.`);
  });
  doc.addEventListener('click', async e => {
    const hit = sel => e.target.closest?.(sel);
    const chosen = doc.querySelector('[data-jobs-views] select')?.value;
    if (hit('[data-view-apply]')) {
      const v = sanitizeViews(readJson(store, KEYS.views, {}))[chosen];
      if (!v) { status('Choose a saved view first.'); return; }
      Object.assign(cols, v.columns); commit(); store.setItem(KEYS.last, v.query); loc.assign(`/work?${v.query}`);
    } else if (hit('[data-view-delete]')) {
      const views = sanitizeViews(readJson(store, KEYS.views, {}));
      if (!views[chosen]) { status('Choose a saved view first.'); return; }
      delete views[chosen]; writeJson(store, KEYS.views, views); fillViews(doc, store, ''); status(`Deleted view “${chosen}”.`);
    } else if (hit('[data-jobs-csv]')) {
      status('Preparing the CSV…');
      try {
        const csv = await currentCsv(fetchFn, loc.search, visibleColumns(cols));
        downloadCsv(doc, csv);
        status(`Downloaded jobs.csv (${csv.trim().split('\r\n').length - 1} jobs).`);
      } catch (error) { status(`The CSV could not be made: ${error.message}`); }
    } else {   // a click anywhere on a row opens its panel (the Id is also a plain link)
      const tr = hit('tr[data-job]');
      if (tr && !hit('a,button,input,select')) tr.querySelector('[data-job-link]')?.click();
    }
  });
}

if (typeof document !== 'undefined' && location.pathname === '/work') bindJobs();
