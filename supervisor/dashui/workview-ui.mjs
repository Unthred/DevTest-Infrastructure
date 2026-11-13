// Issue #1224: browser side of the Work page's Table and Board. Reads the rows the server embedded (#wv-data), keeps the viewer's
// filters, sort, grouping, columns and saved views in this browser (localStorage, per viewer like the layout), and draws with
// workview-draw.mjs. Progressive enhancement: without this script the Queue cards below stay as they are.
import { bindSwitch } from './viewswitch.mjs';
import {
  VIEWS, boardColumns, defaultState, deleteView, emptyFilters, facetCounts, facetValues, filterRows, groupRows, saveView,
  sanitizeSaved, sanitizeState, sortRows, toCsv, toggleIn
} from './worktable.mjs';
import { boardHtml, filterBarHtml, panelHtml, tableHtml, visibleColumns } from './workview-draw.mjs';

const STATE_KEY = 'dash.workview.state', SAVED_KEY = 'dash.workview.saved', OPEN_KEY = 'dash.workview.open';
const read = (store, k) => {
  try { return JSON.parse(store.getItem(k)); } catch { return null; }
};
const write = (store, k, v) => {
  try { store.setItem(k, JSON.stringify(v)); } catch { /* not remembered */ }
};

const timeText = ms => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
function durationText(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h`;
}
const ctx = { time: timeText, duration: durationText };

function download(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Column resize: drag the handle on the header's right edge; the width is kept with the view.
function startResize(e, onDone) {
  const handle = e.target.closest('[data-resize]');
  if (!handle) return;
  e.preventDefault();
  const th = handle.closest('th'), startX = e.clientX, startW = th.getBoundingClientRect().width;
  const widthAt = x => Math.max(40, Math.round(startW + x - startX));
  const move = ev => { th.style.width = `${widthAt(ev.clientX)}px`; };
  const up = ev => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    onDone(handle.dataset.resize, widthAt(ev.clientX));
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
}

// One Escape listener for the page, whichever copy of the card is current (the refresh in place swaps the card).
let closeOpenPanel = null;
export function initWorkView(root, { local = localStorage, session = sessionStorage } = {}) {
  if (root.dataset.wvReady) return;
  root.dataset.wvReady = '1';
  const data = JSON.parse(root.querySelector('#wv-data').textContent);
  const body = root.querySelector('.wv-body');
  let state = sanitizeState(read(local, STATE_KEY) || defaultState());
  let saved = sanitizeSaved(read(local, SAVED_KEY));
  let openKey = read(session, OPEN_KEY);
  let selectedView = '';   // the saved view chosen last, kept selected across redraws so Delete knows which one
  const rowOf = key => data.rows.find(r => r.key === key);
  const persist = () => write(local, STATE_KEY, state);
  const visibleRows = () => sortRows(filterRows(data.rows, state.filters), state.sortKey, state.sortDir);
  const setSwitch = bindSwitch(root.querySelector('.view-switch'), VIEWS, id => { state.view = id; persist(); draw(); });

  function draw() {
    document.body.dataset.workView = state.view;
    setSwitch(state.view);
    body.hidden = state.view === 'cards';
    if (state.view === 'cards') { body.innerHTML = ''; return; }
    const rows = visibleRows();
    const bar = filterBarHtml({
      state, counts: facetCounts(data.rows, state.filters), values: facetValues(data.rows), saved,
      selected: selectedView, shown: rows.length, total: data.rows.length
    });
    const main = state.view === 'board'
      ? boardHtml(boardColumns(rows))
      : tableHtml({ groups: groupRows(rows, state.group), state, ctx, sortKey: state.sortKey, sortDir: state.sortDir });
    body.innerHTML = `${bar}${main}<aside class="wv-side" role="dialog" aria-modal="false" aria-labelledby="wv-side-title" hidden></aside>`;
    if (openKey && rowOf(openKey)) showPanel(openKey);
  }
  function drawKeepingSearch() {
    const at = body.querySelector('[data-wv-q]')?.selectionStart;
    draw();
    const q = body.querySelector('[data-wv-q]');
    if (!q) return;
    q.focus();
    q.setSelectionRange(at ?? q.value.length, at ?? q.value.length);
  }
  function showPanel(key) {
    const side = body.querySelector('.wv-side');
    openKey = key;
    write(session, OPEN_KEY, key);
    side.innerHTML = panelHtml(rowOf(key), data.details[key], ctx);
    side.hidden = false;
    side.querySelector('[data-wv-close]')?.focus();
  }
  function closePanel() {
    openKey = null;
    session.removeItem(OPEN_KEY);
    const side = body.querySelector('.wv-side');
    if (side) side.hidden = true;
  }
  const change = fn => { fn(); persist(); draw(); };
  const remember = () => { write(local, SAVED_KEY, saved); draw(); };

  const clicks = [
    ['[data-facet]', el => change(() => { state.filters[el.dataset.facet] = toggleIn(state.filters[el.dataset.facet], el.dataset.value); })],
    ['[data-sort]', el => change(() => {
      state.sortDir = state.sortKey === el.dataset.sort && state.sortDir === 'asc' ? 'desc' : 'asc';
      state.sortKey = el.dataset.sort;
    })],
    ['[data-open]', el => showPanel(el.dataset.open)],
    ['[data-wv-close]', closePanel],
    ['[data-wv-clear]', () => change(() => { state.filters = emptyFilters(); })],
    ['[data-wv-csv]', () => download('work-queue.csv', toCsv(visibleRows(), visibleColumns(state).map(c => c.key)))],
    ['[data-wv-save]', () => {
      const name = body.querySelector('[data-wv-name]').value;
      if (name.trim()) { saved = saveView(saved, name, state); remember(); }
    }],
    ['[data-wv-delete]', () => {
      if (!selectedView) return;
      saved = deleteView(saved, selectedView);
      selectedView = '';
      remember();
    }],
    ['[data-row]', (el, e) => { if (!e.target.closest('a')) showPanel(el.dataset.row); }]
  ];
  body.addEventListener('click', e => {
    for (const [selector, run] of clicks) {
      const el = e.target.closest(selector);
      if (el) { run(el, e); return; }
    }
  });
  body.addEventListener('input', e => {
    if (!e.target.matches('[data-wv-q]')) return;
    state.filters.q = e.target.value.slice(0, 200);
    persist();
    drawKeepingSearch();
  });
  body.addEventListener('change', e => {
    const t = e.target;
    if (t.matches('[data-wv-group]')) change(() => { state.group = t.value; });
    else if (t.matches('[data-col-toggle]')) {
      change(() => { state.hidden = t.checked ? state.hidden.filter(k => k !== t.dataset.colToggle) : [...state.hidden, t.dataset.colToggle]; });
    } else if (t.matches('[data-wv-saved]')) {
      selectedView = t.value;
      if (t.value) change(() => { state = sanitizeState(saved.find(s => s.name === t.value)?.state ?? state); });
    }
  });
  body.addEventListener('pointerdown', e => startResize(e, (key, width) => {
    state = sanitizeState({ ...state, widths: { ...state.widths, [key]: width } });
    persist();
    draw();
  }));
  closeOpenPanel = () => { if (openKey) closePanel(); };
  draw();
}

export const initAll = () => {
  for (const el of document.querySelectorAll('[data-workview]:not([data-wv-ready])')) initWorkView(el);
};
if (typeof document !== 'undefined' && document.querySelector) {
  initAll();
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeOpenPanel?.(); });
  // The refresh in place announces a rebuilt card before it restores scroll and focus; draw at once, not a microtask later.
  document.addEventListener('card-rebuilt', initAll);
  // A card swapped in by the refresh in place (issue #930) is set up again from the saved choices.
  if (typeof MutationObserver === 'function') new MutationObserver(initAll).observe(document.body, { childList: true, subtree: true });
}
