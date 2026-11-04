// Live processes (issue #568): progressive enhancement. The page is complete without this; this asks the same-origin, read-only
// GET /api/processes every poll interval while the tab is visible and swaps in the fresh fragment. If a request fails or the answer
// is not HTML the old figures stay but are marked stale, never shown as current.
const host = document.querySelector('[data-procs]');
if (host) {
  const every = Math.max(5000, Number(host.dataset.poll) || 15000), agent = host.dataset.agent || '';
  let busy = false;
  const mark = text => {
    let n = host.querySelector('[data-conn]');
    if (!text) { n?.remove(); host.classList.remove('stale'); return; }
    if (!n) { n = document.createElement('p'); n.className = 'proc-note sev-warning'; n.dataset.conn = '1'; host.prepend(n); }
    n.textContent = text; host.classList.add('stale');
  };
  const tick = async () => {
    if (busy || document.hidden) return; busy = true;
    try {
      const r = await fetch(`/api/processes${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`, { headers: { accept: 'text/html' }, credentials: 'same-origin', cache: 'no-store' });
      if (!r.ok) throw new Error(String(r.status));
      host.innerHTML = await r.text();
    } catch { mark('Could not refresh: the figures below are not current.'); } finally { busy = false; }
  };
  setInterval(tick, every);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });
}
