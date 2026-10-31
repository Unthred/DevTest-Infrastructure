// Dashboard v2 browser script (issue #54): progressive enhancement only. Every page is complete without it; this adds
// the live countdown, theme choice, legend toggles, chart expand, drag/resize/reorder of cards, the dockable navigation, Back and
// scroll restoration (all saved per breakpoint, in this browser only). It reads nothing from the network and sends nothing.
import { ROW_STEP, applyLayout, breakpointOf, dockFromPoint, effectiveDock, moveItem, resizeBox, restorableScroll } from './logic.mjs';

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

// legend toggles
for (const fig of $$('figure.chart')) for (const b of $$('.legend button', fig.closest('.card') || fig)) {
  b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', String(on));
    for (const el of $$(`[data-series="${CSS.escape(b.dataset.series)}"]`, fig)) el.classList.toggle('off', !on);
  });
}

// expand a chart card to a modal
let scrim = null;
function collapse() { $('.card.expanded')?.classList.remove('expanded'); scrim?.remove(); scrim = null; }
for (const b of $$('[data-expand]')) b.addEventListener('click', () => {
  const card = b.closest('.card'); if (card.classList.contains('expanded')) return collapse();
  collapse(); card.classList.add('expanded'); scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.addEventListener('click', collapse); document.body.append(scrim); b.focus();
});
addEventListener('keydown', e => { if (e.key === 'Escape') collapse(); });

// phone: tap a table row to open it
for (const tr of $$('tr[tabindex]')) tr.addEventListener('click', () => tr.classList.toggle('open'));

// scrollbars appear while a scroller is moving (hover is handled in CSS)
const scrollTimers = new WeakMap();
addEventListener('scroll', e => {
  const el = e.target === document ? document.documentElement : e.target; if (!el.classList) return;
  el.classList.add('is-scrolling'); clearTimeout(scrollTimers.get(el));
  scrollTimers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), 900));
}, { capture: true, passive: true });

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
  $('[data-reset-layout]')?.addEventListener('click', () => { store.del(key()); location.reload(); });
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
