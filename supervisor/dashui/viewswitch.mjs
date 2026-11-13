// The one view switch (issue #1224): a row of buttons that picks how a page shows the same items (Queue cards, Table, Board). The Work page
// uses it now; the Inbox views item uses this module too, so there is a single switch pattern. Shared by the server (which renders the
// buttons, so the page is complete before the script runs) and the browser (which binds them).
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// views: [[id, label], ...]. The active button carries aria-pressed so the choice is never only a colour.
export function switchHtml(views, active, label = 'View') {
  const button = ([id, text]) => `<button type="button" class="btn vs-btn" data-view="${esc(id)}" aria-pressed="${id === active}">${esc(text)}</button>`;
  const buttons = views.map(button).join('');
  return `<div class="view-switch" role="group" aria-label="${esc(label)}">${buttons}</div>`;
}
export const pickView = (views, id, fallback) => (views.some(([v]) => v === id) ? id : fallback);

// Calls onChange(id) when a button is pressed and keeps aria-pressed in step. Returns a function that sets the active view from code.
export function bindSwitch(root, views, onChange) {
  const set = id => { for (const b of root.querySelectorAll('.vs-btn')) b.setAttribute('aria-pressed', String(b.dataset.view === id)); };
  root.addEventListener('click', e => {
    const b = e.target.closest('.vs-btn');
    if (!b || !root.contains(b)) return;
    const id = pickView(views, b.dataset.view, null);
    if (id) { set(id); onChange(id); }
  });
  return set;
}
