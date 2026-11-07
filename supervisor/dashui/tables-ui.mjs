// Browser side of the shared tables (table() in dashrender.mjs, issue #939): drag or keyboard column resize and a Columns menu to show or
// hide columns. Widths and hidden columns are kept per page and table in localStorage and re-applied whenever the table's data is replaced
// in place. Progressive enhancement: without this script the table shows every column at the widths the server computed from content.
export const MIN_COL_PX = 48, MAX_COL_PX = 900, KEY_STEP_PX = 16;
export const clampWidth = w => Math.min(MAX_COL_PX, Math.max(MIN_COL_PX, Math.round(Number(w) || MIN_COL_PX)));
// Saved state, defensively: only known column keys, finite widths, and at least one column always stays visible.
export function sanitizeColumns(raw, keys) {
  const r = raw && typeof raw === 'object' ? raw : {}, known = new Set(keys);
  const w = {};
  if (r.w && typeof r.w === 'object') for (const [k, v] of Object.entries(r.w)) if (known.has(k) && Number.isFinite(v)) w[k] = clampWidth(v);
  let hidden = Array.isArray(r.hidden) ? r.hidden.filter(k => known.has(k)) : [];
  if (hidden.length >= keys.length) hidden = hidden.slice(0, Math.max(0, keys.length - 1));
  return { w, hidden };
}
const storeKey = id => `dash.tc.${location.pathname}.${id}`;
const read = id => { try { return JSON.parse(localStorage.getItem(storeKey(id))); } catch { return null; } };
const write = (id, st) => { try { localStorage.setItem(storeKey(id), JSON.stringify(st)); } catch { /* not remembered */ } };
const forget = id => { try { localStorage.setItem(storeKey(id), '{}'); } catch { /* not remembered */ } };

export function initColumns(region) {
  const id = region.dataset.tregion;
  const tableOf = () => region.querySelector('table[data-table]');
  const keysOf = t => [...t.querySelectorAll('thead th[data-col]')].map(th => th.dataset.col);
  let st = null;
  const save = () => write(id, st);
  function apply() {
    const t = tableOf(); if (!t) return;
    const keys = keysOf(t); st = sanitizeColumns(st || read(id), keys);
    for (const k of keys) {
      const off = st.hidden.includes(k);
      for (const el of t.querySelectorAll(`[data-col="${CSS.escape(k)}"]`)) el.hidden = off;
      const col = t.querySelector(`col[data-col="${CSS.escape(k)}"]`);
      if (col && st.w[k]) col.style.width = `${st.w[k]}px`;
    }
    t.classList.toggle('tfixed', Object.keys(st.w).length > 0);
    for (const th of t.querySelectorAll('thead th[data-col]')) if (!th.querySelector('.col-grip')) addGrip(t, th);
  }
  function setWidth(t, k, px) {
    // On the first resize every visible column is pinned at its current width, so one column changes without the others jumping.
    if (!Object.keys(st.w).length) for (const th of t.querySelectorAll('thead th[data-col]')) if (!th.hidden) st.w[th.dataset.col] = clampWidth(th.getBoundingClientRect().width);
    st.w[k] = clampWidth(px);
    apply(); save();
  }
  function addGrip(t, th) {
    const g = document.createElement('span');
    g.className = 'col-grip'; g.tabIndex = 0; g.setAttribute('role', 'separator'); g.setAttribute('aria-orientation', 'vertical');
    g.setAttribute('aria-label', `Resize column ${th.textContent.trim()}. Arrow keys change the width.`); g.title = 'Drag to resize';
    g.addEventListener('pointerdown', e => {
      e.preventDefault(); e.stopPropagation();
      const x0 = e.clientX, w0 = th.getBoundingClientRect().width;
      const move = ev => setWidth(t, th.dataset.col, w0 + (ev.clientX - x0));
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
    g.addEventListener('keydown', e => {
      const d = e.key === 'ArrowRight' ? KEY_STEP_PX : e.key === 'ArrowLeft' ? -KEY_STEP_PX : 0;
      if (d) { e.preventDefault(); setWidth(t, th.dataset.col, th.getBoundingClientRect().width + d); }
    });
    g.addEventListener('click', e => e.stopPropagation());
    th.append(g);
  }
  function menu() {
    const t = tableOf(), bar = region.querySelector('form.tbar'); if (!t || !bar || bar.querySelector('.tcols')) return;
    const d = document.createElement('details'); d.className = 'tcols';
    const s = document.createElement('summary'); s.className = 'btn'; s.textContent = 'Columns'; d.append(s);
    const box = document.createElement('div'); box.className = 'tcols-box'; d.append(box);
    for (const th of t.querySelectorAll('thead th[data-col]')) {
      const lab = document.createElement('label'), cb = document.createElement('input');
      cb.type = 'checkbox'; cb.dataset.col = th.dataset.col; cb.checked = !st.hidden.includes(th.dataset.col);
      cb.addEventListener('change', () => {
        const all = [...box.querySelectorAll('input')];
        if (!all.some(x => x.checked)) { cb.checked = true; return; }   // never hide the last column
        st.hidden = all.filter(x => !x.checked).map(x => x.dataset.col);
        apply(); save();
      });
      lab.append(cb, ' ', th.textContent.trim()); box.append(lab);
    }
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'btn'; reset.textContent = 'Reset columns';
    reset.addEventListener('click', () => {
      st = { w: {}, hidden: [] }; forget(id);
      for (const cb of box.querySelectorAll('input')) cb.checked = true;
      const tt = tableOf(); if (tt) { tt.classList.remove('tfixed'); for (const c of tt.querySelectorAll('col')) c.style.width = c.dataset.def || ''; }
      apply();
    });
    box.append(reset);
    bar.append(d);
  }
  // Remember the server's default width of every column, so Reset can put it back.
  const remember = t => { for (const c of t.querySelectorAll('col')) if (c.dataset.def === undefined) c.dataset.def = c.style.width || ''; };
  const first = tableOf(); if (first) remember(first);
  apply(); menu();
  // The table's data is replaced in place by search, paging and filters (app.js loadTable): re-apply the saved columns to the new table.
  new MutationObserver(() => { const t = tableOf(); if (t && !t.dataset.colsApplied) { t.dataset.colsApplied = '1'; remember(t); apply(); } }).observe(region, { childList: true, subtree: true });
}
export function initTables(scope = document) {
  for (const region of scope.querySelectorAll('[data-tregion]')) if (!region.dataset.colsReady) { region.dataset.colsReady = '1'; initColumns(region); }
}
