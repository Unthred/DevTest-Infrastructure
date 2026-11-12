// Issue #1164: puts the direct control state on a built view: whether the switch is on and the audit trail, newest first. The dashboard card shows it
// and /api/view.json carries it, so the overseer can read the trail back (foreman_direct_log). Reads local files only; a view with no inbox gets none.
import { readSwitch, readAudit } from './directstore.mjs';

export function withDirect(view, config) {
  const dir = config?.inbox?.dir;
  if (!view || !dir) return view;
  const sw = readSwitch(dir);
  return { ...view, direct: { enabled: sw.enabled, switchedAt: sw.at, audit: readAudit(dir, 100) } };
}
