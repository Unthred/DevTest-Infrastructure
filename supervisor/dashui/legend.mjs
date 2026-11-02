// Chart legend toggles (issues #160, #190). Kept apart from app.js so a test can drive it with a small fake DOM.
import { sanitizeHidden, toggleSeries } from './logic.mjs';

// `store` is { get, set, del }; `legendKey` the per-page storage key. Marker-only items (data-marker, e.g. "Window reset") toggle
// freely and are not counted when guarding the last visible series.
export function initLegends({ document, store, legendKey }) {
  const $ = (s, r) => r.querySelector(s), $$ = (s, r) => [...r.querySelectorAll(s)];
  const legendState = () => { const v = store.get(legendKey); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  for (const fig of $$('figure.chart', document)) {
    const legend = $('.legend', fig); if (!legend) continue;
    const id = fig.closest('.card')?.dataset.card || $('svg', fig)?.getAttribute('aria-label') || 'chart';
    const buttons = $$('button[data-series]', legend), isMarker = b => b.dataset.marker === 'true';
    const all = buttons.filter(b => !isMarker(b)).map(b => b.dataset.series), free = buttons.filter(isMarker).map(b => b.dataset.series);
    const showAll = document.createElement('button'); showAll.type = 'button'; showAll.className = 'legend-all'; showAll.textContent = 'Show all'; legend.append(showAll);
    let hidden = sanitizeHidden(legendState()[id], all, free);
    const paint = () => {
      for (const b of buttons) b.setAttribute('aria-pressed', String(!hidden.includes(b.dataset.series)));
      for (const el of $$('[data-series]', fig)) if (!legend.contains(el)) el.classList.toggle('off', hidden.includes(el.dataset.series));
      showAll.hidden = hidden.length === 0;
    };
    const save = () => { const st = legendState(); if (hidden.length) st[id] = hidden; else delete st[id]; if (Object.keys(st).length) store.set(legendKey, st); else store.del(legendKey); };
    for (const b of buttons) b.addEventListener('click', () => { hidden = toggleSeries(hidden, b.dataset.series, all, free); paint(); save(); });
    showAll.addEventListener('click', () => { hidden = []; paint(); save(); });
    paint();
  }
}

// Reset layout (issue #190): clears the saved layout and this page's legend state, then reloads. `layoutKey` is a function (the key depends on the breakpoint).
export function initResetLayout({ document, store, layoutKey, legendKey, reload }) {
  document.querySelector('[data-reset-layout]')?.addEventListener('click', () => { store.del(layoutKey()); store.del(legendKey); reload(); });
}
