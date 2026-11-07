// Per-chart display options (issue #926): the drawing style (allowance charts only) and the legend position. Saved per chart id in this
// browser. Kept apart from app.js so a test can drive it with a small fake DOM. Unknown stored values fall back to the defaults.
export const LEGEND_POSITIONS = ['top', 'right', 'bottom', 'hidden'];
export const DEFAULT_LEGEND = 'bottom';
// Style names, matching CHART_STYLES in dashrender.mjs (a test keeps the two lists in step).
export const STYLE_LABELS = { line: 'Line', area: 'Line with shaded area', step: 'Stepped line', stack: 'Stacked area (sum of readings)', bars: 'Bars per day (daily peak) with line' };
export const pickOption = (value, allowed, fallback) => (typeof value === 'string' && allowed.includes(value) ? value : fallback);

// `store` is { get, set, del }; `root` is the document or one card (after an in-place range change swaps the chart).
export function initChartOptions({ document, root = document, store, key = 'dash.chartopts' }) {
  const $$ = (s, r) => [...r.querySelectorAll(s)];
  const all = () => { const v = store.get(key); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; };
  for (const fig of $$('figure.chart', root)) {
    if (fig.dataset.opts === '1') continue;
    const legend = fig.querySelector('.legend'), styles = (fig.dataset.styles || '').split(' ').filter(Boolean);
    if (!legend && !styles.length) continue;
    fig.dataset.opts = '1';
    const id = fig.closest('.card')?.dataset.card || fig.querySelector('svg')?.getAttribute('aria-label') || 'chart';
    const saved = all()[id] || {};
    const state = { style: pickOption(saved.style, styles, styles[0]), legend: pickOption(saved.legend, LEGEND_POSITIONS, DEFAULT_LEGEND) };
    const apply = () => { if (styles.length) fig.dataset.style = state.style; fig.dataset.legend = state.legend; };
    const save = () => {
      const st = all(), mine = {};
      if (styles.length && state.style !== styles[0]) mine.style = state.style;
      if (state.legend !== DEFAULT_LEGEND) mine.legend = state.legend;
      if (Object.keys(mine).length) st[id] = mine; else delete st[id];
      if (Object.keys(st).length) store.set(key, st); else store.del(key);
    };
    const bar = document.createElement('div'); bar.className = 'chart-opts';
    const add = (label, name, options, current, onChange) => {
      const wrap = document.createElement('label'); wrap.textContent = label + ' ';
      const sel = document.createElement('select'); sel.setAttribute('aria-label', `${label} for ${id}`); sel.dataset.opt = name;
      for (const [v, text] of options) { const o = document.createElement('option'); o.value = v; o.textContent = text; sel.append(o); }
      sel.value = current;
      sel.addEventListener('change', () => { onChange(sel.value); apply(); save(); });
      wrap.append(sel); bar.append(wrap);
    };
    if (styles.length) add('Style', 'style', styles.map(k => [k, STYLE_LABELS[k] || k]), state.style, v => { state.style = pickOption(v, styles, styles[0]); });
    if (legend) add('Legend', 'legend', LEGEND_POSITIONS.map(k => [k, k[0].toUpperCase() + k.slice(1)]), state.legend, v => { state.legend = pickOption(v, LEGEND_POSITIONS, DEFAULT_LEGEND); });
    apply();
    fig.before(bar);
  }
}
