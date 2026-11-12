// Jobs view in the browser (issue #1220): hide and resize columns, saved views per viewer, a row click that opens the side panel, and the CSV
// of the current table. The table itself, its filters, groups and totals are drawn by the server from the address. All the choices here are
// kept in localStorage, like the card layout. Pure helpers are exported so the tests run the code the page runs.
import { COLUMN_KEYS, allJobRows, applyFilters, jobsQuery, parseJobsQuery, sortRows, toCsv } from './jobs-table.mjs';

export const KEYS = { cols: 'dash.jobs.cols', views: 'dash.jobs.views', last: 'dash.jobs.last' };
export const MIN_WIDTH = 48, MAX_WIDTH = 800;

const readJson = (store, key, fallback) => { try { const v = JSON.parse(store.getItem(key)); return v ?? fallback; } catch { return fallback; } };
const writeJson = (store, key, v) => { try { store.setItem(key, JSON.stringify(v)); return true; } catch { return false; } };

// Column choices: which columns are hidden and how wide the others are. Anything unknown or out of range is dropped.
export function sanitizeColumns(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const hidden = Array.isArray(r.hidden) ? [...new Set(r.hidden.filter(k => COLUMN_KEYS.includes(k)))] : [];
  const widths = {};
  for (const [k, w] of Object.entries(r.widths && typeof r.widths === 'object' ? r.widths : {})) if (COLUMN_KEYS.includes(k) && Number.isFinite(w)) widths[k] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(w)));
  return { hidden: hidden.length >= COLUMN_KEYS.length ? [] : hidden, widths };   // hiding every column would leave nothing to show
}
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

function bindResize(doc, cols, commit) {
  doc.addEventListener('pointerdown', e => {
    const grip = e.target.closest?.('[data-grip]');
    if (!grip) return;
    e.preventDefault();
    const th = grip.closest('th'), startX = e.clientX, startW = th.getBoundingClientRect().width, key = grip.dataset.grip;
    const move = ev => { cols.widths[key] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(startW + ev.clientX - startX))); applyColumns(doc, cols); };
    const up = () => { doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', up); commit(); };
    doc.addEventListener('pointermove', move); doc.addEventListener('pointerup', up);
  });
  doc.addEventListener('keydown', e => {
    const grip = e.target.closest?.('[data-grip]');
    if (!grip || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const key = grip.dataset.grip, now = cols.widths[key] || Math.round(grip.closest('th').getBoundingClientRect().width);
    cols.widths[key] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, now + (e.key === 'ArrowRight' ? 16 : -16)));
    applyColumns(doc, cols); commit();
  });
}

export function bindJobs({ loc = location, store = localStorage, doc = document, fetchFn = fetch } = {}) {
  const target = restoreTarget(loc.search, store.getItem?.(KEYS.last));
  if (target) { loc.replace(target); return; }
  const cols = sanitizeColumns(readJson(store, KEYS.cols, {}));
  const status = text => { const el = doc.querySelector('[data-jobs-status]'); if (el) el.textContent = text; };
  const commit = () => writeJson(store, KEYS.cols, cols);
  doc.querySelector('[data-jobs-tools]')?.removeAttribute('hidden');
  applyColumns(doc, cols);
  new MutationObserver(() => applyColumns(doc, cols)).observe(doc.querySelector('main'), { childList: true, subtree: true });   // a refresh in place swaps the table

  doc.addEventListener('change', e => {
    const k = e.target.dataset?.colToggle;
    if (!k) return;
    Object.assign(cols, sanitizeColumns({ ...cols, hidden: e.target.checked ? cols.hidden.filter(h => h !== k) : [...cols.hidden, k] }));
    applyColumns(doc, cols); commit();
  });
  bindResize(doc, cols, commit);

  const select = doc.querySelector('[data-jobs-views] select');
  const fillViews = () => {
    const views = sanitizeViews(readJson(store, KEYS.views, {}));
    if (select) select.replaceChildren(new Option('Choose a view', ''), ...Object.keys(views).map(n => new Option(n, n)));
    return views;
  };
  fillViews();
  doc.querySelector('[data-jobs-views]')?.addEventListener('submit', e => {
    e.preventDefault();
    const name = cleanName(e.target.elements.name.value);
    if (!name) { status('Give the view a name first.'); return; }
    const q = lastQuery(loc.search);
    writeJson(store, KEYS.views, saveView(sanitizeViews(readJson(store, KEYS.views, {})), name, q, cols));
    try { store.setItem(KEYS.last, q); } catch { /* not remembered */ }
    fillViews(); select.value = name; status(`Saved view “${name}”. It opens again the next time you open Jobs.`);
  });
  doc.querySelector('[data-view-apply]')?.addEventListener('click', () => {
    const v = sanitizeViews(readJson(store, KEYS.views, {}))[select.value];
    if (!v) { status('Choose a saved view first.'); return; }
    Object.assign(cols, v.columns); commit(); store.setItem(KEYS.last, v.query); loc.assign(`/work?${v.query}`);
  });
  doc.querySelector('[data-view-delete]')?.addEventListener('click', () => {
    const views = sanitizeViews(readJson(store, KEYS.views, {}));
    if (!views[select.value]) { status('Choose a saved view first.'); return; }
    const name = select.value; delete views[name]; writeJson(store, KEYS.views, views); fillViews(); status(`Deleted view “${name}”.`);
  });

  doc.addEventListener('click', e => {   // a click anywhere on a row opens its panel (the Id is also a plain link)
    const tr = e.target.closest?.('tr[data-job]');
    if (!tr || e.target.closest('a,button,input,select')) return;
    tr.querySelector('[data-job-link]')?.click();
  });
  doc.querySelector('[data-jobs-csv]')?.addEventListener('click', async () => {
    status('Preparing the CSV…');
    try {
      const csv = await currentCsv(fetchFn, loc.search, visibleColumns(cols));
      const a = doc.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'jobs.csv'; doc.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      status(`Downloaded jobs.csv (${csv.trim().split('\r\n').length - 1} jobs).`);
    } catch (error) { status(`The CSV could not be made: ${error.message}`); }
  });
}

if (typeof document !== 'undefined' && location.pathname === '/work') bindJobs();
