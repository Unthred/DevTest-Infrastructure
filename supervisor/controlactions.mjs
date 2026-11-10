// Issue #1115: what an overseer `control` item (park, stop_job) and an approved `unpark` do. Each returns a plain outcome and never throws for a
// normal refusal: { outcome: 'done' | 'refused', changed, text }. The caller records who, when, why and the result in the item's status.
// Nothing here merges, approves or releases work except unpark, which only runs after the homeowner approved it on the dashboard.
import { addLabelAsApp } from './appidentity.mjs';
const PARKED = 'parked';
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'stopped', 'waiting_on']);
// The planner reads pull requests through this, so a parked one gets no rebase, fix, review or merge.
export const unparkedPulls = prs => (Array.isArray(prs) ? prs.filter(p => !p.labels?.includes(PARKED)) : prs);
const done = (changed, text) => ({ outcome: 'done', changed, text });
const refused = text => ({ outcome: 'refused', changed: false, text });

// The open pull request or issue with this number, or null. A pull request is looked up first (the numbers share one space).
async function findItem(gh, n) {
  const pr = (await gh.listPulls()).find(p => p.number === n);
  if (pr) return { kind: 'pull request', labels: pr.labels || [] };
  const issue = (await gh.listIssues()).find(i => i.number === n);
  return issue ? { kind: 'issue', labels: issue.labels || [] } : null;
}

// Live (not ended) jobs working on an issue or pull request number, as short ids.
async function liveJobsFor(n, { jobs, records }) {
  const ids = Object.keys(records).filter(id => records[id].pr === n || records[id].issue === n);
  const live = [];
  for (const id of ids) { const job = await jobs.get(id).catch(() => null); if (job && !TERMINAL.has(job.status)) live.push(id.slice(0, 8)); }
  return live;
}

export async function park(n, deps) {
  const found = await findItem(deps.gh, n);
  if (!found) return refused(`no open issue or pull request #${n}`);
  if (found.labels.includes(PARKED)) return done(false, `${found.kind} #${n} is already parked; nothing changed`);
  try { await deps.labelAsApp(n, PARKED); } catch (error) { return refused(`${found.kind} #${n} was not parked: ${String(error?.message || error).slice(0, 200)}`); }   // the App identity, never the owner account
  const live = await liveJobsFor(n, deps);
  const note = live.length ? ` Its running job${live.length > 1 ? 's' : ''} (${live.join(', ')}) ${live.length > 1 ? 'were' : 'was'} not stopped; stop ${live.length > 1 ? 'them' : 'it'} separately with stop_job.` : '';
  return done(true, `${found.kind} #${n} is parked.${note}`);
}

export async function unpark(n, deps) {
  const found = await findItem(deps.gh, n);
  if (!found) return refused(`no open issue or pull request #${n}`);
  if (!found.labels.includes(PARKED)) return refused(`${found.kind} #${n} is not parked`);
  await deps.gh.removeLabel(n, PARKED);
  return done(true, `${found.kind} #${n} is no longer parked`);
}

// The approved release: a refusal is an error, so the inbox item ends 'failed' with the reason and nothing is changed.
export async function unparkApproved(n, deps) {
  const r = await unpark(n, deps);
  if (r.outcome === 'refused') throw new Error(r.text);
  return r.text;
}

// `prefix` is the 8-character job id. Stopping records the stop on the job before the worker is signalled and clears its automatic restart
// (issue #1109), so the job is not started again and the stop is not an infrastructure fault.
export async function stopJob(prefix, deps) {
  const hits = Object.keys(deps.records).filter(id => id.startsWith(prefix));
  if (hits.length !== 1) return refused(hits.length ? `job id ${prefix} is ambiguous` : `no job ${prefix}`);
  const job = await deps.jobs.get(hits[0]);
  if (!job) return refused(`job ${prefix} is unknown to the supervisor`);
  if (TERMINAL.has(job.status)) return done(false, `job ${prefix} already ended (${job.status}); nothing to stop`);
  if (typeof deps.jobs.stop !== 'function') return refused('this supervisor cannot stop a job');
  await deps.jobs.stop(hits[0]);
  return done(true, `job ${prefix} stopped; it will not restart and uses no attempt`);
}

export async function applyControl({ action, target }, deps) {
  if (action === 'park') return park(Number(target), deps);
  if (action === 'unpark') return unpark(Number(target), deps);
  if (action === 'stop_job') return stopJob(target, deps);
  return refused('unknown action');
}

// The parked label is written as the GitHub App; a test may supply its own writer on the GitHub client.
export const depsOf = team => ({ gh: team.gh, jobs: team.jobs, records: team.s.jobs, labelAsApp: (n, label) => (team.gh.addLabelAsApp ?? ((x, l) => addLabelAsApp(team.c, x, l)))(n, label) });

// Runs one picked-up control item. 'running' is recorded BEFORE the effect (at most once, as for a named action). The status keeps who, why and
// the result (the item file is removed once final); a refusal ends 'refused' with its reason, a failure ends 'failed'.
export async function runControl(team, dir, st, item, inboxStore, report) {
  const now = () => team.clock.now();
  if (!inboxStore.claim(dir, st.id, 'approved', { state: 'running' }, now())) return;
  try {
    const r = await applyControl(item, depsOf(team));
    const control = { ...(st.control || {}), changed: r.changed };
    if (r.outcome === 'refused') inboxStore.finish(dir, st.id, { state: 'refused', reason: r.text, result: 'nothing was changed', control }, now());
    else inboxStore.finish(dir, st.id, { state: 'done', result: r.text, control }, now());
    (report.actions ||= []).push({ type: 'overseer-control', result: `${item.action} ${item.target}: ${r.text}` });
  } catch (error) {
    inboxStore.finish(dir, st.id, { state: 'failed', reason: String(error?.message || error).slice(0, 250), result: 'nothing was changed' }, now());
  }
}

// The recent control items for the view (the MCP tools show them beside the item or job they concern): who, when, why, and the result.
// Text is redacted and bounded again here, as for every inbox card.
export function controlRecords(inboxDir, inboxStore, limit = 50) {
  return inboxStore.allStatuses(inboxDir).filter(s => s.kind === 'control' && s.control).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, limit).map(s => ({
    id: s.id.slice(0, 8), action: s.control.action, target: s.control.target, by: s.control.by || 'overseer', reason: s.control.reason, state: s.state, changed: s.control.changed ?? null,
    at: s.createdAt ?? null, result: s.state === 'refused' ? s.reason ?? null : s.result ?? null }));
}
export const controlsOf = (config, store) => (config.inbox?.dir ? controlRecords(config.inbox.dir, store) : []);

// Runs one approved inbox item by its kind; kept out of Team so adding a kind does not grow that class.
export async function dispatchApproved(team, inboxStore, dir, st, item, report) {
  if (st.kind === 'issue_draft') await team.postIssueDraft(dir, st, item, report);
  if (st.state !== 'approved') return;
  if (st.kind === 'action') await team.runInboxAction(dir, st, item, report);
  if (st.kind === 'host_value') team.runHostValue(dir, st, item, report);
  if (st.kind === 'control') await runControl(team, dir, st, item, inboxStore, report);
}
