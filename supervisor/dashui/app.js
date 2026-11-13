// Dashboard v2 browser script (issue #54): progressive enhancement only. Every page is complete without it; this adds
// the live countdown, theme choice, legend toggles, chart expand, copy buttons, drag/resize/reorder of cards, the dockable navigation, Back and
// scroll restoration (all saved per breakpoint, in this browser only). Its one write is the inbox decision (issue #856: Approve, Reject, Undo post to /inbox with the page's access proof); its only other network read is the same-origin GET /api/next (the app bar's Next element), polled while a tick is due or running.
import { COPY_FEEDBACK_MS, chooseRange, FILTER_DEBOUNCE_MS, formatLocal, timeOnly, applyLayout, breakpointOf, copyFeedback, copyMethods, debounce, dockFromPoint, effectiveDock, mergeTableParams, moveItem, restorableScroll, sanitizeCollapsed, showBackToTop, tableChange, toggleCollapsed } from './logic.mjs';
import { initLegends } from './legend.mjs';
import { initChartOptions } from './chartopts.mjs';
import { BAR_KEY, FIXED, addBarItem, barToSaved, moveBarItem, removeBarItem, sanitizeBar } from './appbar.mjs';
import { COLS, MIN_W, ROW_PITCH, addGroup, canHide, compactGroups, dragRect, groupOf, placeGroup, removeGroups, withoutCard, edgeAt, firstFit, fromBoxes, history as layoutHistory, placeCard, resizeRect, rowsFor, sanitizeLayout, toSaved, withoutPinned } from './grid.mjs';
import { saveLists, watchLists } from './lists-ui.mjs';
import { postDecision, runDecision, lowerCount, showOutcomeInViews } from './inbox-ui.mjs';
import { readRegions, startRefresh } from './refresh.mjs';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: the layout simply is not remembered */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* nothing to remove */ } }
};

// What the server sent, read before any script below changes the page: the refresh in place compares each fetch with it (issue #930).
const serverRegions = readRegions(document);

// shared lists (search, sort, state across refresh): initialised right away, and again for any list a later refresh swaps in
watchLists(document.body);

// Inbox decisions (issue #856). The form still works without this script (a plain post and redirect). With it, the click disables both buttons
// at once, labels the pressed one, shows the outcome and time beside the title, moves the card into "Decided today" and lowers the counts;
// a refusal re-enables the buttons and shows the reason on the card. The server is the only record: an Undo refreshes the page from it in place.
const postInbox = form => postDecision(fetch.bind(window), form.action, new FormData(form));
document.addEventListener('submit', async e => {
  const form = e.target.closest?.('form.inbox-form'); if (!form) return;
  e.preventDefault();
  const decision = form.elements.decision.value, item = form.closest('[data-inbox]'), row = item;   // a card, a table row or a compact row (issue #1262)
  if (decision === 'undo') {
    const btn = form.querySelector('button'); btn.disabled = true;
    const j = await postInbox(form);
    if (j.ok) { refresher?.refresh(true, { live: true }); btn.disabled = false; return; }   // the server record is re-read in place (issue #930)
    btn.disabled = false; btn.textContent = 'Undo refused: ' + j.reason; return;
  }
  const btns = $$('.inbox-form button', item), pressed = form.querySelector('button'), err = $('.inbox-err', item), was = pressed.textContent;
  await runDecision({ decision, post: () => postInbox(form), ui: {
    error: text => { err.textContent = text || ''; err.hidden = !text; },
    lock: label => { for (const b of btns) { b.disabled = true; if (b !== pressed) b.classList.add('greyed'); } pressed.textContent = label; },
    settled: text => { for (const b of btns) { b.disabled = true; b.classList.add('greyed'); } pressed.textContent = was; err.textContent = text; err.hidden = false; },
    unlock: () => { for (const b of btns) { b.disabled = false; b.classList.remove('greyed'); } pressed.textContent = was; },
    decided: j => {
      const title = (row.querySelector('.t, .iv-title')?.textContent || '').replace(/\s+/g, ' ').replace(/^\s*action\s*/i, '').trim();
      const out = row.querySelector('.inbox-outcome');
      showOutcomeInViews(document, { id: item.dataset.inbox, decision, decidedAt: j.decidedAt, pressed: row, localize: localizeTimes });   // all three Inbox views (issue #1262)
      const list = $('.inbox-decided-list'), box = $('.inbox-decided');
      if (!list || !box) return;
      const li = document.createElement('li'); li.dataset.decided = item.dataset.inbox;
      const t = document.createElement('span'); t.className = 'inbox-title'; t.textContent = title.slice(0, 200);
      li.append(t, ' ', out.cloneNode(true));
      if (j.undoUntil) {
        const f = form.cloneNode(false); f.className = 'inbox-form inbox-undo'; f.dataset.undoUntil = j.undoUntil;
        const mk = (n, v) => { const i = document.createElement('input'); i.type = 'hidden'; i.name = n; i.value = v; return i; };
        f.append(mk('proof', form.elements.proof.value), mk('id', item.dataset.inbox), mk('decision', 'undo'));
        const b = document.createElement('button'); b.type = 'submit'; b.className = 'linkbtn'; b.textContent = 'Undo'; f.append(b); li.append(' ', f);
      }
      list.prepend(li); box.hidden = false; $('.inbox-decided-n', box).textContent = String($$('li', list).length);
      if (row.classList.contains('inbox-item')) row.remove();   // a card moves to Decided; a table or compact row stays and shows its outcome
      const h = $('#h-needs'); if (h) h.textContent = lowerCount(h.textContent);
    } } }).then(() => refresher?.refresh(true, { live: true }));   // issue #1101: the "Waiting for approval" list and badge are re-read from the server now
});
// An Undo link disappears when its window ends, so it is never offered after the server would refuse it.
setInterval(() => { for (const f of $$('form.inbox-undo')) if (Date.now() > Number(f.dataset.undoUntil)) f.remove(); }, 1000);

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
const TICK_GRACE_MS = 90 * 1000;
// A page that stays open cannot know that the cron fired and a tick took the lock, so once the slot passes it re-reads its own
// Next stat from the server (every 10 s) instead of guessing. Until then it says "starting", never "overdue", for a grace period.
let nextFetch = 0;
async function refreshNext() {
  if (Date.now() - nextFetch < 10000) return; nextFetch = Date.now();
  try {
    const r = await fetch('/api/next', { headers: { accept: 'text/html' }, credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) return;   // issue #481: only the Next element, not the whole page
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    const fresh = doc.querySelector('[data-tick-state], .muted'), cur = document.querySelector('.statusbar [data-tick-state]');
    if (fresh && cur) { const el = document.importNode(fresh, true); cur.replaceWith(el); localizeTimes(el); tickClock(); }
  } catch { /* offline: keep the text */ }
}
function tickClock() {
  for (const el of $$('[data-countdown]')) {   // scheduled: counts down, then "starting" for a grace period, then "overdue"
    const left = Number(el.dataset.countdown) - Date.now();
    el.textContent = left > 0 ? `in ${fmt(left)}` : -left < TICK_GRACE_MS ? 'tick due, starting' : `overdue by ${fmt(-left)}`;
    const after = el.parentElement && el.parentElement.querySelector('[data-after]'); if (after) after.hidden = left > -TICK_GRACE_MS;
    if (left <= 0) refreshNext();
  }
  for (const el of $$('[data-overdue]')) {
    const late = Date.now() - Number(el.dataset.overdue);
    if (late >= TICK_GRACE_MS) el.textContent = `overdue by ${fmt(late)}`;
    refreshNext();
  }
  if ($$('.statusbar [data-running]').length) refreshNext();   // a running tick ends without a reload: keep polling until the server says otherwise
}
tickClock(); setInterval(tickClock, 1000);

// legend toggles (issue #160): one handler for every chart. A hidden series stays in the legend (struck through), clicking it
// again shows it, the last visible data series cannot be hidden (reset markers do not count), "Show all" appears while anything is hidden. The hidden set is
// kept per viewer and page in localStorage and re-applied after the page's own refresh; "Reset layout" clears it.
const legendKey = 'dash.legend.' + location.pathname;
initLegends({ document, store, legendKey });
initChartOptions({ document, store });   // style and legend position per chart (issue #926)

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
// The periodic refresh (issue #930) updates the page in place: it fetches the same address and swaps only the cards whose content changed,
// keeping scroll, open items, typed text and focus, and waits while the viewer is interacting (refresh.mjs). Without script the <noscript>
// meta still reloads the page. It is not a <meta refresh> when script runs: a declarative refresh keeps the address the page loaded with,
// so it would undo an in-place table change (replaceState).
let repaintBar = null;   // set by the app bar editor below; a stats swap brings back the server's items, so the bar is painted again
const refresher = startRefresh({
  document, baseline: serverRegions, seconds: Number($('meta[name=refresh-seconds]')?.content) || 60,
  hooks: {
    beforeSwap: () => saveLists(),   // list search, sort, scroll and open rows are written first; the swapped-in list re-reads them
    afterSwap: card => { bindCopy(card); localizeTimes(card); bindTables(card); initLegends({ document: scoped(card), store, legendKey }); },
    afterStats: () => { localizeTimes($('.statusbar') || document); tickClock(); repaintBar?.(); }
  }
});
// initLegends reads and creates through `document`; a swapped-in card is initialised through a view of just that card.
function scoped(card) { return { querySelectorAll: q => card.querySelectorAll(q), querySelector: q => card.querySelector(q), createElement: t => document.createElement(t) }; }

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
function bindTables(scope = document) { for (const region of $$('[data-tregion]', scope)) bindTable(region); }
function bindTable(region) {
  if (region.dataset.tbound) return; region.dataset.tbound = '1';
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
bindTables();

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
  const cardById = id => cards().find(c => c.dataset.card === id);
  const colsNow = () => COLS[bpNow()] || 0;
  const gap = () => parseFloat(getComputedStyle(grid).columnGap) || 0;
  const titleOf = c => ($(':scope > header h2', c) || $('.l', c))?.textContent.trim() || c.dataset.card;
  const spanProp = () => (bpNow() === 'tablet' ? '--tspan' : '--span');
  // Two forms. Flow (phone always; desktop and tablet until the viewer edits): the server order with the old saved order, widths and
  // heights. Free: a saved place and size for every card (grid.mjs), written the first time the viewer changes the layout.
  let lay = { order: [], span: {}, h: {} };
  let st = null;          // the free layout in use { pos, hidden }, or null for flow
  let editing = false;
  const hist = layoutHistory();
  const sel = new Set();   // cards selected in layout mode (box select); never saved
  const saveFlow = () => store.set(key(), { ...lay, collapsed: readCollapsed() });   // phone: order only
  const persist = () => { if (st) store.set(key(), toSaved(st, readCollapsed())); };

  const VARS = ['--cx', '--cy', '--cw', '--ch'];
  function setBox(c, r) { c.style.setProperty('--cx', r.x); c.style.setProperty('--cy', r.y); c.style.setProperty('--cw', r.w); c.style.setProperty('--ch', r.h); }
  function paintFlow() {
    const bp = bpNow();
    grid.classList.remove('free'); grid.style.removeProperty('--cols');
    lay = applyLayout(ids(), store.get(key()), bp);
    const byId = new Map(cards().map(c => [c.dataset.card, c]));
    for (const id of lay.order) grid.append(byId.get(id));
    for (const c of cards()) {
      const id = c.dataset.card;
      for (const v of VARS) c.style.removeProperty(v);
      c.classList.remove('lay-hidden');
      c.style.setProperty('--span', bp === 'desktop' && lay.span[id] ? lay.span[id] : c.dataset.span);   // the server-rendered span is the default
      if (bp === 'tablet' && lay.span[id]) c.style.setProperty('--tspan', lay.span[id]); else c.style.removeProperty('--tspan');
      if (lay.h[id]) { c.style.setProperty('--h', lay.h[id] + 'px'); c.style.alignSelf = 'start'; } else { c.style.removeProperty('--h'); c.style.alignSelf = ''; }   // a sized card is its own height, not the row's
    }
  }
  // Rows a card needs to show all its content at width w (a card with no saved place, or one brought back from the hidden list).
  function naturalRows(c, w) {
    const wasCollapsed = c.classList.contains('collapsed'), wasHidden = c.classList.contains('lay-hidden');
    c.classList.remove('collapsed', 'lay-hidden'); setBox(c, { x: 0, y: 0, w, h: 1 }); c.classList.add('measuring');
    const px = c.offsetHeight;
    c.classList.remove('measuring'); if (wasCollapsed) c.classList.add('collapsed'); if (wasHidden) c.classList.add('lay-hidden');
    return rowsFor(px);
  }
  const defaultW = c => Math.min(colsNow(), Math.max(MIN_W, (Number(c.dataset.span) || 6) * 2));
  const pinnedNow = () => cards().filter(c => c.hasAttribute('data-pin')).map(c => c.dataset.card);   // read each time: a refresh in place may add or remove pinned cards
  function paintFree() {
    const shownHidden = withoutPinned(st, pinnedNow()).hidden;   // painted only: st (and so the undo/redo chain) keeps its hidden list; a pinned id there is just not painted hidden
    const cols = colsNow();
    grid.classList.add('free'); grid.style.setProperty('--cols', cols);
    for (const c of cards()) {
      const id = c.dataset.card, hidden = shownHidden.includes(id);
      if (!hidden && !st.pos[id]) { const w = defaultW(c); st.pos[id] = firstFit(st.pos, w, naturalRows(c, w), cols); }
      c.style.removeProperty('--h'); c.style.alignSelf = '';
      c.classList.toggle('lay-hidden', hidden);
      if (st.pos[id]) setBox(c, st.pos[id]);
    }
  }
  function apply() {
    const pinnedIds = pinnedNow();
    if (!editing) st = bpNow() === 'phone' ? null : sanitizeLayout(store.get(key()), ids(), colsNow(), pinnedIds);
    else st = withoutPinned(st, pinnedIds);
    if (st) paintFree(); else paintFlow();
    renderBar();
  }

  // phone (and anyone without the editor): move a card earlier or later in the order
  for (const b of $$('[data-move]', grid)) b.addEventListener('click', () => {
    if (bpNow() !== 'phone') return;
    const c = b.closest('.card'); lay.order = moveItem(lay.order, c.dataset.card, Number(b.dataset.move)); saveFlow(); paintFlow(); b.focus();
  });

  // ---- the layout editor (desktop and tablet)
  const bar = document.createElement('div');
  bar.className = 'layoutbar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Page layout');
  const mk = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const tool = (name, text, title) => { const e = mk('button', { type: 'button', className: 'btn', textContent: text, title: title || '' }); e.dataset.lay = name; return e; };
  const editBtn = tool('edit', 'Edit layout'); editBtn.setAttribute('aria-pressed', 'false');
  const tools = mk('span', { className: 'lay-tools', hidden: true }, tool('done', 'Done'), tool('undo', 'Undo', 'Undo (Ctrl+Z)'), tool('redo', 'Redo', 'Redo (Ctrl+Shift+Z)'), tool('group', 'Group', 'Group the selected cards so they move as one block'), tool('ungroup', 'Ungroup', 'Split the selected group back into single cards'), tool('tidy', 'Tidy up', 'Slide cards up to close gaps'), tool('reset', 'Reset to default', 'Back to the standard arrangement for this page'));
  // The card picker: every card available for this page; the ones on the page can be removed, the others added. Cards not chosen are simply not on the page.
  const hiddenBox = mk('details', { className: 'lay-hiddens', hidden: true }, mk('summary', {}, 'Cards (', mk('span', { textContent: '0' }), ' of ', mk('span', { textContent: '0' }), ')'), mk('ul'));
  const nums = $$('summary span', hiddenBox); nums[0].dataset.n = ''; nums[1].dataset.total = '';
  const hint = mk('span', { className: 'lay-hint', id: 'lay-help', hidden: true, textContent: 'Drag on empty space to select several cards, then Group them so they move as one (Shift+click adds or removes a card from the selection). Drag a card anywhere to move it; drag an edge or corner to resize. With the keyboard, focus a card and use the arrow keys to move it and Shift with the arrow keys to resize. Live refresh is paused while you edit.' });
  hint.dataset.hint = '';
  bar.append(editBtn, tools, hiddenBox, hint, mk('span', { className: 'lay-live' }));
  $('.lay-live', bar).setAttribute('role', 'status'); $('.lay-live', bar).setAttribute('aria-live', 'polite');
  if (cards().length) grid.before(bar);   // every grid with cards gets the editor (issue #929), whether or not the card has phone move buttons
  const live = $('.lay-live', bar);
  const say = t => { live.textContent = ''; setTimeout(() => { live.textContent = t; }, 30); };
  const btn = n => $(`[data-lay=${n}]`, bar);
  function renderBar() {
    if (!bar.isConnected) return;
    const hidden = st ? st.hidden : [];
    $('[data-lay=edit]', bar).setAttribute('aria-pressed', String(editing));
    $('[data-lay=edit]', bar).hidden = editing;
    $('.lay-tools', bar).hidden = !editing; $('[data-hint]', bar).hidden = !editing;
    if (btn('undo')) { btn('undo').disabled = !hist.canUndo; btn('redo').disabled = !hist.canRedo; }
    if (btn('group')) { btn('group').disabled = sel.size < 2; btn('ungroup').disabled = ![...sel].some(i => st && groupOf(st.groups, i)); }
    const det = $('.lay-hiddens', bar); det.hidden = !(editing || hidden.length);
    $('[data-n]', det).textContent = cards().length - hidden.length; $('[data-total]', det).textContent = cards().length;
    const ul = $('ul', det); ul.textContent = '';
    for (const c of cards()) {
      const id = c.dataset.card, on = !hidden.includes(id), pinned = !canHide(id, c.hasAttribute('data-pin'));
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.className = 'btn'; b.textContent = on ? 'Remove' : 'Add'; b.disabled = on && (pinned || !editing);
      b.setAttribute('aria-label', `${on ? 'Remove' : 'Add'} ${titleOf(c)}${pinned ? ' (always shown)' : ''}`);
      b.addEventListener('click', () => (on ? hideCard(id) : showCard(id)));
      li.append(Object.assign(document.createElement('span'), { textContent: titleOf(c) + (on ? '' : ' (not on page)') }), b); ul.append(li);
    }
    if (!editing && !hidden.length) det.open = false;
    for (const c of cards()) { c.classList.toggle('lay-selected', sel.has(c.dataset.card)); c.classList.toggle('lay-grouped', !!(st && groupOf(st.groups, c.dataset.card))); }
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function change(next, note) {
    hist.push(st); st = next; persist(); paintFree(); renderBar(); if (note) say(note);
  }
  // The cards as drawn right now (flow, with any old saved layout), in cells. Collapsed cards count at their full size.
  function convertFlow() {
    const cols = colsNow(), shut = cards().filter(c => c.classList.contains('collapsed'));
    for (const c of shut) c.classList.remove('collapsed');
    const g = grid.getBoundingClientRect(), colPitch = (g.width + gap()) / cols;
    const boxes = cards().filter(c => c.offsetParent).map(c => { const r = c.getBoundingClientRect(); return { id: c.dataset.card, left: r.left - g.left, top: r.top - g.top, width: r.width, height: r.height }; });
    for (const c of shut) c.classList.add('collapsed');
    return { pos: fromBoxes(boxes, { colPitch, cols }), hidden: [], groups: [] };
  }
  const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
  function decorate(on) {
    for (const c of cards()) {
      if (on) {
        c.tabIndex = 0; c.setAttribute('aria-roledescription', 'movable card'); c.setAttribute('aria-describedby', 'lay-help');
        for (const f of $$('a,button,input,select,textarea,summary,[tabindex]', c)) if (f !== c) { f.dataset.layTi = f.getAttribute('tabindex') ?? ''; f.tabIndex = -1; }
        if (canHide(c.dataset.card, c.hasAttribute('data-pin'))) {
          const h = document.createElement('button'); h.type = 'button'; h.className = 'lay-hide'; h.textContent = 'Hide'; h.setAttribute('aria-label', `Hide ${titleOf(c)}`); h.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); hideCard(c.dataset.card); }); c.append(h);   // a card that is itself a link (a KPI) must not follow it
        }
      } else {
        $('.lay-hide', c)?.remove(); c.style.cursor = '';
        c.removeAttribute('aria-roledescription'); c.removeAttribute('aria-describedby');
        if (c.tagName !== 'A') c.removeAttribute('tabindex');
        for (const f of $$('[data-lay-ti]', c)) { if (f.dataset.layTi === '') f.removeAttribute('tabindex'); else f.setAttribute('tabindex', f.dataset.layTi); delete f.dataset.layTi; }
      }
    }
  }
  function startEditing() {
    if (editing || bpNow() === 'phone') return;
    if (!st) { st = convertFlow(); }
    editing = true; hist.clear(); sel.clear();
    document.body.classList.add('layout-editing'); grid.classList.add('editing');
    paintFree(); decorate(true); renderBar(); say('Layout mode on. Drag cards to move them and their edges to resize.');
    $('[data-lay=done]', bar).focus({ preventScroll: true });
  }
  function stopEditing() {
    if (!editing) return;
    finishAct(false); editing = false; sel.clear(); decorate(false);
    document.body.classList.remove('layout-editing'); grid.classList.remove('editing');
    apply(); say('Layout mode off.'); $('[data-lay=edit]', bar).focus({ preventScroll: true });
  }
  function hideCard(id) {
    const c = cardById(id); if (!st || !c || !canHide(id, c.hasAttribute('data-pin')) || st.hidden.includes(id)) return;
    const pos = { ...st.pos }; delete pos[id];
    sel.delete(id);
    change({ pos, hidden: [...st.hidden, id], groups: withoutCard(st.groups, id) }, `${titleOf(c)} removed from the page. Use Cards to add it back.`);
    if (editing) { c.classList.add('lay-hidden'); $('[data-lay=done]', bar).focus({ preventScroll: true }); }
  }
  function showCard(id) {
    const c = cardById(id); if (!st || !c) return;
    const w = defaultW(c), pos = { ...st.pos }; pos[id] = firstFit(pos, w, naturalRows(c, w), colsNow());
    change({ pos, hidden: st.hidden.filter(i => i !== id), groups: st.groups }, `${titleOf(c)} added to the page.`);
    c.scrollIntoView({ block: 'nearest' });
  }
  function undoRedo(redo) {
    const prev = redo ? hist.redo(st) : hist.undo(st); if (!prev) return;
    st = prev; persist(); paintFree(); renderBar(); say(redo ? 'Redone.' : 'Undone.');
  }
  function resetDefault() {
    hist.push(st);
    const keep = readCollapsed(); if (keep.length) store.set(key(), { collapsed: keep }); else store.del(key());
    paintFlow(); st = convertFlow(); paintFree(); renderBar(); say('Back to the default layout for this page.');
  }

  // ---- drag and resize with the pointer
  let act = null, scrollTimer = 0;
  function showPreview() {
    const cols = colsNow(), g = grid.getBoundingClientRect(), colPitch = (g.width + gap()) / cols;
    const dx = act.x - act.x0, dy = act.y - act.y0 + (scrollY - act.scroll0);
    const target = act.edge ? resizeRect(act.from, act.edge, Math.round(dx / colPitch), Math.round(dy / ROW_PITCH), cols) : dragRect(act.from, Math.round(dx / colPitch), Math.round(dy / ROW_PITCH), cols);
    act.target = target;
    act.preview = act.members && !act.edge ? placeGroup(act.base.pos, act.members, target.x - act.from.x, target.y - act.from.y, cols) : placeCard(act.base.pos, act.id, target, cols);
    if (act.members && !act.edge) act.target = act.preview[act.id];
    for (const c of cards()) { const r = act.preview[c.dataset.card]; if (r && c !== act.c) setBox(c, r); }
    if (act.edge) { setBox(act.c, target); act.ghost.hidden = true; }
    else { setBox(act.c, act.from); act.c.style.transform = `translate(${dx}px,${dy}px)`; setBox(act.ghost, act.target); act.ghost.hidden = false; }
  }
  function finishAct(commit) {
    if (!act) return;
    const a = act; act = null; clearInterval(scrollTimer);
    a.ghost.remove(); a.c.classList.remove('lay-active'); a.c.style.transform = '';
    try { a.c.releasePointerCapture(a.pid); } catch { /* already released */ }
    if (commit && a.preview && !same(a.preview, a.base.pos)) {
      change({ pos: a.preview, hidden: a.base.hidden, groups: a.base.groups }, `${titleOf(a.c)}${a.members ? ' and its group' : ''}: column ${a.target.x + 1}, row ${a.target.y + 1}, ${a.target.w} wide, ${a.target.h} high.`);
    } else paintFree();
  }
  grid.addEventListener('pointerdown', e => {
    if (!editing || e.button > 0 || act || e.target.closest('.lay-hide')) return;
    const c = e.target.closest('.card[data-card]');
    if (!c) { startBox(e); return; }
    if (!st.pos[c.dataset.card]) return;
    if (e.shiftKey) { e.preventDefault(); toggleSel(c.dataset.card); return; }
    e.preventDefault(); c.focus({ preventScroll: true });
    if (!sel.has(c.dataset.card)) { sel.clear(); renderBar(); }
    try { c.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    const ghost = document.createElement('div'); ghost.className = 'lay-ghost'; ghost.hidden = true; grid.append(ghost);
    act = { c, id: c.dataset.card, edge: edgeAt(c.getBoundingClientRect(), e.clientX, e.clientY, 10), x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, scroll0: scrollY, pid: e.pointerId, base: JSON.parse(JSON.stringify(st)), from: { ...st.pos[c.dataset.card] }, ghost, members: groupOf(st.groups, c.dataset.card) };
    c.classList.add('lay-active');
    // edge scrolling is gentle and proportional: the nearer the pointer is to the window edge, the faster, and nothing in the middle
    scrollTimer = setInterval(() => { if (!act) return; const z = 36, d = act.y > innerHeight - z ? Math.ceil((act.y - (innerHeight - z)) / z * 14) : act.y < z ? -Math.ceil((z - act.y) / z * 14) : 0; if (d) { scrollBy(0, d); showPreview(); } }, 30);
  });
  grid.addEventListener('pointermove', e => {
    if (!editing) return;
    if (act) { act.x = e.clientX; act.y = e.clientY; if (!act.raf) act.raf = requestAnimationFrame(() => { if (act) { act.raf = 0; showPreview(); } }); return; }   // one preview per frame, always from the latest pointer position
    const c = e.target.closest?.('.card[data-card]'); if (c) c.style.cursor = CURSORS[edgeAt(c.getBoundingClientRect(), e.clientX, e.clientY, 10)] || '';
  });
  grid.addEventListener('pointerup', e => { if (act) { act.x = e.clientX; act.y = e.clientY; showPreview(); } finishAct(true); });   // land where the pointer is, not where the last frame was
  grid.addEventListener('pointercancel', () => finishAct(false));
  grid.addEventListener('dragstart', e => { if (editing) e.preventDefault(); });
  grid.addEventListener('click', e => { if (editing && !e.target.closest('.lay-hide')) e.preventDefault(); }, true);
  // box select: drag on empty space; every card the box touches is selected, and a grouped card brings its whole group
  const withGroups = list => { const out = new Set(list); for (const i of list) for (const m of groupOf(st.groups, i) || []) out.add(m); return out; };
  function toggleSel(id) {
    const grp = groupOf(st.groups, id) || [id], on = !sel.has(id);
    for (const m of grp) { if (on) sel.add(m); else sel.delete(m); }
    renderBar();
  }
  function startBox(e) {
    if (e.target.closest('.lay-ghost')) return;
    e.preventDefault();
    const g = grid.getBoundingClientRect(), x0 = e.clientX, y0 = e.clientY, sc0 = scrollY;
    const box = document.createElement('div'); box.className = 'lay-box'; box.hidden = true; grid.append(box);
    const rect = (x, y) => { const y1 = y0 - (scrollY - sc0); return { left: Math.min(x0, x), right: Math.max(x0, x), top: Math.min(y1, y), bottom: Math.max(y1, y) }; };
    const hit = r => cards().filter(c => st.pos[c.dataset.card]).filter(c => { const b = c.getBoundingClientRect(); return b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom; }).map(c => c.dataset.card);
    const move = ev => { const r = rect(ev.clientX, ev.clientY); box.hidden = false; Object.assign(box.style, { left: r.left - g.left + 'px', top: r.top - g.top + 'px', width: r.right - r.left + 'px', height: r.bottom - r.top + 'px' }); };
    const end = ev => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', end); removeEventListener('pointercancel', end);
      const r = rect(ev.clientX, ev.clientY), moved = r.right - r.left > 4 || r.bottom - r.top > 4; box.remove();
      if (ev.type === 'pointercancel') return;
      if (!e.shiftKey) sel.clear();
      if (moved) for (const i of withGroups(hit(r))) sel.add(i);
      renderBar(); if (moved) say(sel.size ? `${sel.size} card${sel.size === 1 ? '' : 's'} selected.` : 'No cards selected.');
    };
    addEventListener('pointermove', move); addEventListener('pointerup', end); addEventListener('pointercancel', end);
  }
  // keyboard: arrows move the focused card one cell, Shift+arrows resize it from its east and south edges
  grid.addEventListener('keydown', e => {
    if (!editing || e.target.closest('.lay-hide') || !e.target.matches?.('.card[data-card]')) return;
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key]; if (!d) return;
    e.preventDefault();
    const id = e.target.dataset.card, r = st.pos[id]; if (!r) return;
    const t = e.shiftKey ? resizeRect(r, d[0] ? 'e' : 's', d[0], d[1], colsNow()) : dragRect(r, d[0], d[1], colsNow()), grp = e.shiftKey ? null : groupOf(st.groups, id), next = grp ? placeGroup(st.pos, grp, d[0], d[1], colsNow()) : placeCard(st.pos, id, t, colsNow());
    if (!same(next, st.pos)) { change({ pos: next, hidden: st.hidden, groups: st.groups }, `${titleOf(e.target)}: column ${t.x + 1}, row ${t.y + 1}, ${t.w} wide, ${t.h} high.`); cardById(id)?.focus({ preventScroll: false }); }
  });
  addEventListener('keydown', e => {
    if (!editing) return;
    if (e.key === 'Escape' && act) { finishAct(false); return; }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z' && !e.target.closest?.('input,textarea,select')) { e.preventDefault(); undoRedo(e.shiftKey); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y' && !e.target.closest?.('input,textarea,select')) { e.preventDefault(); undoRedo(true); }
  });
  bar.addEventListener('click', e => {
    const b = e.target.closest('[data-lay]'); if (!b) return;
    ({ edit: startEditing, done: stopEditing, undo: () => undoRedo(false), redo: () => undoRedo(true), reset: resetDefault,
      tidy: () => { const next = compactGroups(st.pos, st.groups); if (!same(next, st.pos)) change({ pos: next, hidden: st.hidden, groups: st.groups }, 'Gaps closed.'); },
      group: () => { if (sel.size < 2) return; change({ pos: st.pos, hidden: st.hidden, groups: addGroup(st.groups, [...sel]) }, `${sel.size} cards grouped. They now move as one block.`); },
      ungroup: () => { const groups = removeGroups(st.groups, [...sel]); if (groups.length !== st.groups.length) change({ pos: st.pos, hidden: st.hidden, groups }, 'Group split into single cards.'); } })[b.dataset.lay]?.();
  });
  apply(); let last = bpNow(); addEventListener('resize', () => { if (bpNow() !== last) { last = bpNow(); if (editing) stopEditing(); apply(); } });
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

// sticky app bar and resizable vertical menu (issue #924); both remembered per viewer
{
  const NAVW = { min: 140, max: 480, def: 208 };
  const clampW = n => Math.min(NAVW.max, Math.max(NAVW.min, Math.round(n)));
  const sticky = $('#sticky'), bar = $('.statusbar');
  const applySticky = () => { const on = store.get('dash.sticky') === true; if (on) root.dataset.sticky = 'on'; else delete root.dataset.sticky; sticky?.setAttribute('aria-pressed', String(on)); };
  const measure = () => { if (bar) root.style.setProperty('--bar-real', bar.offsetHeight + 'px'); };
  applySticky(); measure(); addEventListener('resize', measure);
  sticky?.addEventListener('click', () => { store.set('dash.sticky', store.get('dash.sticky') !== true); applySticky(); });
  const sep = $('[data-nav-resize]'), nav = $('#nav');
  const setW = (n, save) => { const w = clampW(n); root.style.setProperty('--nav-w', w + 'px'); sep?.setAttribute('aria-valuenow', String(w)); if (save) store.set('dash.navw', w); };
  const saved = store.get('dash.navw'); if (typeof saved === 'number') setW(saved, false);
  if (sep) { sep.setAttribute('aria-valuemin', String(NAVW.min)); sep.setAttribute('aria-valuemax', String(NAVW.max)); }
  sep?.addEventListener('keydown', e => {
    const cur = nav.getBoundingClientRect().width, dir = root.dataset.dock === 'right' ? -1 : 1;
    const to = { ArrowLeft: cur - 16 * dir, ArrowRight: cur + 16 * dir, Home: NAVW.def }[e.key]; if (to === undefined) return;
    e.preventDefault(); setW(to, true);
  });
  sep?.addEventListener('pointerdown', e => {
    e.preventDefault(); sep.setPointerCapture(e.pointerId); sep.classList.add('drag');
    const left = nav.getBoundingClientRect().left, right = nav.getBoundingClientRect().right, rightDock = root.dataset.dock === 'right';
    const move = ev => setW(rightDock ? right - ev.clientX : ev.clientX - left, false);
    const end = ev => { sep.removeEventListener('pointermove', move); sep.removeEventListener('pointerup', end); sep.removeEventListener('pointercancel', end); sep.classList.remove('drag'); setW(rightDock ? right - ev.clientX : ev.clientX - left, ev.type === 'pointerup'); if (ev.type === 'pointercancel') { const s2 = store.get('dash.navw'); if (typeof s2 === 'number') setW(s2, false); else root.style.removeProperty('--nav-w'); } };
    sep.addEventListener('pointermove', move); sep.addEventListener('pointerup', end); sep.addEventListener('pointercancel', end);
  });
}

// Changing the range on a chart updates the chart cards in place (issue #926): fetch the same page, swap each chart card's title, range
// selector and chart, and keep the scroll position. Any failure falls back to a normal navigation, which restores the scroll position.
let rangeSeq = 0;
async function loadRange(url) {
  const seq = ++rangeSeq, y = scrollY, target = url.pathname + url.search;
  try {
    const res = await fetch(target, { headers: { accept: 'text/html' }, credentials: 'same-origin' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
    if (seq !== rangeSeq) return;   // a newer choice superseded this one
    const fresh = [...doc.querySelectorAll('.card.chart-card')];
    const swaps = $$('.card.chart-card').map(c => [c, fresh.find(n => n.dataset.card === c.dataset.card)]).filter(([, n]) => n && $('header', n));
    if (!swaps.some(([c, n]) => $('.ranges', c) && $('.ranges', n))) throw new Error('no range selector');
    for (const [c, n] of swaps) {
      $('h2', c).textContent = $('h2', n).textContent;
      const sel = $('.ranges', c), nsel = $('.ranges', n); if (sel && nsel) sel.replaceWith(nsel);
      const head = $('header', c); while (head.nextSibling) head.nextSibling.remove();
      for (let el = $('header', n).nextSibling; el; el = el.nextSibling) c.append(el.cloneNode(true));
      initLegends({ document, root: c, store, legendKey });
      initChartOptions({ document, root: c, store });
      localizeTimes(c);
    }
    history.replaceState(history.state, '', target + url.hash);
    if (scrollY !== y) scrollTo(scrollX, y);
  } catch { if (seq === rangeSeq) fallbackNavigate(target); }
}

// remembered time range, per viewer (issue #140). The server renders the default (7d) when the address has no range; the saved choice is
// applied by reloading once with it in the address, and a click on a range saves it.
{
  const links = $$('.ranges a'); if (links.length) {
    const cur = $('.ranges a[aria-current]')?.textContent.trim(), q = new URLSearchParams(location.search);
    const want = chooseRange(store.get('dash.range'), q.get('range'));
    if (!q.has('range') && want !== cur && links.some(a => a.textContent.trim() === want)) { q.set('range', want); location.replace(location.pathname + '?' + q + location.hash); }
    for (const a of links) a.addEventListener('click', () => store.set('dash.range', a.textContent.trim()));
    // a range link inside a chart card updates the charts in place instead of reloading (issue #926); delegated, as the links are swapped
    document.addEventListener('click', e => {
      const a = e.target.closest?.('.chart-card [aria-label="Time range"] a[href]');
      if (!a || e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const u = new URL(a.href, location.href); if (u.origin !== location.origin || u.pathname !== location.pathname) return;
      store.set('dash.range', a.textContent.trim());
      e.preventDefault(); loadRange(u);
    });
    if (q.has('range') && cur) store.set('dash.range', cur);
  }
}

// Local time (issue #76): the server renders UTC; every <time data-local> is rewritten in this browser's time zone. Data stays UTC.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
function localizeTimes(scope = document) {   // also run on the Next element refreshNext swaps in, so its time is not left in UTC
  for (const el of $$('time[data-local]', scope)) {
    if (el.classList.contains('lz')) continue;   // already converted by layout-early.js before the first paint (issue #493)
    const ms = Date.parse(el.getAttribute('datetime'));
    if (!Number.isFinite(ms)) continue;
    el.title = `${el.textContent} (stored in UTC); shown in your time zone, ${zone}`;
    el.textContent = formatLocal(ms, zone);
  }
  // Chart axis labels and tooltips (SVG cannot hold <time>): rebuilt from their template in this zone.
  for (const el of $$('[data-lms]', scope)) {
    if (el.classList.contains('lz')) continue;
    const ms = Number(el.getAttribute('data-lms'));
    if (!Number.isFinite(ms)) continue;
    const t = el.hasAttribute('data-tonly') ? timeOnly(ms, zone) : formatLocal(ms, zone);
    el.textContent = (el.getAttribute('data-tpl') || '{t}').replace('{t}', () => t);
  }
}
localizeTimes();
document.documentElement.classList.remove('tzp');   // normally already removed by layout-early.js
{
  const note = $('#tznote');
  if (note) note.textContent = `Times are shown in your time zone (${zone}). Data is stored in UTC; hover a time to see it.`;
}

// The cooldown notice (issue #483) arrives as ?notice=mark-read-cooldown. Once it is on screen, drop it from the address so a reload or
// bookmark does not show "that click was ignored" again. Other query parameters (range, filters) are kept.
// app bar editing (issue #927): rearrange, remove and add its items; saved per viewer. Not on a phone (the bar is a fixed layout there).
{
  const bar = $('.statusbar'), editBtn = $('#barEdit');
  if (bar && editBtn) {
    const items = () => $$(':scope > [data-bar]', bar).filter(el => !FIXED.includes(el.dataset.bar));
    const itemIds = () => items().map(el => el.dataset.bar);
    const itemById = id => items().find(el => el.dataset.bar === id);
    const nameOf = el => el.dataset.barName || el.dataset.bar;
    let state = sanitizeBar(store.get(BAR_KEY), itemIds()), editing = false;
    const picker = document.createElement('details'); picker.className = 'bar-picker'; picker.hidden = true;
    picker.append(Object.assign(document.createElement('summary'), { textContent: 'Add item' }), document.createElement('ul'));
    editBtn.after(picker);
    const save = () => { const raw = barToSaved(state); if (!state.removed.length && JSON.stringify(state.order) === JSON.stringify(itemIds())) store.del(BAR_KEY); else store.set(BAR_KEY, raw); };
    function paint() {
      const phone = bpNow() === 'phone';
      state = sanitizeBar(barToSaved(state), itemIds());
      items().forEach(el => { const i = state.order.indexOf(el.dataset.bar); el.style.order = phone || i < 0 ? '' : String(10 + i); el.classList.toggle('bar-removed', !phone && state.removed.includes(el.dataset.bar)); });
      bar.classList.toggle('bar-editing', editing && !phone);
      editBtn.setAttribute('aria-pressed', String(editing)); editBtn.textContent = editing ? 'Done' : 'Edit bar';
      for (const el of items()) $('.bar-ctl', el)?.remove();
      if (editing && !phone) for (const el of items()) {
        if (el.classList.contains('bar-removed')) continue;
        const id = el.dataset.bar, i = state.order.indexOf(id), ctl = document.createElement('span'); ctl.className = 'bar-ctl';
        const b = (t, label, fn, off) => { const x = document.createElement('button'); x.type = 'button'; x.textContent = t; x.setAttribute('aria-label', label + ' ' + nameOf(el)); x.disabled = !!off; x.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); fn(); }); return x; };
        ctl.append(b('◀', 'Move earlier:', () => act(moveBarItem(state, id, -1), id), i <= 0), b('▶', 'Move later:', () => act(moveBarItem(state, id, 1), id), i >= state.order.length - 1), b('✕', 'Remove', () => act(removeBarItem(state, id))));
        el.append(ctl);
      }
      const ul = $('ul', picker); ul.textContent = '';
      for (const id of state.removed) {
        const li = document.createElement('li'), x = document.createElement('button'); x.type = 'button'; x.className = 'btn'; x.textContent = 'Add'; x.setAttribute('aria-label', 'Add ' + nameOf(itemById(id)));
        x.addEventListener('click', () => act(addBarItem(state, id)));
        li.append(Object.assign(document.createElement('span'), { textContent: nameOf(itemById(id)) }), x); ul.append(li);
      }
      picker.hidden = !(editing && !phone && state.removed.length); if (picker.hidden) picker.open = false;
    }
    function act(next, focusId) { state = next; save(); paint(); if (focusId) $('.bar-ctl button:not(:disabled)', itemById(focusId))?.focus({ preventScroll: true }); }
    editBtn.addEventListener('click', () => { editing = !editing; paint(); });
    addEventListener('resize', paint);
    repaintBar = paint;
    paint();
  }
}

try {
  const u = new URL(location.href);
  if (u.searchParams.get('notice') === 'mark-read-cooldown' && history.replaceState) {
    u.searchParams.delete('notice');
    history.replaceState(history.state, '', u.pathname + u.search + u.hash);
  }
} catch { /* the notice just stays in the address bar */ }
