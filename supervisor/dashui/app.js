// Dashboard v2 browser script (issue #54): progressive enhancement only. Every page is complete without it; this adds
// the live countdown, theme choice, legend toggles, chart expand, and drag/resize/reorder of cards (saved per breakpoint,
// in this browser only). It reads nothing from the network and sends nothing.
import { COPY_FEEDBACK_MS, applyLayout, breakpointOf, copyFeedback, copyMethods, moveItem } from './logic.mjs';

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

// movable cards
const grid = $('.cards[data-layout]');
if (grid) {
  const page = grid.dataset.layout, bp = () => breakpointOf(innerWidth);
  const key = () => `dash.layout.${page}.${bp()}`;
  const cards = () => $$(':scope > .card[data-card]', grid);
  const ids = () => cards().map(c => c.dataset.card);
  const save = layout => store.set(key(), layout);
  function apply() {
    const lay = applyLayout(ids(), store.get(key()), bp());
    const byId = new Map(cards().map(c => [c.dataset.card, c]));
    for (const id of lay.order) grid.append(byId.get(id));
    for (const c of cards()) c.style.setProperty('--span', lay.span[c.dataset.card] ?? c.dataset.span);   // default span comes from the server-rendered data-span
  }
  const current = () => ({ order: ids(), span: Object.fromEntries(cards().filter(c => c.style.getPropertyValue('--span') !== c.dataset.span).map(c => [c.dataset.card, Number(c.style.getPropertyValue('--span'))])) });
  apply(); let last = bp(); addEventListener('resize', () => { if (bp() !== last) { last = bp(); apply(); } });
  // keyboard / touch reorder
  for (const b of $$('[data-move]', grid)) b.addEventListener('click', () => {
    const c = b.closest('.card'), lay = current(); lay.order = moveItem(lay.order, c.dataset.card, Number(b.dataset.move)); save(lay); apply(); b.focus();
  });
  // drag to reorder (pointer devices)
  let drag = null;
  for (const c of cards()) {
    const h = $('[data-handle]', c); if (!h) continue;
    h.draggable = true;
    h.addEventListener('dragstart', e => { drag = c; c.classList.add('dragging'); e.dataTransfer.setData('text/plain', c.dataset.card); e.dataTransfer.effectAllowed = 'move'; });
    h.addEventListener('dragend', () => { c.classList.remove('dragging'); $$('.dropping', grid).forEach(x => x.classList.remove('dropping')); drag = null; });
    c.addEventListener('dragover', e => { if (drag && drag !== c) { e.preventDefault(); c.classList.add('dropping'); } });
    c.addEventListener('dragleave', () => c.classList.remove('dropping'));
    c.addEventListener('drop', e => { e.preventDefault(); if (!drag || drag === c) return; const lay = current(); const from = lay.order.indexOf(drag.dataset.card); lay.order.splice(from, 1); lay.order.splice(lay.order.indexOf(c.dataset.card), 0, drag.dataset.card); save(lay); apply(); });
    // resize: drag the corner, snapping to grid columns (not offered on a phone)
    const rz = $('.resize', c);
    rz?.addEventListener('pointerdown', e => {
      e.preventDefault(); rz.setPointerCapture(e.pointerId);
      const cols = bp() === 'tablet' ? 6 : 12, colW = grid.getBoundingClientRect().width / cols, startX = e.clientX, start = Number(c.style.getPropertyValue('--span')) || Math.round(c.getBoundingClientRect().width / colW);
      const move = ev => c.style.setProperty('--span', String(Math.min(cols, Math.max(2, start + Math.round((ev.clientX - startX) / colW)))));
      const up = () => { rz.removeEventListener('pointermove', move); rz.removeEventListener('pointerup', up); save(current()); };
      rz.addEventListener('pointermove', move); rz.addEventListener('pointerup', up);
    });
    rz?.addEventListener('keydown', e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault(); const cols = bp() === 'tablet' ? 6 : 12; const cur = Number(c.style.getPropertyValue('--span')) || 6; c.style.setProperty('--span', String(Math.min(cols, Math.max(2, cur + (e.key === 'ArrowRight' ? 1 : -1))))); save(current()); });
  }
  $('[data-reset-layout]')?.addEventListener('click', () => { store.del(key()); location.reload(); });
}
