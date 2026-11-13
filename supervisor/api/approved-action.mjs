// Issue #1280: a command module hands an existing named Inbox action to the tick as already approved. The homeowner pressing the control is the
// approval, so no card is shown; the item is written exactly as a card approved on the dashboard would look to the tick (same item file, same
// content hash, state approved, kind action) and the tick's Inbox pass loads it, checks the hash and runs it once.
// A plain function: the Inbox folder, the action fields and the time are passed in; it reads no clock and no config, and it adds no effect code.
// The caller wakes the tick itself (context.wake) after an ok result; the timed tick is only the fallback.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { allStatuses, dirs, finish, hashOf, validateItem } from '../inbox.mjs';

const OPEN_STATES = ['approved', 'running'];
export const SOURCE = 'homeowner_command';

const refused = reason => ({ ok: false, reason });

const alreadyQueued = (inboxDir, action, target) => allStatuses(inboxDir)
  .some(s => s.kind === 'action' && s.action === action && s.target === target && OPEN_STATES.includes(s.state));

// Returns { ok: true, id } or { ok: false, reason }. Nothing is written when the result is not ok.
export function recordApprovedAction({ inboxDir, action, target, reason, title, now }) {
  const checked = validateItem({ kind: 'action', title, action, target: String(target), reason });
  if (!checked.ok) return refused(checked.reason);
  const { item } = checked;
  if (alreadyQueued(inboxDir, item.action, item.target)) return refused(`${item.action} for ${item.target} is already queued`);
  const id = crypto.randomBytes(16).toString('hex');
  const d = dirs(inboxDir);
  fs.mkdirSync(d.items, { recursive: true, mode: 0o755 });
  fs.mkdirSync(d.status, { recursive: true, mode: 0o755 });
  // Item file first, atomically, so a scan never sees half a file; the status follows at once. The dashboard process is single threaded, so its
  // own scan cannot run between the two steps.
  const temp = path.join(d.items, `${id}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(item, null, 1)}\n`, { mode: 0o644, flag: 'wx' });
  const hash = hashOf(JSON.parse(fs.readFileSync(temp, 'utf8')));
  fs.renameSync(temp, path.join(d.items, `${id}.json`));
  // No `decision` field: the Inbox undo refuses an item without one, so this approval cannot be taken back once recorded.
  const status = { state: 'approved', kind: 'action', hash, createdAt: now, title: item.title, action: item.action, target: item.target, source: SOURCE };
  finish(inboxDir, id, status, now);
  return { ok: true, id };
}
