// Issue #1164: runs a picked-up overseer `control` item as a direct control, and the homeowner's undo requests. Every outcome, success or
// refusal, is written to the audit trail (directstore.mjs) with who, what, target, before and after, reason and time. The switch is read at
// the moment of the action, so turning direct control off on the dashboard takes effect on the next item. Nothing here merges, approves, closes
// or changes a limit: applyDirect refuses every name outside the direct list.
import { applyDirect, reverseDirect, directDeps } from './directactions.mjs';
import { readSwitch, appendAudit, pendingUndos, findRecord, isReversed, clearUndo } from './directstore.mjs';

export const SWITCH_OFF_TEXT = 'direct control is turned off on the dashboard, so the MCP can read and propose only; nothing was changed';

// The outcome of one action, as a plain object. A thrown error is a failure with its message, never a crash of the pass.
async function outcomeOf(item, team, dir) {
  if (!readSwitch(dir).enabled) return { outcome: 'refused', changed: false, text: SWITCH_OFF_TEXT };
  try { return await applyDirect(item, directDeps(team)); } catch (error) {
    return { outcome: 'failed', changed: false, text: `failed: ${String(error?.message || error).slice(0, 250)}` };
  }
}

export async function runDirect(team, dir, st, item, inboxStore, report) {
  const now = () => team.clock.now();
  if (!inboxStore.claim(dir, st.id, 'approved', { state: 'running' }, now())) return;
  const r = await outcomeOf(item, team, dir);
  const audit = appendAudit(dir, { at: now(), by: 'overseer', action: item.action, target: item.target, value: item.value ?? null,
    reason: item.reason, outcome: r.outcome,
    changed: r.changed === true, before: r.before ?? null, after: r.after ?? null, text: r.text, item: st.id.slice(0, 8), undo: r.undo ?? null });
  const control = { ...(st.control || {}), changed: r.changed === true, before: r.before ?? null, after: r.after ?? null, audit: audit?.id ?? null };
  if (r.outcome === 'done') inboxStore.finish(dir, st.id, { state: 'done', result: r.text, control }, now());
  else if (r.outcome === 'refused') inboxStore.finish(dir, st.id, { state: 'refused', reason: r.text, result: 'nothing was changed', control }, now());
  else inboxStore.finish(dir, st.id, { state: 'failed', reason: r.text, result: 'nothing was changed', control }, now());
  (report.actions ||= []).push({ type: 'overseer-control', result: `${item.action} ${item.target}: ${r.text}` });
}

// The undo requests the dashboard left: each reverses one audit record, once. The reverse is the homeowner's own action, so it runs
// even while direct control is off. A request for an unknown or already reversed record is dropped with a note in the trail.
export async function processDirectUndos(team, dir, report) {
  for (const id of pendingUndos(dir)) {
    const rec = findRecord(dir, id), now = team.clock.now();
    clearUndo(dir, id);
    if (!rec?.undo || isReversed(dir, id)) continue;
    let r;
    try { r = await reverseDirect(rec.undo, directDeps(team)); } catch (error) {
      r = { outcome: 'failed', changed: false, text: `failed: ${String(error?.message || error).slice(0, 250)}` };
    }
    appendAudit(dir, { at: now, by: 'homeowner', action: 'undo', target: `${rec.action} ${rec.target}`, of: id, outcome: r.outcome, changed: r.changed === true,
      before: r.before ?? null, after: r.after ?? null, text: r.text, reason: `undo of ${rec.action} ${rec.target}` });
    (report.actions ||= []).push({ type: 'direct-undo', result: `undo ${rec.action} ${rec.target}: ${r.text}` });
  }
}

// Runs one approved inbox item by its kind; kept out of Team so adding a kind does not grow that class.
export async function dispatchApproved(team, inboxStore, dir, st, item, report) {
  if (st.kind === 'issue_draft') await team.postIssueDraft(dir, st, item, report);
  if (st.state !== 'approved') return;
  if (st.kind === 'action') await team.runInboxAction(dir, st, item, report);
  if (st.kind === 'host_value') team.runHostValue(dir, st, item, report);
  if (st.kind === 'control') await runDirect(team, dir, st, item, inboxStore, report);
}
