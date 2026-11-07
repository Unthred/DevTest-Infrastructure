// Browser side of the shared lists (dlist in dashrender.mjs): search, sort, "N of M", and keeping all of it across the page's refresh.
// Progressive enhancement: without this script a list still shows and scrolls (the server renders the default order and the footer).
// State (search text, sort, direction, scroll position inside the list, open <details>) is kept per page and list in sessionStorage
// and is re-applied to any list that appears, including one swapped in by an in-place refresh (PR #531), before the browser paints.
import { DIRECTION_WORDS, footerText, listView, noMatchText, sanitizeListState } from './lists.mjs';
import { facetChips, facetsActive, toggleFacet } from './logic.mjs';

const keyOf = id => `dash.dl.${location.pathname}.${id}`;
const num = v => (v === undefined || v === '' ? null : Number(v));
function readStore(store, id) { try { return JSON.parse(store.getItem(keyOf(id))); } catch { return null; } }
function writeStore(store, id, st) { try { store.setItem(keyOf(id), JSON.stringify(st)); } catch { /* not remembered */ } }

// One page-level pagehide listener saves every connected list. A list replaced by an in-place refresh is dropped at swap time
// (pruneLists, called from the watchLists observer), so detached lists are not kept alive and cannot save stale state.
const live = new Map();
const onHide = () => { pruneLists(); for (const save of live.values()) save(); };
export function pruneLists() {
  for (const el of [...live.keys()]) if (el.isConnected !== true) live.delete(el);
  if (!live.size && typeof removeEventListener === 'function') removeEventListener('pagehide', onHide);
}
// Writes every connected list's state now: called just before a refresh in place swaps a card, so the list that replaces it starts from it.
export function saveLists() { pruneLists(); for (const save of live.values()) save(); }
function registerSave(el, save) {
  if (typeof addEventListener !== 'function') return;
  addEventListener('pagehide', onHide);   // the same function is added once by the DOM, so repeating it is harmless
  live.set(el, save);
}
export function initList(el, store = sessionStorage) {
  if (el.dataset.dlReady) return;
  el.dataset.dlReady = '1';
  const id = el.dataset.dlist, ul = el.querySelector(':scope > .dl-scroll'), foot = el.querySelector('[data-dl-foot]'), none = el.querySelector('.dl-none');
  const chipsEl = el.querySelector('.dl-filters'), input = el.querySelector('.dl-q'), clear = el.querySelector('.dl-clear'), select = el.querySelector('.dl-key'), dirBtn = el.querySelector('.dl-dir');
  const sorts = el.dataset.sorts.split(','), noun = el.dataset.noun || 'items', defaultLabel = el.dataset.defaultLabel || 'Original order';
  const defaultSort = { key: el.dataset.defaultKey, dir: el.dataset.defaultDir };
  let filters = []; try { filters = JSON.parse(el.dataset.filters || '[]'); } catch { /* no chips */ }
  const lis = [...ul.children].filter(n => n.tagName === 'LI');
  const rows = lis.map((li, n) => ({ i: num(li.dataset.i) ?? n, li, sev: li.dataset.sev || null, num: num(li.dataset.num), name: li.dataset.name || null, age: num(li.dataset.age), facets: (() => { try { return JSON.parse(li.dataset.facets || '{}'); } catch { return {}; } })(), text: li.textContent.replace(/\s+/g, ' ') }));
  const st = sanitizeListState(readStore(store, id), { sorts, defaultSort, searchable: !!input, filters });
  const words = k => (k === 'default' ? [defaultLabel, 'Reversed'] : DIRECTION_WORDS[k]);
  let saveTimer = 0;
  const save = () => writeStore(store, id, { q: st.q, key: st.key, dir: st.dir, f: st.f, top: ul.scrollTop, open: openKeys() });
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 150); };
  const detailKey = d => { const li = d.closest('.dl-scroll > li'); /* the row, not a step's nested li.wstep (no data-key) */ return li ? `${li.dataset.key || ''}|${d.closest('[data-step]')?.dataset.step || ''}` : ''; };
  const openKeys = () => [...ul.querySelectorAll('details[open]')].map(detailKey).filter(Boolean).slice(0, 200);

  // Chips with counts (logic.mjs facetChips), one group per declared filter, plus Clear all while any is on. Rebuilt on every change.
  function renderChips() {
    const groups = facetChips(rows, filters, st.f), any = facetsActive(st.f);
    chipsEl.replaceChildren();
    for (const g of groups) {
      const grp = document.createElement('span'); grp.className = 'dl-fgroup'; grp.setAttribute('role', 'group'); grp.setAttribute('aria-label', g.label);
      const lab = document.createElement('span'); lab.className = 'dl-flabel'; lab.textContent = g.label; grp.append(lab);
      for (const o of g.options) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'chip dl-chip'; b.dataset.fkey = g.key; b.dataset.fval = o.value;
        b.setAttribute('aria-pressed', o.on ? 'true' : 'false'); b.textContent = `${o.value} ${o.count}`;
        grp.append(b);
      }
      chipsEl.append(grp);
    }
    if (any) { const c = document.createElement('button'); c.type = 'button'; c.className = 'chip dl-fclear'; c.textContent = 'Clear all'; chipsEl.append(c); }
    chipsEl.hidden = !groups.length;
  }
  function apply({ keepScroll = true } = {}) {
    const top = ul.scrollTop;
    const v = listView(rows, { ...st, filters });
    // Reorder only when the order changed, so the browser keeps focus, scroll and open details of rows that stay.
    const want = v.order.map(r => r.li), have = [...ul.children];
    if (want.some((n, i) => n !== have[i])) { const frag = document.createDocumentFragment(); for (const n of want) frag.append(n); ul.append(frag); }
    const visible = new Set(v.shown.map(r => r.li));
    for (const r of rows) r.li.hidden = !visible.has(r.li);
    if (input && input.value !== st.q) input.value = st.q;
    if (clear) clear.hidden = !st.q;
    if (select) select.value = st.key;
    if (dirBtn) {
      const w = words(st.key)[st.dir === 'desc' ? 1 : 0];
      dirBtn.querySelector('span').textContent = w;
      dirBtn.setAttribute('aria-label', `Sort direction: ${w}. Press to reverse.`);
      dirBtn.dataset.dir = st.dir;
      dirBtn.hidden = false;
      const use = dirBtn.querySelector('use'); if (use) use.setAttribute('href', st.dir === 'desc' ? '#i-down' : '#i-up');
    }
    if (chipsEl) renderChips();
    if (foot) foot.textContent = footerText(rows, v.shown, noun, v.filtered);
    if (none) { none.hidden = !v.none; none.textContent = v.none ? noMatchText(st.q) : ''; }
    if (keepScroll) ul.scrollTop = top;
  }
  apply({ keepScroll: false });
  const saved = readStore(store, id);
  for (const d of ul.querySelectorAll('details')) { if (saved?.open?.includes(detailKey(d))) d.open = true; }
  // Moving a node in the DOM (the saved card layout is applied after this runs) resets its scroll to 0, so the saved position is put back
  // a few times until the viewer scrolls the list themselves.
  let touched = false;
  const putBack = () => { if (!touched && st.top && Math.abs(ul.scrollTop - st.top) > 1) ul.scrollTop = st.top; };
  for (const t of ['wheel', 'touchstart', 'pointerdown', 'keydown']) ul.addEventListener(t, () => { touched = true; }, { passive: true });
  putBack(); if (typeof requestAnimationFrame === 'function') { requestAnimationFrame(() => { putBack(); requestAnimationFrame(putBack); }); }
  if (typeof addEventListener === 'function') addEventListener('load', putBack, { once: true });

  chipsEl?.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.classList.contains('dl-fclear')) st.f = {}; else if (b.dataset.fkey) st.f = toggleFacet(st.f, b.dataset.fkey, b.dataset.fval);
    ul.scrollTop = 0; apply(); save();
    const again = b.dataset.fkey ? [...chipsEl.querySelectorAll('.dl-chip')].find(x => x.dataset.fkey === b.dataset.fkey && x.dataset.fval === b.dataset.fval) : null; again?.focus();
  });
  input?.addEventListener('input', () => { st.q = input.value.slice(0, 200); ul.scrollTop = 0; apply(); save(); });
  input?.addEventListener('keydown', e => { if (e.key === 'Escape' && st.q) { e.preventDefault(); st.q = ''; apply(); save(); } });
  clear?.addEventListener('click', () => { st.q = ''; apply(); save(); input?.focus(); });
  select?.addEventListener('change', () => { st.key = select.value; st.dir = st.key === defaultSort.key ? defaultSort.dir : (st.key === 'default' ? 'asc' : st.key === 'severity' ? 'desc' : 'asc'); ul.scrollTop = 0; apply(); save(); });
  dirBtn?.addEventListener('click', () => { st.dir = st.dir === 'desc' ? 'asc' : 'desc'; ul.scrollTop = 0; apply(); save(); });
  ul.addEventListener('scroll', saveSoon, { passive: true });
  ul.addEventListener('toggle', saveSoon, true);
  registerSave(el, save);
}
export function initLists(scope = document, store) { for (const el of scope.querySelectorAll('.dlist:not([data-dl-ready])')) initList(el, store); }
// A list swapped in later (in-place refresh) is initialised in the same task, before the next paint.
export function watchLists(root = document.body, store) {
  initLists(document, store);
  if (typeof MutationObserver === 'function' && root) new MutationObserver(() => { pruneLists(); initLists(document, store); }).observe(root, { childList: true, subtree: true });
}
