// Inbox quick filters in the browser (issue #1217): the chosen state and kind are kept per viewer in localStorage, like the card layout.
// The buttons are links, so the server draws every view; this file only saves the choice and restores it when /inbox is opened bare.

export const KEY = 'dash.inbox.filter';

// The filter part of an address worth saving: the state and kind (the search words are not kept). null when the address chose no state.
export function savable(search) {
  const q = new URLSearchParams(search);
  if (!q.has('state')) return null;
  const out = new URLSearchParams({ state: q.get('state') });
  if (q.get('kind')) out.set('kind', q.get('kind'));
  return out.toString();
}

// Where to go instead of a bare /inbox, or null when the address already chose filters (or nothing is saved).
export function restoreTarget(search, saved) {
  if (!saved || new URLSearchParams(search).size) return null;
  return `/inbox?${saved}`;
}

export function bindInboxFilter({ loc = location, store = localStorage, doc = document } = {}) {
  let saved = null;
  try { saved = store.getItem(KEY); } catch { saved = null; }
  const target = restoreTarget(loc.search, saved);
  if (target) { loc.replace(target); return; }
  const now = savable(loc.search);
  try { if (now) store.setItem(KEY, now); } catch { /* private mode: the choice is simply not remembered */ }
  for (const select of doc.querySelectorAll('.inbox-search select')) select.addEventListener('change', () => select.form.requestSubmit());
}

if (typeof document !== 'undefined' && location.pathname === '/inbox') bindInboxFilter();
