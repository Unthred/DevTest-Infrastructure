// Issue #1164: runs one direct control or reverses one. applyDirect(item, deps) -> { outcome, changed, text, before, after, undo };
// reverseDirect(record, deps) runs the reverse step stored on an audit record. `deps` is built by directDeps(team) from the live Team.
import { directPark, directUnpark, directStop, directPause, directStart, restartStopped } from './directjobs.mjs';
import { setRank, moveEntry, setPriority, setNotes, setDependsOn, assign, removeEntry, restoreOrder, restoreField } from './directedits.mjs';
import { readValue, notDirectReason, DIRECT } from './directspec.mjs';
import { ensureQueue } from './directqueue.mjs';
import { roleOfType } from './roles.mjs';
import { addLabelAsApp } from './appidentity.mjs';

const refused = text => ({ outcome: 'refused', changed: false, text });
const number = target => Number(target);
const WITH_VALUE = { set_rank: setRank, move_entry: moveEntry, set_priority: setPriority, set_notes: setNotes, set_depends_on: setDependsOn, assign };
const PLAIN = {
  park: n => deps => directPark(number(n), deps), unpark: n => deps => directUnpark(number(n), deps), remove_entry: n => deps => removeEntry(number(n), deps),
  stop_job: id => deps => directStop(id, deps), pause_job: id => deps => directPause(id, deps), start_job: id => deps => directStart(id, deps),
};

export async function applyDirect({ action, target, value }, deps) {
  const why = notDirectReason(action);
  if (why) return refused(why);
  const read = readValue(action, value);
  if (!read.ok) return refused(read.reason);
  if (Object.hasOwn(WITH_VALUE, action)) return WITH_VALUE[action](number(target), read.parsed, deps);
  return PLAIN[action](target)(deps);
}

// The reverse step of a record: unpark/park and the job steps run through the same checks as the forward action.
export async function reverseDirect(undo, deps) {
  if (undo.op === 'unpark') return directUnpark(undo.n, deps);
  if (undo.op === 'park') return directPark(undo.n, deps);
  if (undo.op === 'start_job') return directStart(undo.id, deps);
  if (undo.op === 'pause_job') return directPause(undo.id, deps);
  if (undo.op === 'restart') return restartStopped(undo.id, deps);
  if (undo.op === 'order') return restoreOrder(deps, undo);
  if (undo.op === 'entry') return restoreField(deps, undo);
  if (undo.op === 'unremove') return unremove(undo, deps);
  return refused('this action has no reverse step');
}

async function unremove(undo, deps) {
  const r = await directUnpark(undo.n, deps);
  if (r.outcome !== 'done') return r;
  if (JSON.stringify(deps.dq.order) === JSON.stringify(undo.after)) { deps.dq.order = [...undo.before]; deps.save(); }
  return { ...r, text: `#${undo.n} is back in the queue and no longer parked` };
}

// Everything the direct controls need from the live Team, in one place so the control code does not reach into it elsewhere.
export function directDeps(team) {
  const labelAsApp = (n, label) => (team.gh.addLabelAsApp ?? ((x, l) => addLabelAsApp(team.c, x, l)))(n, label);
  return {
    team, gh: team.gh, jobs: team.jobs, records: team.s.jobs, labelAsApp, dq: ensureQueue(team.s), save: () => team.save(), now: () => team.clock.now(),
    agents: team.agents().map(([name]) => name), issuesOf: agent => team.issuesOf(agent), delivered: team.delivered, roleOf: roleOfType,
  };
}
export const DIRECT_ACTIONS = Object.keys(DIRECT);
