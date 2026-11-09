// Records a dashboard decision as an already-approved inbox action. The dashboard
// never applies the action: the next Foreman tick owns that work and re-checks it.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { ACTIONS, validAction } from '../foreman-mcp/actions.mjs';
import { dirs, scan, decide, finish, statusOf } from './inbox.mjs';

export function recordDecisionAction({ dir, action, target, reason, now = Date.now() }) {
  if (!validAction(action, target)) throw new Error('unknown action or target');
  const why = String(reason || '').trim();
  if (!why || why.length > 300) throw new Error('reason must be 1 to 300 characters');
  const id = crypto.randomBytes(16).toString('hex');
  const item = { kind: 'action', title: ACTIONS[action].label, action, target: String(target), reason: why };
  const d = dirs(dir);
  fs.mkdirSync(d.items, { recursive: true, mode: 0o755 });
  fs.mkdirSync(d.status, { recursive: true, mode: 0o755 });
  fs.writeFileSync(`${d.items}/${id}.json`, JSON.stringify(item) + '\n', { mode: 0o644, flag: 'wx' });
  scan(dir, now);
  const approved = decide(dir, id, 'approve', now);
  if (!approved.ok) throw new Error(approved.reason);
  finish(dir, id, { decidedBy: 'homeowner', decisionReason: why }, now);
  return { id, action, target: String(target), decidedAt: now, state: statusOf(dir, id)?.state };
}
