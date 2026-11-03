// Dashboard v2 browser script (issue #54): progressive enhancement only. Every page is complete without it; this adds
// the live countdown, theme choice, legend toggles, chart expand, copy buttons, drag/resize/reorder of cards, the dockable navigation, Back and
// scroll restoration (all saved per breakpoint, in this browser only). It reads nothing from the network and sends nothing.
import { COPY_FEEDBACK_MS, chooseRange, FILTER_DEBOUNCE_MS, ROW_STEP, formatLocal, timeOnly, applyLayout, breakpointOf, copyFeedback, copyMethods, debounce, dockFromPoint, effectiveDock, mergeTableParams, moveItem, resizeBox, restorableScroll, sanitizeCollapsed, showBackToTop, tableChange, toggleCollapsed } from './logic.mjs';
import { initLegends, initResetLayout } from './legend.mjs';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: the layout simply is not remembered */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nothing to remove */ } }
};

// theme
const root = document.documentElement;
const theme = store.get('dash.theme');
if (theme === 'light' || theme === 'dark') root.dataset.theme = theme;
$('#theme')?.addEventListener('click', () => {
  const dark = (root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';
  root.dataset.theme = dark ? 'light' : 'dark'; store.set('dash.theme', root.dataset.theme);
});

// countdown to the next tick and relative ages
const fmt = ms => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
function tickClock() {
  for (const el of $$('[data-countdown]')) {   // scheduled: counts down, then reads "overdue" and shows the last tick time
    const left = Number(el.dataset.countdown) - Date.now();
    el.textContent = left > 0 ? `in ${fmt(left)}` : `overdue by ${fmt(-left)}`;
    const after = el.parentElement && el.parentElement.querySelector('[data-after]'); if (after) after.hidden = left > 0;
  }
  for (const el of $$('[data-overdue]')) el.textContent = `overdue by ${fmt(Date.now() - Number(el.dataset.overdue))}`;
}
tickClock(); setInterval(tickClock, 1000);

// legend toggles (issue #160): one handler for every chart. A hidden series stays in the legend (struck through), clicking it
// again shows it, the last visible data series cannot be hidden (reset markers do not count), "Show all" appears while anything is hidden. The hidden set is
// kept per viewer and page in localStorage and re-applied after the page's own refresh; "Reset layout" clears it.
const legendKey = 'dash.legend.' + location.pathname;
initLegends({ document, store, legendKey });

// expand a chart card to a modal
let scrim = null;
function collapse() { $('.card.expanded')?.classList.remove('expanded'); scrim?.remove(); scrim = null; }
for (const b of $$('[data-expand]')) b.addEventListener('click', () => {
  const card = b.closest('.card'); if (card.classList.contains('expanded')) return collapse();
  collapse(); card.classList.add('expanded'); scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.addEventListener('click', collapse); document.body.append(scrim); b.focus();
});
addEventListener('keydown', e => { if (e.key === 'Escape') collapse(); });

// phone: tap a table row to open it (but not when the tap was on a button, link or the detail toggle inside it)
document.addEventListener('click', e => { const tr = e.target.closest?.('tr[tabindex]'); if (tr && !e.target.closest('button,a,summary,details')) tr.classList.toggle('open'); });

// copy buttons (issue #72): the text is in data-copy. Plain HTTP on the LAN is not a secure context, so the Clipboard API is
// often absent: fall back to a selected textarea and execCommand('copy'), and finally to a dialog with the text selected.
function execCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('inputmode', 'none');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';   // 16px: no zoom on iOS
  document.body.append(ta); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove(); return ok;
}
function manualCopy(text, back) {
  $('.copy-manual')?.remove();
  const box = document.createElement('div'); box.className = 'copy-manual'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Copy this text');
  const ta = document.createElement('textarea'); ta.value = text; ta.readOnly = true;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'btn'; close.textContent = 'Close';
  close.addEventListener('click', () => { box.remove(); back?.focus(); });
  box.append(ta, close); document.body.append(box); ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
}
async function copyText(text) {
  const methods = copyMethods({ secure: window.isSecureContext === true, clipboard: !!navigator.clipboard?.writeText, execCommand: typeof document.execCommand === 'function' });
  for (const m of methods) {
    if (m === 'clipboard') { try { await navigator.clipboard.writeText(text); return true; } catch { /* try the next method */ } }
    if (m === 'exec' && execCopy(text)) return true;
  }
  return false;
}
const live = $('#copy-status');
function bindCopy(scope = document) {
for (const b of $$('button[data-copy]', scope)) {
  if (b.dataset.bound) continue; b.dataset.bound = '1';
  b.hidden = false;
  const label = $('[data-copy-label]', b), original = label?.textContent;
  let timer = null;
  b.addEventListener('click', async e => {
    e.stopPropagation();
    const text = b.dataset.copy, ok = await copyText(text), fb = copyFeedback(ok);
    if (!ok) manualCopy(text, b);
    b.dataset.state = fb.state; if (label) label.textContent = fb.label; b.setAttribute('aria-label', fb.label);
    if (live) live.textContent = fb.announce;
    clearTimeout(timer);
    timer = setTimeout(() => { delete b.dataset.state; if (label) label.textContent = original; b.setAttribute('aria-label', b.title); if (live) live.textContent = ''; }, COPY_FEEDBACK_MS);
  });
}
}
bindCopy();
addEventListener('keydown', e => { if (e.key === 'Escape') $('.copy-manual')?.remove(); });

// Thin overlay scrollbars: native bars are hidden (html.sb-overlay) and a thumb is drawn over the scroller's edge, only while the
// pointer is over it or it is scrolling. Wheel, keyboard and touch scrolling stay native. Thumbs are fixed-position: no layout space.
document.documentElement.classList.add('sb-overlay');
const SB = 4, SBMIN = 24;
const thumbs = new Map(); // scroller -> { v, h, timer, hover }
const isDoc = el => el === document.documentElement || el === document.body;
const boxOf = el => isDoc(el) ? document.documentElement : el;
const rectOf = el => isDoc(el) ? { left: 0, top: 0, right: innerWidth, bottom: innerHeight } : el.getBoundingClientRect();
function mkThumb(axis) { const t = document.createElement('div'); t.className = 'sb-thumb'; t.dataset.axis = axis; t.setAttribute('aria-hidden', 'true'); document.body.append(t); return t; }
function place(el) {
  const rec = thumbs.get(el); if (!rec) return;
  const r = rectOf(el), box = boxOf(el);
  for (const [vert, t] of [[true, rec.v], [false, rec.h]]) {
    const client = vert ? box.clientHeight : box.clientWidth, total = vert ? box.scrollHeight : box.scrollWidth, pos = vert ? box.scrollTop : box.scrollLeft;
    if (total <= client + 1) { t.classList.remove('show'); t.style.display = 'none'; continue; }
    t.style.display = '';
    const len = vert ? r.bottom - r.top : r.right - r.left, size = Math.max(SBMIN, len * client / total), off = (len - size) * (pos / (total - client));
    if (vert) Object.assign(t.style, { width: SB + 'px', height: size + 'px', left: r.right - SB - 2 + 'px', top: r.top + off + 'px' });
    else Object.assign(t.style, { height: SB + 'px', width: size + 'px', top: r.bottom - SB - 2 + 'px', left: r.left + off + 'px' });
  }
}
function reveal(el, ms) {
  let rec = thumbs.get(el);
  if (!rec) { rec = { v: mkThumb('y'), h: mkThumb('x'), timer: 0, hover: false }; thumbs.set(el, rec); dragify(el, rec); }
  place(el); clearTimeout(rec.timer);
  for (const t of [rec.v, rec.h]) if (t.style.display !== 'none') t.classList.add('show');
  rec.timer = setTimeout(() => {
    if (rec.hover || rec.v.classList.contains('drag') || rec.h.classList.contains('drag')) return reveal(el, ms);
    for (const t of [rec.v, rec.h]) t.classList.remove('show');
  }, ms);
}
function dragify(el, rec) {
  for (const t of [rec.v, rec.h]) {
    t.addEventListener('pointerenter', () => { rec.hover = true; }); t.addEventListener('pointerleave', () => { rec.hover = false; });
    t.addEventListener('pointerdown', e => {
      e.preventDefault(); t.setPointerCapture(e.pointerId); t.classList.add('drag');
      const vert = t.dataset.axis === 'y', box = boxOf(el), start = vert ? e.clientY : e.clientX, from = vert ? box.scrollTop : box.scrollLeft;
      const move = ev => {
        const r = rectOf(el), len = vert ? r.bottom - r.top : r.right - r.left;
        const client = vert ? box.clientHeight : box.clientWidth, total = vert ? box.scrollHeight : box.scrollWidth, size = Math.max(SBMIN, len * client / total);
        const next = from + ((vert ? ev.clientY : ev.clientX) - start) * (total - client) / Math.max(1, len - size);
        if (vert) box.scrollTop = next; else box.scrollLeft = next;
      };
      const up = () => { t.classList.remove('drag'); t.removeEventListener('pointermove', move); t.removeEventListener('pointerup', up); t.removeEventListener('pointercancel', up); };
      t.addEventListener('pointermove', move); t.addEventListener('pointerup', up); t.addEventListener('pointercancel', up);
    });
  }
}
const scrollerOf = n => { // nearest ancestor (or the page) that can scroll
  for (let el = n instanceof Element ? n : null; el && el !== document.body && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if ((/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) || (/(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 1)) return el;
  }
  return document.documentElement;
};
addEventListener('scroll', e => { const el = e.target === document ? document.documentElement : e.target; if (el instanceof Element) reveal(el, 900); }, { capture: true, passive: true });
addEventListener('pointermove', e => {
  if (e.pointerType === 'touch' || !(e.target instanceof Element) || e.target.classList.contains('sb-thumb')) return;
  const el = scrollerOf(e.target), box = boxOf(el);
  if (thumbs.has(el) || box.scrollHeight > box.clientHeight + 1 || box.scrollWidth > box.clientWidth + 1) reveal(el, 1200);
}, { passive: true });
addEventListener('resize', () => { for (const el of thumbs.keys()) place(el); });

// Back: the browser's own history is used when we came from this dashboard (so filters, sort, page and scroll come back
// exactly); otherwise the link goes to the parent page, which also works without script.
$('[data-back]')?.addEventListener('click', e => {
  let same = false; try { same = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch { same = false; }
  if (same && history.length > 1) { e.preventDefault(); history.back(); }
});
// Scroll position per address, kept for this tab. Restored on back/forward and on the page's own periodic refresh.
const scrollKeyNow = () => 'dash.scroll.' + location.pathname + location.search;   // read at use: in-place table changes move the address
let scrollSave = 0;
const saveScroll = () => { try { sessionStorage.setItem(scrollKeyNow(), JSON.stringify({ y: scrollY, t: Date.now() })); } catch { /* not remembered */ } };
addEventListener('scroll', () => { clearTimeout(scrollSave); scrollSave = setTimeout(saveScroll, 150); }, { passive: true });
addEventListener('pagehide', saveScroll);
function restoreScroll() {
  let rec = null; try { rec = JSON.parse(sessionStorage.getItem(scrollKeyNow())); } catch { rec = null; }
  const navType = performance.getEntriesByType?.('navigation')?.[0]?.type;
  const recent = rec && Date.now() - rec.t < 90000;   // the meta refresh reloads within a minute
  if (!rec || !(navType === 'back_forward' || navType === 'reload' || recent)) return;
  const y = restorableScroll(rec.y, document.documentElement.scrollHeight - innerHeight);
  if (y) scrollTo(0, y);
}
history.scrollRestoration = 'manual';
// The periodic refresh is driven from here, not by a <meta refresh>: a declarative refresh keeps the address the page loaded
// with, so it would undo an in-place table change (replaceState). Without script the <noscript> meta still refreshes.
{
  const secs = Number($('meta[name=refresh-seconds]')?.content) || 60;
  setInterval(() => { saveScroll(); location.reload(); }, secs * 1000);
}

// movable and resizable cards
const grid = $('.cards[data-layout]');
const bpNow = () => breakpointOf(innerWidth);

// collapsing cards (issue #61): double-click a card header or use its chevron. Saved with the layout, per breakpoint and page, by
// card id (it works on every page, also where cards cannot be moved). "Reset layout" clears it with the rest.
const layoutPage = grid?.dataset.layout || location.pathname;
const layoutKey = () => `dash.layout.${layoutPage}.${bpNow()}`;
const allCards = () => $$('.card[data-card]');
const cardIds = () => allCards().map(c => c.dataset.card);
const readCollapsed = () => sanitizeCollapsed(store.get(layoutKey())?.collapsed, cardIds());
function paintCollapsed() {
  const set = new Set(readCollapsed());
  for (const c of allCards()) {
    const on = set.has(c.dataset.card), b = $(':scope > header [data-collapse]', c);
    c.classList.toggle('collapsed', on);
    if (b) { b.hidden = false; b.setAttribute('aria-expanded', String(!on)); b.setAttribute('aria-label', `${on ? 'Expand' : 'Collapse'} ${$(':scope > header h2', c)?.textContent || 'card'}`); }
  }
}
function toggleCard(c) {
  if (c.classList.contains('expanded')) return;
  const saved = store.get(layoutKey()) || {}, next = toggleCollapsed(readCollapsed(), c.dataset.card);
  if (next.length) store.set(layoutKey(), { ...saved, collapsed: next }); else { const { collapsed, ...rest } = saved; if (Object.keys(rest).length) store.set(layoutKey(), rest); else store.del(layoutKey()); }
  paintCollapsed();
}
paintCollapsed(); { let lastBp = bpNow(); addEventListener('resize', () => { if (bpNow() !== lastBp) { lastBp = bpNow(); paintCollapsed(); } }); }
document.addEventListener('click', e => { const b = e.target.closest?.('[data-collapse]'); if (b) { toggleCard(b.closest('.card')); b.focus(); } });
document.addEventListener('dblclick', e => {
  const h = e.target.closest?.('.card > header'); if (!h || e.target.closest('button,a,input,select,textarea,.resize')) return;
  getSelection()?.removeAllRanges(); toggleCard(h.closest('.card'));
});
// a link to something inside a collapsed card (a status pill) opens the card first
function revealTarget() { const t = location.hash?.length > 1 ? document.getElementById(decodeURIComponent(location.hash.slice(1))) : null; const c = t?.closest?.('.card.collapsed'); if (c) toggleCard(c); }
revealTarget(); addEventListener('hashchange', revealTarget);

// Tables update in place (issue #61): sort, filter (live, debounced), page and page size change one table's address parameters,
// fetch the same page and swap only that table's rows and footer. The scroll position and the focus never move; the address bar
// follows with replaceState so the state stays bookmarkable. If anything fails, a normal navigation happens and the scroll
// position is stored for the new address so it is restored.
const tableSeq = new Map();
function fallbackNavigate(url) {
  try { sessionStorage.setItem('dash.scroll.' + location.pathname + (url.includes('?') ? url.slice(url.indexOf('?')) : ''), JSON.stringify({ y: scrollY, t: Date.now() })); } catch { /* not remembered */ }
  location.assign(url);
}
async function loadTable(region, qs, { syncInput = false } = {}) {
  const id = region.dataset.tregion, seq = (tableSeq.get(id) || 0) + 1, url = location.pathname + (qs ? '?' + qs : '');
  tableSeq.set(id, seq);
  const hadFocus = region.contains(document.activeElement) ? document.activeElement : null, focusTitle = hadFocus?.getAttribute?.('title');
  try {
    const res = await fetch(url, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    if (tableSeq.get(id) !== seq) return;   // a newer request superseded this one
    const next = [...doc.querySelectorAll('[data-tregion]')].find(r => r.dataset.tregion === id);
    if (!next) throw new Error('table missing');
    const y = scrollY;
    $('[data-tdata]', region).replaceWith($('[data-tdata]', next));
    $('[data-tclear]', region)?.replaceWith($('[data-tclear]', next));
    if (syncInput) { const inp = $('input[type=search]', region); if (inp) inp.value = new URLSearchParams(qs).get(id + '.q') || ''; }
    const size = $('select', region); if (size) size.value = new URLSearchParams(qs).get(id + '.size') || size.value;
    bindCopy(region);
    history.replaceState(history.state, '', url);
    if (scrollY !== y) scrollTo(scrollX, y);
    if (hadFocus && !document.contains(hadFocus) && focusTitle) $$('[title]', region).find(a => a.getAttribute('title') === focusTitle)?.focus({ preventScroll: true });
  } catch { if (tableSeq.get(id) === seq) fallbackNavigate(url); }
}
for (const region of $$('[data-tregion]')) {
  const id = region.dataset.tregion, form = $('form.tbar', region);
  const search = $('input[type=search]', region);
  const typed = debounce(() => loadTable(region, tableChange(location.search, id, { q: search.value.trim() })), FILTER_DEBOUNCE_MS);
  search?.addEventListener('input', typed);
  form?.addEventListener('submit', e => { e.preventDefault(); typed.cancel(); loadTable(region, tableChange(location.search, id, { q: search?.value.trim() })); });
  $('select', region)?.addEventListener('change', e => { typed.cancel(); loadTable(region, tableChange(location.search, id, { size: e.target.value, q: search?.value.trim() })); });
  region.addEventListener('click', e => {
    const a = e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || !(a.closest('[data-tdata]') || a.closest('[data-tclear]'))) return;
    const u = new URL(a.href, location.href); if (u.origin !== location.origin || u.pathname !== location.pathname) return;
    e.preventDefault(); typed.cancel();
    loadTable(region, mergeTableParams(location.search, u.search, id), { syncInput: true });
  });
}

// back to top (issue #61): shown after scrolling down, smooth unless the viewer prefers reduced motion; focus returns to the page start
{
  const btn = $('#to-top');
  if (btn) {
    let pending = false;
    const update = () => { pending = false; btn.hidden = !showBackToTop(scrollY); };
    addEventListener('scroll', () => { if (!pending) { pending = true; requestAnimationFrame(update); } }, { passive: true });
    btn.addEventListener('click', () => {
      scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      const main = $('#main'); if (main) { main.tabIndex = -1; main.focus({ preventScroll: true }); }
    });
    update();
  }
}
if (grid) {
  const page = grid.dataset.layout;
  const key = () => `dash.layout.${page}.${bpNow()}`;
  const cards = () => $$(':scope > .card[data-card]', grid);
  const ids = () => cards().map(c => c.dataset.card);
  let lay = { order: [], span: {}, h: {} };
  const save = () => store.set(key(), { ...lay, collapsed: readCollapsed() });
  const spanProp = () => (bpNow() === 'tablet' ? '--tspan' : '--span');
  function apply() {
    const bp = bpNow();
    lay = applyLayout(ids(), store.get(key()), bp);
    const byId = new Map(cards().map(c => [c.dataset.card, c]));
    for (const id of lay.order) grid.append(byId.get(id));
    for (const c of cards()) {
      const id = c.dataset.card;
      c.style.setProperty('--span', bp === 'desktop' && lay.span[id] ? lay.span[id] : c.dataset.span);   // the server-rendered span is the default
      if (bp === 'tablet' && lay.span[id]) c.style.setProperty('--tspan', lay.span[id]); else c.style.removeProperty('--tspan');
      if (lay.h[id]) { c.style.setProperty('--h', lay.h[id] + 'px'); c.style.alignSelf = 'start'; } else { c.style.removeProperty('--h'); c.style.alignSelf = ''; }   // a sized card is its own height, not the row's
      const k = $('.rz-key', c); if (k) k.setAttribute('aria-valuenow', lay.span[id] || c.dataset.span);
    }
  }
  apply(); let last = bpNow(); addEventListener('resize', () => { if (bpNow() !== last) { last = bpNow(); apply(); } });
  // keyboard / touch reorder
  for (const b of $$('[data-move]', grid)) b.addEventListener('click', () => {
    const c = b.closest('.card'); lay.order = moveItem(lay.order, c.dataset.card, Number(b.dataset.move)); save(); apply(); b.focus();
  });
  // geometry helpers for snapping: one grid column pitch, and the card's size in columns
  const gap = () => parseFloat(getComputedStyle(grid).columnGap) || 0;
  const cols = () => (bpNow() === 'tablet' ? 6 : 12);
  const pitch = () => (grid.getBoundingClientRect().width + gap()) / cols();
  const spanOf = c => Number(c.style.getPropertyValue(spanProp())) || Math.round((c.getBoundingClientRect().width + gap()) / pitch());
  // The content's own height at the current width: the card with its minimum height removed. A saved height is a min-height,
  // so the content can never be clipped; it can only make the card taller than asked.
  function naturalHeight(c) {
    const prev = c.style.getPropertyValue('--h'), prevAlign = c.style.alignSelf; c.style.setProperty('--h', '0px'); c.style.alignSelf = 'start';   // not stretched to the row, or a card could never get shorter
    const h = c.offsetHeight; if (prev) c.style.setProperty('--h', prev); else c.style.removeProperty('--h'); c.style.alignSelf = prevAlign; return h;
  }
  function setSize(c, edge, dx, dy, from) {
    const r = resizeBox({ edge, dx, dy, span: from.span, h: from.h, natH: naturalHeight(c), colW: pitch(), type: c.dataset.type, bp: bpNow() });
    c.style.setProperty(spanProp(), r.span); lay.span[c.dataset.card] = r.span;
    if (r.h) { c.style.setProperty('--h', r.h + 'px'); c.style.alignSelf = 'start'; lay.h[c.dataset.card] = r.h; }   // live: the real content reflows at every step
    $('.rz-key', c)?.setAttribute('aria-valuenow', r.span);
  }
  let drag = null;
  for (const c of cards()) {
    const h = $('[data-handle]', c); if (!h) continue;
    // drag the header handle to reorder (pointer devices)
    h.draggable = true;
    h.addEventListener('dragstart', e => { drag = c; c.classList.add('dragging'); e.dataTransfer.setData('text/plain', c.dataset.card); e.dataTransfer.effectAllowed = 'move'; });
    h.addEventListener('dragend', () => { c.classList.remove('dragging'); $$('.dropping', grid).forEach(x => x.classList.remove('dropping')); drag = null; });
    c.addEventListener('dragover', e => { if (drag && drag !== c) { e.preventDefault(); c.classList.add('dropping'); } });
    c.addEventListener('dragleave', () => c.classList.remove('dropping'));
    c.addEventListener('drop', e => { e.preventDefault(); if (!drag || drag === c) return; const from = lay.order.indexOf(drag.dataset.card); lay.order.splice(from, 1); lay.order.splice(lay.order.indexOf(c.dataset.card), 0, drag.dataset.card); save(); apply(); });
    // resize from any edge or corner (not offered on a phone)
    for (const rz of $$('.resize[data-edge]', c)) rz.addEventListener('pointerdown', e => {
      if (bpNow() === 'phone' || e.button > 0) return;
      e.preventDefault(); rz.setPointerCapture(e.pointerId); rz.classList.add('active'); c.classList.add('resizing'); document.body.classList.add('resizing');
      const from = { span: spanOf(c), h: c.offsetHeight }, x0 = e.clientX, y0 = e.clientY, edge = rz.dataset.edge;
      const move = ev => setSize(c, edge, ev.clientX - x0, ev.clientY - y0, from);
      const up = () => {
        rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); rz.removeEventListener('pointercancel', up);
        rz.classList.remove('active'); c.classList.remove('resizing'); document.body.classList.remove('resizing'); save();
      };
      rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up); rz.addEventListener('pointercancel', up);
    });
    // keyboard: arrows resize one grid step; the same limits and snapping as the pointer
    $('.rz-key', c)?.addEventListener('keydown', e => {
      const d = { ArrowRight: ['e', 1, 0], ArrowLeft: ['e', -1, 0], ArrowDown: ['s', 0, 1], ArrowUp: ['s', 0, -1] }[e.key]; if (!d || bpNow() === 'phone') return;
      e.preventDefault(); setSize(c, d[0], d[1] * pitch(), d[2] * ROW_STEP, { span: spanOf(c), h: c.offsetHeight }); save();
    });
  }
  initResetLayout({ document, store, layoutKey: key, legendKey, reload: () => location.reload() });
}
requestAnimationFrame(() => requestAnimationFrame(restoreScroll));

// dockable navigation: top, bottom, left or right; saved per breakpoint; a phone keeps the fixed bottom tab bar
const dockKey = () => 'dash.dock.' + bpNow();
function applyDock() {
  const d = effectiveDock(store.get(dockKey()), bpNow());
  root.dataset.dock = d;
  const rail = store.get('dash.navrail') === true; if (rail) root.dataset.rail = 'collapsed'; else delete root.dataset.rail;
  $('[data-nav-collapse]')?.setAttribute('aria-pressed', String(rail));
}
applyDock(); { let lastBp = bpNow(); addEventListener('resize', () => { if (bpNow() !== lastBp) { lastBp = bpNow(); applyDock(); } }); }
$('[data-nav-collapse]')?.addEventListener('click', () => { store.set('dash.navrail', store.get('dash.navrail') !== true); applyDock(); });
{
  const handle = $('[data-dock-handle]');
  // Keyboard docking: arrow keys pick an edge, Home resets (issue #263).
  handle?.addEventListener('keydown', e => {
    const to = { ArrowUp: 'top', ArrowDown: 'bottom', ArrowLeft: 'left', ArrowRight: 'right', Home: 'top' }[e.key];
    if (!to) return;
    e.preventDefault(); store.set(dockKey(), to); applyDock(); handle.focus();
  });
  handle?.addEventListener('pointerdown', e => {
    if (bpNow() === 'phone') return;
    e.preventDefault(); handle.setPointerCapture(e.pointerId);
    const zones = document.createElement('div'); zones.className = 'dock-zones';
    for (const z of ['top', 'bottom', 'left', 'right']) { const i = document.createElement('i'); i.className = `z-${z}`; i.dataset.z = z; zones.append(i); }
    document.body.append(zones);
    let target = effectiveDock(store.get(dockKey()), bpNow());
    const mark = ev => { target = dockFromPoint(ev.clientX, ev.clientY, innerWidth, innerHeight); for (const z of $$('i', zones)) z.classList.toggle('on', z.dataset.z === target); };
    const done = commit => { handle.removeEventListener('pointermove', mark); handle.removeEventListener('pointerup', up); handle.removeEventListener('pointercancel', cancel); removeEventListener('keydown', esc); zones.remove(); if (commit) { store.set(dockKey(), target); applyDock(); } };
    const up = () => done(true), cancel = () => done(false), esc = ev => { if (ev.key === 'Escape') done(false); };
    handle.addEventListener('pointermove', mark); handle.addEventListener('pointerup', up); handle.addEventListener('pointercancel', cancel); addEventListener('keydown', esc); mark(e);
  });
}

// remembered time range, per viewer (issue #140). The server renders the default (7d) when the address has no range; the saved choice is
// applied by reloading once with it in the address, and a click on a range saves it.
{
  const links = $$('.ranges a'); if (links.length) {
    const cur = $('.ranges a[aria-current]')?.textContent.trim(), q = new URLSearchParams(location.search);
    const want = chooseRange(store.get('dash.range'), q.get('range'));
    if (!q.has('range') && want !== cur && links.some(a => a.textContent.trim() === want)) { q.set('range', want); location.replace(location.pathname + '?' + q + location.hash); }
    for (const a of links) a.addEventListener('click', () => store.set('dash.range', a.textContent.trim()));
    if (q.has('range') && cur) store.set('dash.range', cur);
  }
}

// Local time (issue #76): the server renders UTC; every <time data-local> is rewritten in this browser's time zone. Data stays UTC.
{
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  for (const el of $$('time[data-local]')) {
    const ms = Date.parse(el.getAttribute('datetime'));
    if (!Number.isFinite(ms)) continue;
    el.title = `${el.textContent} (stored in UTC); shown in your time zone, ${zone}`;
    el.textContent = formatLocal(ms, zone);
  }
  // Chart axis labels and tooltips (SVG cannot hold <time>): rebuilt from their template in this zone.
  for (const el of $$('[data-lms]')) {
    const ms = Number(el.getAttribute('data-lms'));
    if (!Number.isFinite(ms)) continue;
    const t = el.hasAttribute('data-tonly') ? timeOnly(ms, zone) : formatLocal(ms, zone);
    el.textContent = (el.getAttribute('data-tpl') || '{t}').replace('{t}', () => t);
  }
  const note = $('#tznote');
  if (note) note.textContent = `Times are shown in your time zone (${zone}). Data is stored in UTC; hover a time to see it.`;
}
