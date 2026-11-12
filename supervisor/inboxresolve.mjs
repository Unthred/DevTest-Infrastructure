// Issue #1154 requirement 3: a failed Inbox item leaves Needs you only when it has a resolution, recorded in its status as
// resolution { type, ref|note, at }. The overseer can record re-proposed or superseded (a `resolves` id on a new proposal, applied when
// Foreman picks that proposal up); dropped and done-by-other-means need the homeowner on the dashboard. `store` is the inbox module
// (allStatuses, finish), passed in so this file does not import it back.
export const OVERSEER_RESOLUTIONS = ['re-proposed', 'superseded'];
export const HOMEOWNER_RESOLUTIONS = { drop: 'dropped', done_elsewhere: 'done_by_other_means', keep_setting: 'setting_kept' };
const NOTE_MAX = 300;

// Shape of the optional `resolves` and `resolution` fields of a proposal; null when fine.
export function badResolveFields(raw) {
  const { resolves, resolution } = raw;
  if (resolves === undefined && resolution === undefined) return null;
  if (typeof resolves !== 'string' || !/^([a-f0-9]{8}|[a-f0-9]{32})$/.test(resolves)) return 'resolves must be an item id (8 or 32 hex characters)';
  if (resolution !== undefined && !OVERSEER_RESOLUTIONS.includes(resolution)) return `resolution must be one of ${OVERSEER_RESOLUTIONS.join(', ')}`;
  return null;
}

export const isOpenFailure = s => s?.state === 'failed' && !s.resolution;

// One unresolved failed item named by its full id or its 8-character prefix; a prefix that matches several is ambiguous (null).
export function findOpenFailure(store, inboxDir, ref, exceptId = null) {
  const hits = store.allStatuses(inboxDir).filter(s => isOpenFailure(s) && s.id !== exceptId && s.id.startsWith(String(ref)));
  return hits.length === 1 ? hits[0] : null;
}

// Called when a proposal that carries `resolves` is picked up. Returns a refusal reason, or null after the old item is linked to the new one.
export function resolveOnPickup(store, inboxDir, item, newId, now) {
  if (!item.resolves) return null;
  const old = findOpenFailure(store, inboxDir, item.resolves, newId);
  if (!old) return 'resolves must name one failed Inbox item that has no resolution yet (full id or its 8-character prefix)';
  const type = item.resolution || 're-proposed';
  store.finish(inboxDir, old.id, { resolution: { type, ref: newId, at: now } }, now);
  return null;
}

// The homeowner's choice on the dashboard. `drop` and `done_elsewhere` need a note (the reason, or what did it).
// `keep_setting` acknowledges a changed setting on purpose and applies to an item with configChanges.
export function resolveByHomeowner(store, inboxDir, id, { decision, note }, now) {
  const type = Object.hasOwn(HOMEOWNER_RESOLUTIONS, decision) ? HOMEOWNER_RESOLUTIONS[decision] : null;
  if (!type) return { ok: false, reason: 'unknown resolution' };
  const text = String(note ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  if (!text) return { ok: false, reason: 'say why in a short note' };
  const s = store.allStatuses(inboxDir).find(x => x.id === id);
  if (!s) return { ok: false, reason: 'unknown item' };
  if (decision === 'keep_setting') {
    if (!s.configChanges || s.configAck) return { ok: false, reason: 'no unacknowledged setting change on this item' };
    store.finish(inboxDir, id, { configAck: { note: text, at: now } }, now);
    return { ok: true, state: s.state };
  }
  if (!isOpenFailure(s)) return { ok: false, reason: s.resolution ? 'the item already has a resolution' : `the item is ${s.state}, not failed` };
  store.finish(inboxDir, id, { resolution: { type, note: text, at: now } }, now);
  return { ok: true, state: s.state };
}
