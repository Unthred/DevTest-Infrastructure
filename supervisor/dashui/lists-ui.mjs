// Browser side of the shared lists (dlist in dashrender.mjs): search, sort, "N of M", and keeping all of it across the page's refresh.
// Progressive enhancement: without this script a list still shows and scrolls (the server renders the default order and the footer).
// State (search text, sort, direction, scroll position inside the list, open <details>) is kept per page and list in sessionStorage
// and is re-applied to any list that appears, including one swapped in by an in-place refresh (PR #531), before the browser paints.
import { DIRECTION_WORDS, footerText, listView, noMatchText, sanitizeListState } from './lists.mjs';

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
  const input = el.querySelector('.dl-q'), clear = el.querySelector('.dl-clear'), select = el.querySelector('.dl-key'), dirBtn = el.querySelector('.dl-dir');
  const sorts = el.dataset.sorts.split(','), noun = el.dataset.noun || 'items', defaultLabel = el.dataset.defaultLabel || 'Original order';
  const defaultSort = { key: el.dataset.defaultKey, dir: el.dataset.defaultDir };
  const lis = [...ul.children].filter(n => n.tagName === 'LI');
  const rows = lis.map((li, n) => ({ i: num(li.dataset.i) ?? n, li, sev: li.dataset.sev || null, num: num(li.dataset.num), name: li.dataset.name || null, age: num(li.dataset.age), text: (li.dataset.search ?? li.textContent).replace(/\s+/g, ' ') }));
  const st = sanitizeListState(readStore(store, id), { sorts, defaultSort, searchable: !!input });
  const words = k => (k === 'default' ? [defaultLabel, 'Reversed'] : DIRECTION_WORDS[k]);
  let saveTimer = 0;
  const save = () => writeStore(store, id, { q: st.q, key: st.key, dir: st.dir, top: ul.scrollTop, open: openKeys() });
  const saveSoon = () => { clearTimeout(saveTimer); saveTimer = setTimeout(save, 150); };
  const detailKey = d => { const li = d.closest('.dl-scroll > li'); /* the row, not a step's nested li.wstep (no data-key) */ return li ? `${li.dataset.key || ''}|${d.closest('[data-step]')?.dataset.step || ''}` : ''; };
  const openKeys = () => [...ul.querySelectorAll('details[open]')].map(detailKey).filter(Boolean).slice(0, 200);

  function apply({ keepScroll = true } = {}) {
    // A row removed from the page (decided in bulk) leaves the list's state too, or the next search change would bring it back.
    if (el.isConnected) for (let n = rows.length - 1; n >= 0; n--) if (!rows[n].li.isConnected) rows.splice(n, 1);
    const top = ul.scrollTop;
    const v = listView(rows, st);
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

  el.addEventListener('dl-rows-changed', () => apply());
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
