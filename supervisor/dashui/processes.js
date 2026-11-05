// Live processes (issue #568): progressive enhancement. The page is complete without this; this asks the same-origin, read-only
// GET /api/processes every poll interval while the tab is visible and swaps in the fresh fragment. The figures are marked stale,
// never left looking current, when a request fails, hangs past its timeout, or no fresh answer has arrived for STALE_AFTER ms.
const host = document.querySelector('[data-procs]');
if (host) {
  const every = Math.max(5000, Number(host.dataset.poll) || 15000), agent = host.dataset.agent || '', STALE_AFTER = every * 3, TIMEOUT = every;
  let busy = false, lastOk = Date.now();
  const mark = text => {
    let n = host.querySelector('[data-conn]');
    if (!text) { n?.remove(); host.classList.remove('stale'); return; }
    if (!n) { n = document.createElement('p'); n.className = 'proc-note sev-warning'; n.dataset.conn = '1'; host.prepend(n); }
    n.textContent = text; host.classList.add('stale');
  };
  const tick = async () => {
    if (busy || document.hidden) return; busy = true;
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), TIMEOUT);
    try {
      const r = await fetch(`/api/processes${agent ? `?agent=${encodeURIComponent(agent)}` : ''}`, { headers: { accept: 'text/html' }, credentials: 'same-origin', cache: 'no-store', signal: ctl.signal });
      if (!r.ok) throw new Error(String(r.status));
      host.innerHTML = await r.text(); lastOk = Date.now();
    } catch { mark('Could not refresh: the figures below are not current.'); } finally { clearTimeout(timer); busy = false; }
  };
  // Age check independent of the request: a slow or blocked server cannot keep old figures looking current.
  const age = () => {
    const ms = Date.now() - lastOk;
    if (ms > STALE_AFTER && !host.querySelector('[data-conn]')) mark(`No fresh reading for ${Math.round(ms / 1000)} s: the figures below are not current.`);
  };
  setInterval(tick, every); setInterval(age, 5000);
  document.addEventListener('visibilitychange', () => { if (document.hidden) return; if (Date.now() - lastOk > STALE_AFTER) age(); tick(); });
}
