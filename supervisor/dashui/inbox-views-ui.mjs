// Issue #1219: browser side of the Inbox view switch. Shows one of the three server-rendered views, sorts and resizes the table, hides
// columns, and keeps the choice per viewer in localStorage. Progressive enhancement: without it the Cards view shows.
import { COLUMN_KEYS, MAX_COL_PX, MIN_COL_PX, STORE_KEY, sanitizePrefs, sortRows } from './inbox-views.mjs';

const rowOfCell = tr => ({ el: tr, created: Number(tr.querySelector('[data-created]')?.dataset.created) || null,
  ...Object.fromEntries(COLUMN_KEYS.filter(k => k !== 'age').map(k => [k, tr.querySelector(`[data-col="${k}"]`)?.textContent.trim() || ''])) });

export function initInboxViews(root = document, store = localStorage, phone = matchMedia('(max-width: 640px)').matches) {
  const el = root.querySelector('[data-iv]');
  if (!el || el.dataset.ivReady) return;
  el.dataset.ivReady = '1';
  let saved = null; try { saved = JSON.parse(store.getItem(STORE_KEY)); } catch { saved = null; }
  const prefs = sanitizePrefs(saved, { phone });
  const sort = { key: '', dir: 'asc' };
  const table = el.querySelector('.iv-table'), compact = el.querySelector('.iv-compact'), tbody = table.tBodies[0];
  const save = () => { try { store.setItem(STORE_KEY, JSON.stringify(prefs)); } catch { /* not remembered */ } };

  // The one sort applies to the table, the compact list and the cards, so the three views list the same items in the same order.
  const orderAll = () => {
    const rows = [...tbody.rows].map(rowOfCell);
    const order = sort.key ? sortRows(rows.map(r => ({ ...r, id: r.el.dataset.id, age: r.created })), sort.key, sort.dir).map(r => r.id) : null;
    const byId = c => c.dataset.id || c.dataset.inbox;
    for (const parent of [tbody, compact, el.querySelector('[data-pane=cards] ul')]) {
      if (!parent || !order) continue;
      const by = new Map([...parent.children].map(c => [byId(c), c]));
      for (const id of order) if (by.has(id)) parent.append(by.get(id));
    }
    for (const b of el.querySelectorAll('.iv-sort')) { b.closest('th').removeAttribute('aria-sort'); if (b.dataset.sort === sort.key) b.closest('th').setAttribute('aria-sort', sort.dir === 'asc' ? 'ascending' : 'descending'); }
  };
  const showView = () => {
    el.dataset.view = prefs.view;
    for (const pane of el.querySelectorAll('[data-pane]')) pane.hidden = pane.dataset.pane !== prefs.view;
    for (const b of el.querySelectorAll('.iv-view')) b.setAttribute('aria-pressed', String(b.dataset.view === prefs.view));
  };
  const showColumns = () => {
    for (const k of COLUMN_KEYS) {
      const off = prefs.hidden.includes(k);
      for (const n of table.querySelectorAll(`[data-col="${k}"]`)) n.hidden = off;
      const col = table.querySelector(`col[data-col="${k}"]`), w = prefs.widths[k];
      col.style.width = w ? `${w}px` : '';
      const box = el.querySelector(`.iv-colmenu input[data-col="${k}"]`); if (box) box.checked = !off;
    }
  };
  showView(); showColumns();

  for (const b of el.querySelectorAll('.iv-view')) b.addEventListener('click', () => { prefs.view = b.dataset.view; showView(); save(); });
  for (const b of el.querySelectorAll('.iv-sort')) b.addEventListener('click', () => {
    sort.dir = sort.key === b.dataset.sort && sort.dir === 'asc' ? 'desc' : 'asc'; sort.key = b.dataset.sort; orderAll();
  });
  for (const box of el.querySelectorAll('.iv-colmenu input')) box.addEventListener('change', () => {
    const next = box.checked ? prefs.hidden.filter(k => k !== box.dataset.col) : [...prefs.hidden, box.dataset.col];
    if (next.length >= COLUMN_KEYS.length) { box.checked = true; return; }
    prefs.hidden = next; showColumns(); save();
  });
  const setWidth = (k, px) => { prefs.widths[k] = Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, Math.round(px))); showColumns(); };
  for (const grip of el.querySelectorAll('.iv-grip')) {
    const k = grip.dataset.grip, th = grip.closest('th');
    grip.addEventListener('pointerdown', e => {
      e.preventDefault(); const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
      const move = ev => setWidth(k, w0 + ev.clientX - x0);
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); save(); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    grip.addEventListener('keydown', e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault(); setWidth(k, th.getBoundingClientRect().width + (e.key === 'ArrowRight' ? 20 : -20)); save();
    });
  }
}
// A card swapped in by the refresh in place is initialised in the same task, before the next paint.
export function watchInboxViews(root = document.body, store) {
  initInboxViews(document, store);
  if (typeof MutationObserver === 'function' && root) new MutationObserver(() => initInboxViews(document, store)).observe(root, { childList: true, subtree: true });
}
// The Inbox page loads this file with its own <script type="module">, so it starts itself; app.js is not touched.
if (typeof document !== 'undefined') watchInboxViews(document.body);
