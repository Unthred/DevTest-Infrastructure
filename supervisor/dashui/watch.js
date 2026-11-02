// Live, read-only watch panel (issue #123): progressive enhancement. The page is already complete (the transcript so far is
// rendered on the server); this opens a server-sent-event stream and appends new entries with the same renderer.
import { fmtElapsed, renderEntry, renderTotals, totals } from './watch.mjs';

const panel = document.querySelector('[data-watch]');
if (panel && panel.dataset.live === 'true') {
  const log = panel.querySelector('.tr-log'), stats = panel.querySelector('[data-totals]'), elapsed = panel.querySelector('[data-elapsed]'), state = panel.querySelector('[data-state]');
  const started = Number(panel.dataset.started), entries = [...(JSON.parse(panel.dataset.seed || '[]'))];
  let ended = false;
  const follow = () => { const near = innerHeight + scrollY >= document.body.scrollHeight - 80; return () => { if (near) scrollTo(0, document.body.scrollHeight); }; };
  const show = () => { stats.textContent = renderTotals(totals(entries)); };
  show();
  const timer = setInterval(() => { if (!ended && Number.isFinite(started)) elapsed.textContent = fmtElapsed(Date.now() - started); }, 1000);
  const es = new EventSource(`/api/jobs/${panel.dataset.job}/events?after=${panel.dataset.last || 0}`);
  es.onmessage = ev => {
    const e = JSON.parse(ev.data), keep = follow();
    entries.push(e); log.insertAdjacentHTML('beforeend', renderEntry(e)); show(); keep();
    state.textContent = 'Live';
  };
  es.addEventListener('end', ev => {
    ended = true; clearInterval(timer); es.close();
    const info = JSON.parse(ev.data || '{}'); state.textContent = `Finished (${info.status || 'ended'})`;
    if (Number.isFinite(info.elapsedMs)) elapsed.textContent = fmtElapsed(info.elapsedMs);
  });
  es.onerror = () => { if (!ended) state.textContent = 'Reconnecting…'; };
}
