// Issue #1155: the tick pass that keeps the homeowner steps of merged PRs current. Reads merged PRs of the last 30 days (the backfill on install,
// and every PR merged since), records each "Homeowner steps" section once, marks the steps Foreman can see are done, applies the dashboard's
// "done" clicks and re-raises what is still outstanding every 3 days. Throttled: the GitHub reads run at most every SCAN_MS.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from './core.mjs';
import { entryApproved } from './decisions.mjs';
import { homeownerSteps } from './homeownersteps.mjs';
import * as ps from './pendingsteps.mjs';

export const SCAN_MS = 10 * 60000;
const MAX_BODIES = 25;   // PR descriptions read per pass, so a large backfill spreads over a few passes
const doneDir = root => path.join(root, 'dashboard', 'step-done');

// The dashboard's "Mark done" click leaves one small request file; the tick, which owns the state, applies it (as for the breaker resume).
export function requestStepDone(root, pr, index, at) {
  fs.mkdirSync(doneDir(root), { recursive: true, mode: 0o700 });
  atomicJson(path.join(doneDir(root), `${at}-${crypto.randomBytes(4).toString('hex')}.json`), { pr, index, at });
}
function takeStepDone(root) {
  let names = [];
  try { names = fs.readdirSync(doneDir(root)).filter(n => n.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const n of names) {
    const file = path.join(doneDir(root), n);
    try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); if (Number.isSafeInteger(v?.pr) && Number.isSafeInteger(v?.index)) out.push({ pr: v.pr, index: v.index, file }); } catch { /* malformed: dropped */ }
    if (!out.some(r => r.file === file)) try { fs.unlinkSync(file); } catch { /* already taken */ }
  }
  return out;
}

// team: { s, c, gh, root, register, clock, alert, save }. Saves the state itself when something changed.
export async function syncPendingSteps(team, report = {}) {
  if (await syncSteps(team, report)) team.save();
}

async function syncSteps(team, report) {
  const { s, gh, clock } = team, now = clock.now();
  s.pendingSteps ||= {}; s.pendingStepsSeen ||= {};
  let changed = false;
  for (const r of takeStepDone(team.root)) {
    if (ps.markDone(s.pendingSteps, r.pr, r.index, now)) changed = true;
    try { fs.unlinkSync(r.file); } catch { /* already taken */ }
  }
  if (now - (s.pendingStepsScanAt || 0) >= SCAN_MS && gh.listMergedPulls && gh.pullBody) { s.pendingStepsScanAt = now; changed = (await scanMerged(team, now, report)) || changed; }
  if (await detect(team, now)) changed = true;
  if (ps.reraiseDue(s.pendingSteps, now) && team.alert) {
    try { await team.alert(ps.reraiseText(s.pendingSteps)); for (const e of Object.values(s.pendingSteps)) e.raisedAt = now; changed = true; }
    catch { (report.skipped ||= []).push({ what: 'alert homeowner steps', reason: 'alert delivery failed; will retry' }); }
  }
  for (const k of Object.keys(s.pendingSteps)) if (s.pendingSteps[k].steps.every(x => x.done) && now - Math.max(...s.pendingSteps[k].steps.map(x => x.doneAt || 0)) > 7 * 24 * 3600000) { delete s.pendingSteps[k]; changed = true; }   // finished entries are kept a week, outstanding ones never expire
  return changed;
}

async function scanMerged(team, now, report) {
  const { s, gh } = team;
  let merged;
  try { merged = await gh.listMergedPulls(); } catch (error) { (report.skipped ||= []).push({ what: 'homeowner steps scan', reason: String(error?.message || error).slice(0, 200) }); return false; }
  let changed = false, bodies = 0;
  for (const p of merged || []) {
    const at = Date.parse(p.mergedAt);
    if (!ps.withinWindow(at, now) || s.pendingStepsSeen[p.number]) continue;
    if (bodies >= MAX_BODIES) break;
    bodies++;
    let body; try { body = await gh.pullBody(p.number); } catch { continue; }   // not seen: the next scan retries
    s.pendingStepsSeen[p.number] = at; changed = true;
    const steps = homeownerSteps(body);
    if (steps.length && !s.pendingSteps[p.number]) s.pendingSteps[p.number] = ps.newEntry({ title: p.title, steps, mergedAt: at });
  }
  for (const [n, at] of Object.entries(s.pendingStepsSeen)) if (!ps.withinWindow(at, now)) { delete s.pendingStepsSeen[n]; changed = true; }
  return changed;
}

async function detect(team, now) {
  const { s, gh } = team, owner = String(team.c.repository || '').split('/')[0];
  const comments = new Map();   // pr -> approvalsFrom(...), read once per pass and only for a PR with an undone decision step
  for (const [n, e] of Object.entries(s.pendingSteps)) {
    if (e.steps.some(x => !x.done && ps.decisionsIn(x.text).length) && gh.prComments) { try { comments.set(n, ps.approvalsFrom(await gh.prComments(Number(n)), owner)); } catch { /* the register still counts */ } }
  }
  const ctx = { appConfigured: !!(team.c.github_app && team.c.github_app.key_file), registerApproved: id => entryApproved(String(team.register || ''), id), commentApproved: (pr, id) => comments.get(String(pr))?.has(id) === true };
  let changed = false;
  for (const [n, e] of Object.entries(s.pendingSteps)) if (ps.detectDone(e, Number(n), ctx, now)) changed = true;
  return changed;
}
