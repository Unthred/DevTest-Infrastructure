// Issue #1164: the overseer's edits to the queue, kept in Foreman's team state as `directQueue` = { order: [issue numbers], entries: { n: edit } }.
// An edit never starts or stops work: the planner reads the queue through shape() and the dependency check through applyDependsEdits(), so an
// edit only changes which queued issue is taken first, by whom, and what it waits for. Pure functions over plain data; no I/O, no clock.

const TIER = { high: 0, normal: 1, low: 2 };
const DEFAULT = { priority: 'normal', dependsOn: null, agent: null, notes: null };

export const blankQueue = () => ({ order: [], entries: {} });
export const ensureQueue = s => { s.directQueue ||= blankQueue(); s.directQueue.order ||= []; s.directQueue.entries ||= {}; return s.directQueue; };
export const entryOf = (dq, n) => ({ ...DEFAULT, ...(dq?.entries?.[n] || {}) });
const isDefault = e => e.priority === 'normal' && e.dependsOn == null && e.agent == null && e.notes == null;
export const editedCount = dq => Object.keys(dq?.entries || {}).length;

// The queue as the planner takes it: an entry assigned to another agent is left out; high priority first, then the explicit order, then the
// order the list already had. `list` is the planner's own order (an agent's list, then the unlisted issues by number).
export function shape(dq, list, agent = null) {
  if (!dq || (!dq.order?.length && !editedCount(dq))) return list;
  const at = new Map((dq.order || []).map((n, i) => [n, i]));
  const rows = list.map((n, i) => ({ n, i, tier: TIER[entryOf(dq, n).priority] ?? 1, at: at.get(n) ?? Infinity }))
    .filter(r => agent == null || !entryOf(dq, r.n).agent || entryOf(dq, r.n).agent === agent);
  rows.sort((a, b) => a.tier - b.tier || (a.at === b.at ? a.i - b.i : a.at - b.at));
  return rows.map(r => r.n);
}

export const rankOf = (queue, n) => queue.indexOf(n) + 1;
export const without = (queue, n) => queue.filter(x => x !== n);

// The new full order after moving n to rank `rank` (1 = front); a rank beyond the end puts it last.
export function withRank(queue, n, rank) {
  const rest = without(queue, n), at = Math.min(rank, rest.length + 1) - 1;
  return [...rest.slice(0, at), n, ...rest.slice(at)];
}
// The new full order after moving n before or after `other`; null when `other` is not in the queue or is n itself.
export function withMove(queue, n, place, other) {
  if (other === n || !queue.includes(other)) return null;
  const rest = without(queue, n), at = rest.indexOf(other) + (place === 'after' ? 1 : 0);
  return [...rest.slice(0, at), n, ...rest.slice(at)];
}

// Sets one field of one entry. Returns the entry before and after; an entry that is back to the defaults is dropped.
export function setField(dq, n, patch) {
  const before = entryOf(dq, n), after = { ...before, ...patch };
  if (isDefault(after)) delete dq.entries[n]; else dq.entries[n] = after;
  return { before, after };
}
export function restoreEntry(dq, n, entry) {
  const e = { ...DEFAULT, ...(entry || {}) };
  if (isDefault(e)) delete dq.entries[n]; else dq.entries[n] = e;
}

// The issues the dependency check reads, with the overseer's Depends on edits applied. Only the dependency check sees this text.
export function applyDependsEdits(dq, issues) {
  if (!dq || !editedCount(dq)) return issues;
  return (issues || []).map(i => {
    const list = dq.entries[i.number]?.dependsOn;
    return Array.isArray(list) ? { ...i, body: list.length ? `Depends on: ${list.map(n => `#${n}`).join(', ')}` : '' } : i;
  });
}
