// Column choices shared by the dashboard tables that let the viewer hide and resize columns (Jobs, issue #1220; Inbox, issue #1219).
// sanitizeColumns is pure; bindResize puts the drag and arrow-key resize on a grip handle inside a table header cell.
export const MIN_WIDTH = 48;
export const MAX_WIDTH = 800;
const KEY_STEP = 16;

export const clampWidth = px => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));

// Which columns are hidden and how wide the others are. Anything unknown or out of range is dropped.
export function sanitizeColumns(raw, keys) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const hidden = Array.isArray(r.hidden) ? [...new Set(r.hidden.filter(k => keys.includes(k)))] : [];
  const widths = {};
  for (const [k, w] of Object.entries(r.widths && typeof r.widths === 'object' ? r.widths : {})) {
    if (keys.includes(k) && Number.isFinite(w)) widths[k] = clampWidth(w);
  }
  // Hiding every column would leave nothing to show.
  return { hidden: hidden.length >= keys.length ? [] : hidden, widths };
}

// Grips carry data-grip="<column key>" and sit inside the column's th. Listeners sit on root, so a grip swapped in later still works.
export function bindResize(root, widths, { apply, commit }) {
  const doc = root.ownerDocument ?? root;
  root.addEventListener('pointerdown', e => {
    const grip = e.target.closest?.('[data-grip]');
    if (!grip) return;
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = grip.closest('th').getBoundingClientRect().width;
    const key = grip.dataset.grip;
    const move = ev => {
      widths[key] = clampWidth(startWidth + ev.clientX - startX);
      apply();
    };
    const up = () => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      commit();
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
  });
  root.addEventListener('keydown', e => {
    const grip = e.target.closest?.('[data-grip]');
    if (!grip || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const key = grip.dataset.grip;
    const now = widths[key] || Math.round(grip.closest('th').getBoundingClientRect().width);
    widths[key] = clampWidth(now + (e.key === 'ArrowRight' ? KEY_STEP : -KEY_STEP));
    apply();
    commit();
  });
}
