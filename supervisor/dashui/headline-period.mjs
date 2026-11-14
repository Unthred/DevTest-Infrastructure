// Issue #1453: the period each summary card shows (Last 24 hours or Last 7 days). Kept per card, per page and breakpoint, in this browser
// (`dash.period.<page>.<breakpoint>`); layout-early.js applies it before the first paint. This module keeps the control, saves a click and
// draws the choice again after a resize. It starts itself when imported, so app.js needs only the import.
import { breakpointOf } from './logic.mjs';

export const PERIODS = ['24h', '7d'];

// { id: '24h' | '7d' } for the cards that exist and a known period; anything else is dropped.
export function sanitizePeriods(saved, ids) {
  const out = {};
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return out;
  for (const id of ids) if (Object.hasOwn(saved, id) && PERIODS.includes(saved[id])) out[id] = saved[id];
  return out;
}

// The saved record with one card's period set; the default period is not stored.
export function withPeriod(saved, id, period) {
  const next = { ...(saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}) };
  if (period === PERIODS[0]) delete next[id]; else next[id] = period;
  return next;
}

export function initHeadlinePeriod({ storage, win, root }) {
  const page = root.querySelector('.cards[data-layout]')?.dataset.layout || win.location.pathname;
  const key = () => `dash.period.${page}.${breakpointOf(win.innerWidth)}`;
  const load = () => { try { return JSON.parse(storage.getItem(key())); } catch { return null; } };
  const save = value => {
    try { if (Object.keys(value).length) storage.setItem(key(), JSON.stringify(value)); else storage.removeItem(key()); } catch { /* private mode: not remembered */ }
  };
  const cards = () => [...root.querySelectorAll('.card.headline[data-card]')];
  function paint() {
    const saved = sanitizePeriods(load(), cards().map(c => c.dataset.card));
    for (const c of cards()) {
      const period = saved[c.dataset.card] || PERIODS[0];
      c.dataset.period = period;
      for (const b of c.querySelectorAll('[data-hl-period]')) b.setAttribute('aria-pressed', String(b.dataset.hlPeriod === period));
    }
  }
  root.addEventListener('click', e => {
    const b = e.target.closest?.('[data-hl-period]');
    if (!b) return;
    save(withPeriod(load(), b.closest('.card').dataset.card, b.dataset.hlPeriod));
    paint();
  });
  win.addEventListener('resize', paint);
  paint();
}

if (typeof document !== 'undefined') initHeadlinePeriod({ storage: localStorage, win: window, root: document });
