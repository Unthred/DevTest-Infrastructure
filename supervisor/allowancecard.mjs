// Issue #75 / #1163: one agent's allowance card on the Usage page, moved out of dashrender.mjs (no change of behaviour except the reading line).
// The page helpers are passed in (the resetscard pattern), so this module imports nothing from the renderer.
import { readingLine } from './readingcard.mjs';

// The last known reading with its age; an expired window (reset time passed) is
// marked and never shown as current; a limit pause says when it resets and on what basis.
const SOURCE = { job: 'reported to a supervised job', probe: 'refreshed by a minimal probe run (no repository, no tools)', 'session-log': 'read from the local Codex session log (no model call)' };
export function allowanceBody(h, u, now, name = '') {
  const { esc, badge, lt, dur, pct, inFuture, ago, empty } = h;
  const l = u.limit;
  const refresh = u.canProbe && name ? `<form method="post" action="/probe/${encodeURIComponent(name)}" class="probe-form"><button type="submit" class="tbtn" title="Run one minimal probe to read the current allowance (no repository, no tools)">Refresh allowance</button></form>` : '';
  const limit = l ? `<p class="limit">${badge('action', 'Paused on a usage limit')} ${l.limiting ? `${esc(l.limiting)}. ` : ''}${l.resetsAt ? `resets <b>${lt(l.resetsAt)}</b> (${esc(inFuture(l.resetsAt, now))}; ${esc(l.basis)})` : 'reset time not reported by the provider'}${l.retryAt ? `. The supervisor retries ${esc(inFuture(l.retryAt, now))}.` : '.'}</p>` : '';
  if (!u.windows.length) return `${limit}<p>Allowance: <b>unknown</b></p>${refresh}${empty('No allowance reported', 'The provider has never reported a limit window to the supervisor.', 'info')}`;
  const used = w => (Number.isFinite(w.utilization) ? `<div class="bar${w.expired ? ' expired' : ''}" role="img" aria-label="${pct(w.utilization)} used${w.expired ? ', expired' : ''}"><b style="width:${Math.min(100, w.utilization * 100)}%"></b></div> ${pct(w.utilization)}${w.expired ? ' <span class="muted">(expired)</span>' : ''}` : 'unknown');
  const resets = w => (!w.resetsAt ? 'unknown' : w.expired ? `reset ${esc(dur(now - w.resetsAt))} ago; current use unknown` : esc(inFuture(w.resetsAt, now)));
  const rows = u.windows.map(w => `<tr${w.expired ? ' class="expired"' : ''}><td>${esc(w.label)}</td><td>${used(w)}</td><td>${resets(w)}</td></tr>`).join('');
  const note = u.allExpired ? `<p class="sub">${badge('warning', 'Expired')} Every window in this reading has reset since; current use is unknown until the provider reports again.</p>` : '';
  return `${limit}<table><thead><tr><th>Window</th><th>Used</th><th>Resets</th></tr></thead><tbody>${rows}</tbody></table>${note}<p class="sub">Last reading ${esc(ago(u.observedAt, now))} (${lt(u.observedAt)}), ${esc(SOURCE[u.source] || 'reported by the provider')}.</p>${readingLine(h, u, now)}${refresh}`;
}
