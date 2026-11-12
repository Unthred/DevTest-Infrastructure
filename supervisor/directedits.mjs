// Issue #1164: the direct controls that edit one queued entry (rank, move, priority, Depends on, agent, notes) or remove it from the queue.
// A queued entry is an open issue that is not parked, not implemented, has no pull request and no live job. Each function returns
// { outcome, changed, text, before, after, undo }; a refusal names the state that stopped it. The edits live in `deps.dq` (directqueue.mjs).
import { liveJobsFor } from './controlactions.mjs';
import { shape, rankOf, withRank, withMove, setField, entryOf, editedCount, restoreEntry } from './directqueue.mjs';
import { MAX_EDITED_ENTRIES } from './directspec.mjs';

const done = (changed, text, extra = {}) => ({ outcome: 'done', changed, text, ...extra });
const refused = text => ({ outcome: 'refused', changed: false, text });
const PARKED = 'parked';

// The open issues in the planner's order after the overseer's edits: every agent's list, then the issues in no list by number.
export async function queueOf(deps) {
  const open = (await deps.gh.listIssues()).filter(i => i.state === 'OPEN').sort((a, b) => a.number - b.number);
  const openNumbers = new Set(open.map(i => i.number));
  const listed = deps.agents.flatMap(a => deps.issuesOf(a));
  const raw = [...new Set([...listed, ...open.map(i => i.number)])].filter(n => openNumbers.has(n));
  return { raw, list: shape(deps.dq, raw), open };
}

// Why n is not a queued entry, or null when it is one. `parkedOk` lets remove_entry answer an already parked entry itself.
async function notQueued(n, deps, open) {
  const issue = open.find(i => i.number === n);
  if (!issue) {
    const pr = (await deps.gh.listPulls()).find(p => p.number === n);
    return pr ? `#${n} is a pull request, not a queued issue` : `no open issue #${n}`;
  }
  if ((issue.labels || []).includes(PARKED)) return `#${n} is parked, so it is not queued; unpark it first`;
  if (deps.delivered?.has(n)) return `#${n} is already implemented`;
  const pull = (await deps.gh.listPulls()).find(p => new RegExp(`/issue-${n}(\\D|$)`).test(p.headRefName || ''));
  if (pull) return `#${n} already has pull request #${pull.number}`;
  const live = await liveJobsFor(n, deps);
  return live.length ? `#${n} is being worked on by job ${live[0]}; stop it first` : null;
}

const sameOrder = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sameEntry = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Rank and move both set the whole explicit order; the planner's list is then re-read to say where the entry really sits.
async function reorder(n, deps, build, describe) {
  const q = await queueOf(deps), why = await notQueued(n, deps, q.open);
  if (why) return refused(why);
  const before = { rank: rankOf(q.list, n), of: q.list.length }, previous = [...deps.dq.order];
  const order = build(q.list);
  if (!order) return refused(`#${n} cannot be placed there: the other entry is not in the queue`);
  deps.dq.order = order;
  const after = { rank: rankOf(shape(deps.dq, q.raw), n), of: q.list.length };
  if (after.rank === before.rank) { deps.dq.order = previous; return done(false, `#${n} is already at rank ${after.rank} of ${after.of}`, { before, after }); }
  deps.save();
  return done(true, `#${n} is now rank ${after.rank} of ${after.of}${describe(after)}`, { before, after, undo: { op: 'order', before: previous,
    after: order } });
}

export const setRank = (n, p, deps) => reorder(n, deps, list => withRank(list, n, p.rank),
  after => (after.rank === p.rank ? '' : ` (rank ${p.rank} asked; its priority tier or the end of the queue decides the rest)`));
export const moveEntry = (n, p, deps) => reorder(n, deps, list => withMove(list, n, p.place, p.other), () => '');

// One field of one entry. `unchanged` and `text` are given by the caller so each field says what it did in its own words.
async function editField(n, deps, patch, { same, said }) {
  const q = await queueOf(deps), why = await notQueued(n, deps, q.open);
  if (why) return refused(why);
  const current = entryOf(deps.dq, n);
  if (same(current)) return done(false, said.same(current), { before: said.view(current), after: said.view(current) });
  if (!deps.dq.entries[n] && editedCount(deps.dq) >= MAX_EDITED_ENTRIES) {
    return refused(`${MAX_EDITED_ENTRIES} entries already carry an edit; clear some before adding another`);
  }
  const { before, after } = setField(deps.dq, n, patch);
  deps.save();
  return done(true, said.done(after), { before: said.view(before), after: said.view(after), undo: { op: 'entry', n, before, after } });
}

export const setPriority = (n, p, deps) => editField(n, deps, { priority: p.priority }, {
  same: e => e.priority === p.priority,
  said: { view: e => ({ priority: e.priority }), same: e => `#${n} already has ${e.priority} priority`, done: e => `#${n} now has ${e.priority} priority` } });

export const setNotes = (n, p, deps) => editField(n, deps, { notes: p.notes }, {
  same: e => (e.notes ?? '') === p.notes,
  said: { view: e => ({ notes: e.notes }), same: () => `#${n} already has these notes`, done: () => `notes set on #${n}` } });

const sameSet = (a, b) => Array.isArray(a) && sameOrder([...a].sort((x, y) => x - y), [...b].sort((x, y) => x - y));
export async function setDependsOn(n, p, deps) {
  if (p.dependsOn.includes(n)) return refused(`#${n} cannot depend on itself`);
  const text = list => (list == null ? 'the Depends on line of the issue itself' : list.length ? list.map(x => `#${x}`).join(', ') : 'no prerequisites');
  return editField(n, deps, { dependsOn: p.dependsOn }, {
    same: e => sameSet(e.dependsOn, p.dependsOn),
    said: { view: e => ({ dependsOn: e.dependsOn }), same: e => `#${n} already waits on ${text(e.dependsOn)}`,
      done: e => `#${n} now waits on ${text(e.dependsOn)}` } });
}

export async function assign(n, p, deps) {
  if (p.agent && !deps.agents.includes(p.agent)) return refused(`unknown agent ${p.agent} (configured: ${deps.agents.join(', ')})`);
  const text = a => (a ? `agent ${a}` : 'no fixed agent');
  return editField(n, deps, { agent: p.agent }, {
    same: e => e.agent === p.agent,
    said: { view: e => ({ agent: e.agent }), same: e => `#${n} is already assigned to ${text(e.agent)}`,
      done: e => `#${n} is now assigned to ${text(e.agent)}` } });
}

// Removing an entry parks it (the issue stays open) and drops its place in the explicit order.
export async function removeEntry(n, deps) {
  const q = await queueOf(deps), issue = q.open.find(i => i.number === n);
  if (issue && (issue.labels || []).includes(PARKED)) return done(false, `#${n} is already parked; nothing changed`, { before: { parked: true },
    after: { parked: true } });
  const why = await notQueued(n, deps, q.open);
  if (why) return refused(why);
  try { await deps.labelAsApp(n, PARKED); } catch (error) { return refused(`#${n} was not parked: ${String(error?.message || error).slice(0, 200)}`); }
  const previous = [...deps.dq.order], rank = rankOf(q.list, n);
  deps.dq.order = previous.filter(x => x !== n);
  deps.save();
  return done(true, `#${n} is removed from the queue and parked; the issue stays open`, { before: { parked: false, rank }, after: { parked: true },
    undo: { op: 'unremove', n, before: previous, after: deps.dq.order } });
}

// The reverse steps of the queue edits. Each applies only while the data is still as the action left it, so a later edit is never overwritten.
export function restoreOrder(deps, { before, after }) {
  if (!sameOrder(deps.dq.order, after)) return refused('the queue order has changed since; undo the later change first');
  deps.dq.order = [...before];
  deps.save();
  return done(true, 'the earlier queue order is restored', { before: { order: after.length }, after: { order: before.length } });
}
export function restoreField(deps, { n, before, after }) {
  if (!sameEntry(entryOf(deps.dq, n), { ...entryOf(null, n), ...after })) return refused(`#${n} has been edited since; undo the later change first`);
  restoreEntry(deps.dq, n, before);
  deps.save();
  return done(true, `the earlier edit of #${n} is restored`, { before: after, after: before });
}
