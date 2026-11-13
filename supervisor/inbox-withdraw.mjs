// Issue #1316: the Inbox withdraws a pending item and, for a replacement, moves nothing by hand: the withdrawn record names its replacement and
// every draft that waits for the old item follows that name (foreman-mcp/inbox-replace.mjs). The item file's hash guard is never touched: a card
// the homeowner has seen cannot change, a correction is a new card. `io` is the small part of inbox.mjs this needs (statusOf, setStatus, audit,
// withLock), passed in so this module does not import the module that uses it.
import { REPLACEABLE_KINDS, dependentsOf, resolveRef } from '../foreman-mcp/inbox-replace.mjs';

const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
const label = status => `${oneLine(status?.title) || 'untitled'} (${String(status?.id).slice(0, 8)})`;

// What the homeowner or the overseer is told when a decision names an item that was withdrawn.
export function withdrawnText(status) {
  if (status.replacedBy) return `the item was withdrawn: it was replaced by "${oneLine(status.replacedByTitle) || 'a newer item'}"`;
  return `the item was withdrawn${status.reason ? `: ${oneLine(status.reason)}` : ''}`;
}

// Withdraws one pending item. Never touches approved, running or finished work. Returns { ok, old } or { ok:false, reason }.
export function withdrawItem(io, dir, ref, { reason, by, replacedBy = null, moved = [], now }) {
  const found = resolveRef(dir, ref);
  if (!found.id) return { ok: false, reason: `${found.reason}; nothing was withdrawn` };
  const done = io.withLock(dir, found.id, () => {
    const status = io.statusOf(dir, found.id);
    if (!status) return { ok: false, reason: `${found.id.slice(0, 8)} has not been picked up by Foreman yet (state waiting); nothing was withdrawn` };
    if (status.state !== 'pending') return { ok: false, reason: `${label(status)} is ${status.state}, not pending; nothing was withdrawn` };
    if (!REPLACEABLE_KINDS.includes(status.kind)) return { ok: false, reason: `${label(status)} is not an item of the propose tool; nothing was withdrawn` };
    const record = { state: 'withdrawn', reason, withdrawnAt: now, withdrawnBy: by, ...(replacedBy ? { replacedBy: replacedBy.id, replacedByTitle: replacedBy.title } : {}) };
    io.setStatus(dir, found.id, record, now);
    io.audit(dir, { id: found.id, event: replacedBy ? 'replaced' : 'withdrawn', kind: status.kind, hash: status.hash, title: oneLine(status.title), reason,
      ...(replacedBy ? { replacedBy: replacedBy.id, replacedByTitle: replacedBy.title, linksMoved: moved.map(m => ({ id: m.id, title: m.title })) } : {}) }, now);
    return { ok: true, old: { id: found.id, title: oneLine(status.title) || 'untitled', kind: status.kind } };
  });
  return done.locked ? { ok: false, reason: 'the item is being acted on; try again in a moment' } : done.value;
}

// Withdraws the replaced item for the new one (already checked, now accepted). Returns { ok, old, moved } or { ok:false, reason }.
export function completeReplacement(io, dir, newId, newTitle, old, now) {
  const moved = dependentsOf(dir, old.id);
  const result = withdrawItem(io, dir, old.id, { reason: `replaced by ${newTitle}`, by: 'overseer', replacedBy: { id: newId, title: newTitle }, moved, now });
  return result.ok ? { ok: true, old: result.old, moved } : result;
}

// The control `withdraw`: the overseer's own withdraw of one pending item, applied when the control item is picked up.
export function withdrawControl(io, dir, ref, reason, now) {
  const result = withdrawItem(io, dir, ref, { reason, by: 'overseer', now });
  return result.ok ? { outcome: 'done', changed: true, text: `withdrew ${result.old.title} (${result.old.id.slice(0, 8)}); its record is kept as withdrawn` }
    : { outcome: 'refused', changed: false, text: result.reason };
}
