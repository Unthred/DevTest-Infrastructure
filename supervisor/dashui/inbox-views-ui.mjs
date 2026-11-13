// Issue #1219: browser side of the Inbox view switch. Shows one of the three server-rendered views, sorts and resizes the table, hides
// columns, and keeps the choice per viewer in localStorage. Progressive enhancement: without it the Cards view shows.
import { COLUMN_KEYS, STORE_KEY, sanitizePrefs, sortRows } from './inbox-views.mjs';
import { bindResize } from './table-columns.mjs';

const textOf = (tr, key) => tr.querySelector(`[data-col="${key}"]`)?.textContent.trim() || '';

function tableRows(tbody) {
  return [...tbody.rows].map(tr => ({
    id: tr.dataset.id,
    created: Number(tr.querySelector('[data-created]')?.dataset.created) || null,
    ...Object.fromEntries(COLUMN_KEYS.filter(k => k !== 'age').map(k => [k, textOf(tr, k)])),
  }));
}

function reorder(parent, order) {
  const byId = new Map([...parent.children].map(c => [c.dataset.id || c.dataset.inbox, c]));
  for (const id of order) if (byId.has(id)) parent.append(byId.get(id));
}

function readPrefs(store, phone) {
  let saved = null;
  try { saved = JSON.parse(store.getItem(STORE_KEY)); } catch { saved = null; }
  return sanitizePrefs(saved, { phone });
}

// The one sort applies to the table, the compact list and the cards, so the three views list the same items in the same order.
function sorter(el, parents, tbody) {
  const sort = { key: '', dir: 'asc' };
  const apply = () => {
    const order = sortRows(tableRows(tbody), sort.key, sort.dir).map(r => r.id);
    for (const parent of parents) if (parent) reorder(parent, order);
    for (const b of el.querySelectorAll('.iv-sort')) {
      const th = b.closest('th');
      th.removeAttribute('aria-sort');
      if (b.dataset.sort === sort.key) th.setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending');
    }
  };
  const by = key => {
    sort.dir = sort.key === key && sort.dir === 'asc' ? 'desc' : 'asc';
    sort.key = key;
    apply();
  };
  return by;
}

export function initInboxViews(root = document, store = localStorage, phone = matchMedia('(max-width: 640px)').matches) {
  const el = root.querySelector('[data-iv]');
  if (!el || el.dataset.ivReady) return;
  el.dataset.ivReady = '1';
  const prefs = readPrefs(store, phone);
  const table = el.querySelector('.iv-table');
  const save = () => { try { store.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* not remembered */ } };
  const showView = () => {
    el.dataset.view = prefs.view;
    for (const pane of el.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== prefs.view;
    for (const b of el.querySelectorAll('.iv-view')) b.setAttribute('aria-pressed', String(b.dataset.view === prefs.view));
  };
  const showColumns = () => {
    for (const k of COLUMN_KEYS) {
      const off = prefs.hidden.includes(k);
      for (const n of table.querySelectorAll(`[data-col="${k}"]`)) n.hidden = off;
      table.querySelector(`col[data-col="${k}"]`).style.width = prefs.widths[k] ? `${prefs.widths[k]}px` : '';
      const box = el.querySelector(`.iv-colmenu input[data-col="${k}"]`);
      if (box) box.checked = !off;
    }
  };
  showView();
  showColumns();

  const sortBy = sorter(el, [table.tBodies[0], el.querySelector('.iv-compact'), el.querySelector('[data-pane=cards] ul')], table.tBodies[0]);
  for (const b of el.querySelectorAll('.iv-view')) b.addEventListener('click', () => { prefs.view = b.dataset.view; showView(); save(); });
  for (const b of el.querySelectorAll('.iv-sort')) b.addEventListener('click', () => sortBy(b.dataset.sort));
  for (const box of el.querySelectorAll('.iv-colmenu input')) {
    box.addEventListener('change', () => {
      const next = box.checked ? prefs.hidden.filter(k => k !== box.dataset.col) : [...prefs.hidden, box.dataset.col];
      if (next.length >= COLUMN_KEYS.length) { box.checked = true; return; }
      prefs.hidden = next;
      showColumns();
      save();
    });
  }
  bindResize(el, prefs, { apply: showColumns, commit: save });
}

// A card swapped in by the refresh in place is initialised in the same task, before the next paint.
export function watchInboxViews(root = document.body, store) {
  initInboxViews(document, store);
  if (typeof MutationObserver !== 'function' || !root) return;
  const again = () => initInboxViews(document, store);
  new MutationObserver(again).observe(root, { childList: true, subtree: true });
}
// The Inbox page loads this file with its own <script type="module">, so it starts itself; app.js is not touched.
if (typeof document !== 'undefined') watchInboxViews(document.body);
