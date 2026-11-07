// Dashboard write actions from script (issue #933): the page stays where it is. Every POST form is sent with fetch; success shows a toast
// and refreshes the page content in place, failure shows a toast with the reason and re-enables the buttons. Without script the form posts
// normally and the server answers with a styled page. A form marked data-native is left to the browser (the breaker Resume button must be a
// person's own form click, which a script cannot send).
const region = () => {
  let r = document.getElementById('toasts');
  if (!r) { r = document.createElement('div'); r.id = 'toasts'; r.className = 'toasts'; r.setAttribute('role', 'status'); r.setAttribute('aria-live', 'polite'); document.body.append(r); }
  return r;
};
export function toast(text, level = 'ok') {
  const el = document.createElement('div'); el.className = `toast toast-${level}`; el.textContent = text;
  const close = document.createElement('button'); close.type = 'button'; close.className = 'toast-x'; close.setAttribute('aria-label', 'Dismiss'); close.textContent = '×'; close.onclick = () => el.remove();
  el.append(close); region().append(el);
  setTimeout(() => el.remove(), level === 'error' ? 15000 : 5000);
}
async function refreshInPlace() {
  try {
    const r = await fetch(location.href, { headers: { accept: 'text/html' }, credentials: 'same-origin', cache: 'no-store' }); if (!r.ok) return;
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html'), fresh = doc.querySelector('main'), cur = document.querySelector('main');
    if (fresh && cur) { const el = document.importNode(fresh, true); cur.replaceWith(el); document.dispatchEvent(new CustomEvent('dashboard:refreshed')); }
  } catch { /* the toast already told the result; the next scheduled refresh catches up */ }
}
document.addEventListener('submit', async ev => {
  const form = ev.target;
  if (!(form instanceof HTMLFormElement) || (form.method || '').toLowerCase() !== 'post' || form.hasAttribute('data-native')) return;
  ev.preventDefault();
  if (form.dataset.busy) return;   // a double click sends one request
  form.dataset.busy = '1';
  const buttons = [...form.querySelectorAll('button, input[type=submit]')]; buttons.forEach(b => { b.disabled = true; });
  try {
    const r = await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)), credentials: 'same-origin', headers: { 'x-dashboard-action': '1', accept: 'application/json' } });
    let out = null; try { out = await r.json(); } catch { /* not ours: the proxy or a crash answered */ }
    if (out?.ok) { toast(out.message || 'Done.'); await refreshInPlace(); }
    else toast(out?.message || `The dashboard could not do that (HTTP ${r.status}). Nothing was changed.`, 'error');
  } catch { toast('The dashboard could not be reached. Nothing was changed.', 'error'); }
  finally { delete form.dataset.busy; if (form.isConnected) buttons.forEach(b => { b.disabled = false; }); }
});
