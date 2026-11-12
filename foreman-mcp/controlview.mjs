// Issue #1115: the overseer's control records (park, stop_job) that concern one issue or pull request number or one job, newest first.
// The records come from the dashboard view; this account only reads them.
export function controlsFor(controls, { number = null, job = null }) {
  const list = Array.isArray(controls) ? controls : [];
  return list.filter(c => (number != null && c.action === 'park' && String(c.target) === String(number)) || (job != null && c.action === 'stop_job' && String(job).startsWith(c.target)))
    .slice(0, 10).map(c => ({ action: c.action, by: c.by, at: Number.isFinite(c.at) ? new Date(c.at).toISOString() : null, reason: c.reason, state: c.state, changed: c.changed, result: c.result }));
}

// Adds the control records to the text of a foreman_why_blocked or foreman_jobs answer (a JSON text). Anything it cannot read is returned as it was.
export function withControls(name, args, text, controls) {
  if (!Array.isArray(controls) || !controls.length) return name === 'foreman_why_blocked' ? addTo(text, out => { out.controls = []; }) : text;
  if (name === 'foreman_why_blocked') return addTo(text, out => { out.controls = controlsFor(controls, { number: args?.number }); });
  if (name === 'foreman_jobs') return addTo(text, out => { for (const j of out.jobs || []) { const c = controlsFor(controls, { job: j.id }); if (c.length) j.controls = c; } });
  return text;
}
function addTo(text, change) {
  try { const out = JSON.parse(text); if (!out || typeof out !== 'object') return text; change(out); return JSON.stringify(out, null, 1); } catch { return text; }
}

// Issue #1164: the audit trail of the direct controls, as the dashboard publishes it (newest first), with the state of the switch.
// The overseer reads it back with foreman_direct_log. Anything the view does not carry is reported as unavailable, never guessed.
export function directLog(view, { limit = 30 } = {}) {
  const d = view?.direct;
  if (!d || !Array.isArray(d.audit)) return { available: false, note: 'this dashboard does not publish the direct control trail' };
  const n = Number.isInteger(limit) ? Math.min(100, Math.max(1, limit)) : 30;
  return { available: true, enabled: d.enabled !== false, switchedAt: d.switchedAt ?? null, shown: Math.min(n, d.audit.length),
    entries: d.audit.slice(0, n).map(e => ({
    id: e.id, at: Number.isFinite(e.at) ? new Date(e.at).toISOString() : null, by: e.by, action: e.action, target: e.target, value: e.value,
      reason: e.reason, outcome: e.outcome,
    changed: e.changed, before: e.before, after: e.after, text: e.text, undone: e.undone === true })) };
}
