import { ACTIONS } from '../foreman-mcp/actions.mjs';
import { decide, loadItem, undo } from './inbox.mjs';

export function decideInboxForm({ dir, id, decision, form, now }) {
  if (decision === 'undo') return undo(dir, id, now);
  const loaded = loadItem(dir, id);
  const action = loaded.ok && loaded.item.kind === 'action' ? loaded.item.action : null;
  const strong = action && Object.hasOwn(ACTIONS, action) && ACTIONS[action].tier === 'strong';
  if (strong && form.get('confirm') !== loaded.item.target) return { ok: false, reason: `type PR #${loaded.item.target} to confirm this homeowner override` };
  return decide(dir, id, decision, now, { homeownerOverride: strong });
}
