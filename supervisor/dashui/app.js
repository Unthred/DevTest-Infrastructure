// Dashboard v2 browser script (issue #54): progressive enhancement only. Every page is complete without it; this adds
// the live countdown, theme choice, legend toggles, chart expand, copy buttons, drag/resize/reorder of cards, the dockable navigation, Back and
// scroll restoration (all saved per breakpoint, in this browser only). It reads nothing from the network and sends nothing.
import { COPY_FEEDBACK_MS, ROW_STEP, applyLayout, breakpointOf, copyFeedback, copyMethods, dockFromPoint, effectiveDock, moveItem, resizeBox, restorableScroll, sanitizeHidden, toggleSeries } from './logic.mjs';

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
  for (const el of $$('[data-countdown]')) {
    const left = Number(el.dataset.countdown) - Date.now();
    el.textContent = left > 0 ? `in ${fmt(left)}` : 'due now';
  }
}
tickClock(); setInterval(tickClock, 1000);

// legend toggles (issue #160): one handler for every chart. A hidden series stays in the legend (struck through), clicking it
// again shows it, the last visible series cannot be hidden, "Show all" appears while anything is hidden. The hidden set is
// kept per viewer and page in localStorage and re-applied after the page's own refresh; "Reset layout" clears it.
const legendKey = 'dash.legend.' + location.pathname;
const legendState = () => { const v = store.get(legendKey); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
for (const fig of $$('figure.chart')) {
  const legend = $('.legend', fig); if (!legend) continue;
  const id = fig.closest('.card')?.dataset.card || $('svg', fig)?.getAttribute('aria-label') || 'chart';
  const buttons = $$('button[data-series]', legend), all = buttons.map(b => b.dataset.series);
  const showAll = document.createElement('button'); showAll.type = 'button'; showAll.className = 'legend-all'; showAll.textContent = 'Show all'; legend.append(showAll);
  let hidden = sanitizeHidden(legendState()[id], all);
  const paint = () => {
    for (const b of buttons) b.setAttribute('aria-pressed', String(!hidden.includes(b.dataset.series)));
    for (const el of $$('[data-series]', fig)) if (!legend.contains(el)) el.classList.toggle('off', hidden.includes(el.dataset.series));
    showAll.hidden = hidden.length === 0;
  };
  const save = () => { const st = legendState(); if (hidden.length) st[id] = hidden; else delete st[id]; if (Object.keys(st).length) store.set(legendKey, st); else store.del(legendKey); };
  for (const b of buttons) b.addEventListener('click', () => { hidden = toggleSeries(hidden, b.dataset.series, all); paint(); save(); });
  showAll.addEventListener('click', () => { hidden = []; paint(); save(); });
  paint();
}

// expand a chart card to a modal
let scrim = null;
function collapse() { $('.card.expanded')?.classList.remove('expanded'); scrim?.remove(); scrim = null; }
for (const b of $$('[data-expand]')) b.addEventListener('click', () => {
  const card = b.closest('.card'); if (card.classList.contains('expanded')) return collapse();
  collapse(); card.classList.add('expanded'); scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.addEventListener('click', collapse); document.body.append(scrim); b.focus();
});
addEventListener('keydown', e => { if (e.key === 'Escape') collapse(); });

// phone: tap a table row to open it (but not when the tap was on a button, link or the detail toggle inside it)
for (const tr of $$('tr[tabindex]')) tr.addEventListener('click', e => { if (!e.target.closest('button,a,summary,details')) tr.classList.toggle('open'); });

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
for (const b of $$('button[data-copy]')) {
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
const scrollKey = 'dash.scroll.' + location.pathname + location.search;
let scrollSave = 0;
const saveScroll = () => { try { sessionStorage.setItem(scrollKey, JSON.stringify({ y: scrollY, t: Date.now() })); } catch { /* not remembered */ } };
addEventListener('scroll', () => { clearTimeout(scrollSave); scrollSave = setTimeout(saveScroll, 150); }, { passive: true });
addEventListener('pagehide', saveScroll);
function restoreScroll() {
  let rec = null; try { rec = JSON.parse(sessionStorage.getItem(scrollKey)); } catch { rec = null; }
  const navType = performance.getEntriesByType?.('navigation')?.[0]?.type;
  const recent = rec && Date.now() - rec.t < 90000;   // the meta refresh reloads within a minute
  if (!rec || !(navType === 'back_forward' || navType === 'reload' || recent)) return;
  const y = restorableScroll(rec.y, document.documentElement.scrollHeight - innerHeight);
  if (y) scrollTo(0, y);
}
history.scrollRestoration = 'manual';

// movable and resizable cards
const grid = $('.cards[data-layout]');
const bpNow = () => breakpointOf(innerWidth);
if (grid) {
  const page = grid.dataset.layout;
  const key = () => `dash.layout.${page}.${bpNow()}`;
  const cards = () => $$(':scope > .card[data-card]', grid);
  const ids = () => cards().map(c => c.dataset.card);
  let lay = { order: [], span: {}, h: {} };
  const save = () => store.set(key(), lay);
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
      if (lay.h[id]) c.style.setProperty('--h', lay.h[id] + 'px'); else c.style.removeProperty('--h');
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
    const prev = c.style.getPropertyValue('--h'); c.style.setProperty('--h', '0px');
    const h = c.offsetHeight; if (prev) c.style.setProperty('--h', prev); else c.style.removeProperty('--h'); return h;
  }
  function setSize(c, edge, dx, dy, from) {
    const r = resizeBox({ edge, dx, dy, span: from.span, h: from.h, natH: naturalHeight(c), colW: pitch(), type: c.dataset.type, bp: bpNow() });
    c.style.setProperty(spanProp(), r.span); lay.span[c.dataset.card] = r.span;
    if (r.h) { c.style.setProperty('--h', r.h + 'px'); lay.h[c.dataset.card] = r.h; }   // live: the real content reflows at every step
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
  $('[data-reset-layout]')?.addEventListener('click', () => { store.del(key()); store.del(legendKey); location.reload(); });
}
requestAnimationFrame(() => requestAnimationFrame(restoreScroll));

// dockable navigation: top, bottom, left or right; saved per breakpoint; a phone keeps the fixed bottom tab bar
const dockKey = () => 'dash.dock.' + bpNow();
function applyDock() {
  const d = effectiveDock(store.get(dockKey()), bpNow());
  root.dataset.dock = d;
  for (const b of $$('.dockbtn')) b.setAttribute('aria-pressed', String(b.dataset.dock === d));
  const rail = store.get('dash.navrail') === true; if (rail) root.dataset.rail = 'collapsed'; else delete root.dataset.rail;
  $('[data-nav-collapse]')?.setAttribute('aria-pressed', String(rail));
}
applyDock(); { let lastBp = bpNow(); addEventListener('resize', () => { if (bpNow() !== lastBp) { lastBp = bpNow(); applyDock(); } }); }
for (const b of $$('.dockbtn')) b.addEventListener('click', () => { store.set(dockKey(), b.dataset.dock); applyDock(); });
$('[data-nav-collapse]')?.addEventListener('click', () => { store.set('dash.navrail', store.get('dash.navrail') !== true); applyDock(); });
{
  const handle = $('[data-dock-handle]');
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
