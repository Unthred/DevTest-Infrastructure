// Data layer of the team dashboard (issue #32). The tick WRITES a compact cache and history here; the dashboard server
// only READS. Nothing in this file calls GitHub or a model. All persisted values are already redacted: no prompts, no raw
// provider output, no session ids, no tokens, no account details.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson } from './core.mjs';
import { redact } from './redact.mjs';
import { checksState, retriedIn, prerequisites, pullPrerequisites } from './team.mjs';
import { homeownerQuestion } from './homeowner-question.mjs';
import { hasReading } from './allowance.mjs';
import { MIN_UPGRADE_INTERVAL_MS } from './upgrade.mjs';
import { HOT_WINDOW_MS, archiveSnapshots, recordTimeline } from './history.mjs';
import { readIncidents } from './migrations.mjs';
import { classifyIdle } from './idlecause.mjs';

// Issue #362: the hot file keeps the last 35 days for the planner; older snapshots rotate into compressed monthly archives and are never deleted.
export const RETENTION_MS = HOT_WINDOW_MS;
export const STALE_TICK_MS = 10 * 60000;
export const dashDir = root => path.join(root, 'dashboard');
const cacheFile = root => path.join(dashDir(root), 'cache.json');
const historyFile = root => path.join(dashDir(root), 'snapshots.jsonl');

export { redact };

export function readJobs(root) {
  const dir = path.join(root, 'jobs'); const out = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue;
    // A record that cannot be parsed is kept as an `unreadable` marker, never dropped: dropping it would make a running job look idle.
    // Issue #193: the marker names the file and carries its age (modification time) so the dashboard can point at it and age it out.
    const marker = () => { let at = 0; try { at = fs.statSync(path.join(dir, name)).mtimeMs; } catch { at = 0; } return { unreadable: true, status: 'unreadable', file: name, at }; };
    try { const j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); out.push(j && typeof j === 'object' && !Array.isArray(j) ? j : marker()); }
    catch (error) { if (error instanceof SyntaxError) out.push(marker()); else if (error.code !== 'ENOENT') throw error; }
  }
  return out;
}
// The job statuses this version understands. A record with any other status was probably written by a newer version.
export const KNOWN_STATUSES = ['queued', 'running', 'paused_limit', 'paused_manual', 'blocked', 'failed', 'completed', 'stopped'];
// Issue #193: an unknown or unreadable record stops making an agent "Unknown" once it is this old, so one stale or legacy file in jobs/
// cannot hold the header at "Unknown" for ever. A record with no timestamp at all never ages out (fail safe).
export const UNKNOWN_RECORD_MAX_AGE_MS = 7 * 24 * 3600000;
export const unknownRecordName = j => j?.file ? String(j.file).slice(0, 80) : (typeof j?.id === 'string' ? j.id.slice(0, 32) : 'a record with no id');
const recordTime = j => [j?.updatedAt, j?.createdAt, j?.at].find(v => Number.isFinite(v) && v > 0) ?? null;
export const isUnknownJob = j => j?.unreadable === true || !KNOWN_STATUSES.includes(j?.status);
export function readEvents(root, jobIds) {
  const out = [];
  for (const id of jobIds) {
    if (!/^[a-f0-9]{32}$/.test(id)) continue;
    let text; try { text = fs.readFileSync(path.join(root, 'events', `${id}.jsonl`), 'utf8'); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const line of text.split('\n')) { try { const e = JSON.parse(line); if (e && Number.isFinite(e.at) && typeof e.kind === 'string') out.push({ at: e.at, job: id, kind: e.kind.slice(0, 64) }); } catch (error) { if (!(error instanceof SyntaxError)) throw error; } }
  }
  return out;
}
// Lease files (one per issue/worktree key) name the job that holds them. Shared by `team status` and the Supervisor page (#72).
export function readLeases(root) {
  const dir = path.join(root, 'leases'); const out = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    try { const l = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); if (typeof l.job === 'string') out.push({ job: l.job, at: l.at }); } catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; }
  }
  return out;
}
export function readTeamState(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'team', 'state.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return {}; throw error; }
}
export function readCache(root) {
  try { return JSON.parse(fs.readFileSync(cacheFile(root), 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
// "Last here" marker (issue #253): the one value the dashboard server writes. It moves only on an explicit Mark as read.
const seenFile = root => path.join(dashDir(root), 'last-seen.json');
export function readLastSeen(root) {
  try { const v = JSON.parse(fs.readFileSync(seenFile(root), 'utf8')); return Number.isFinite(v?.at) ? v.at : null; } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
export function writeLastSeen(root, at) {
  fs.mkdirSync(dashDir(root), { recursive: true, mode: 0o700 });
  atomicJson(seenFile(root), { at });
}
// The newest snapshot without parsing the whole history (issue #708): reads a bounded tail and falls back to the full read only if
// no complete line is in it.
export function readLastSnapshot(root) {
  let fd; try { fd = fs.openSync(historyFile(root), 'r'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, 512 * 1024), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    if (size > len) lines.shift();   // the first line of a tail read may be cut
    for (let i = lines.length - 1; i >= 0; i--) { try { const s = JSON.parse(lines[i]); if (s && Number.isFinite(s.at)) return s; } catch (error) { if (!(error instanceof SyntaxError)) throw error; } }
    return size > len ? readSnapshots(root).at(-1) ?? null : null;
  } finally { fs.closeSync(fd); }
}
export function readSnapshots(root) {
  let text; try { text = fs.readFileSync(historyFile(root), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const line of text.split('\n')) { try { const s = JSON.parse(line); if (s && Number.isFinite(s.at)) out.push(s); } catch (error) { if (!(error instanceof SyntaxError)) throw error; } }
  return out;
}

// What the cache keeps of GitHub data: just enough for the planner and the page, nothing else (no bodies, no comments;
// the issue and PR references parsed from a body are kept instead).
export const compactPulls = prs => (prs || []).map(p => ({ number: p.number, title: redact(p.title, 120), headRefName: redact(p.headRefName, 100), headRefOid: p.headRefOid, baseRefName: redact(p.baseRefName, 60), isDraft: p.isDraft === true, mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus,
  url: typeof p.url === 'string' ? p.url.slice(0, 200) : null,
  // Issue #928: when the PR was opened (ISO text), for the throughput numbers.
  ...(typeof p.createdAt === 'string' && Number.isFinite(Date.parse(p.createdAt)) ? { createdAt: p.createdAt } : {}),
  // Issue #430: only the numbers of the issues a PR closes, so a watched issue is followed to a PR whose branch has no issue-<n>.
  closingIssuesReferences: (p.closingIssuesReferences || []).map(r => ({ number: r?.number })).filter(r => Number.isSafeInteger(r.number) && r.number > 0).slice(0, 10),
  labels: (p.labels || []).map(l => (typeof l === 'string' ? l : l?.name)).includes('needs-homeowner') ? ['needs-homeowner'] : [],
  statusCheckRollup: (p.statusCheckRollup || []).slice(0, 40).map(c => ({ name: redact(c.name || c.context || '', 80), status: c.status, conclusion: c.conclusion, state: c.state })) }));
// The issue a merged PR closed: its closing reference, else the issue-<n> in its branch name (issue #147).
const issueOfMerged = m => { const n = m.closingIssuesReferences?.[0]?.number ?? Number(/\/issue-(\d+)(\D|$)/.exec(m.headRefName || '')?.[1]); return Number.isSafeInteger(n) && n > 0 ? n : null; };
// Recently merged PRs (number, title, time) for the "merged today" section of `team status`.
export const compactMerged = merged => (merged || []).filter(m => Number.isSafeInteger(m.number) && typeof m.mergedAt === 'string')
  .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, 30).map(m => ({ number: m.number, title: redact(m.title, 120), mergedAt: m.mergedAt, issue: issueOfMerged(m), ...(/^[0-9a-f]{40}$/.test(m.mergeCommit?.oid || '') ? { mergeSha: m.mergeCommit.oid } : {}) }));
export const compactIssues = issues => (issues || []).map(i => ({ number: i.number, title: redact(i.title, 120), state: i.state,
  // Issue #866: when the issue was opened and closed (ISO text from GitHub), for the headline progress numbers.
  ...(typeof i.createdAt === 'string' && Number.isFinite(Date.parse(i.createdAt)) ? { createdAt: i.createdAt } : {}), ...(typeof i.closedAt === 'string' && Number.isFinite(Date.parse(i.closedAt)) ? { closedAt: i.closedAt } : {}),
  labels: (i.labels || []).includes('needs-homeowner')
    ? ['needs-homeowner', ...(i.labels || []).filter(l => l !== 'needs-homeowner').slice(0, 9).map(l => redact(l, 40))]
    : (i.labels || []).slice(0, 10).map(l => redact(l, 40)),
  // Parsed from the full title and body before the body is dropped, so the dashboard's exclusions match the tick's (issue #212).
  prerequisites: prerequisites(i.body), pullPrerequisites: pullPrerequisites(i.title, i.body),
  // Issue #414: the question the issue states for the homeowner and whether Foreman filed it, read before the body is dropped.
  ...(homeownerQuestion(i.body) ? { question: homeownerQuestion(i.body) } : {}), ...(/devtest-postmerge v1/.test(i.body || '') ? { foremanFiled: true } : {}) }));

// idle | running | paused | blocked, per agent, from the supervisor's own job records.
export function agentStates(config, jobs, now) {
  const out = {};
  for (const [name, a] of Object.entries(config.agents)) {
    // Records this version cannot read (or whose provider it cannot tell) might be that agent's work: say "unknown", never "idle".
    const unknownJobs = jobs.filter(j => isUnknownJob(j) && (j.unreadable || j.provider === a.provider || typeof j.provider !== 'string')
      && (recordTime(j) === null || now - recordTime(j) < UNKNOWN_RECORD_MAX_AGE_MS));
    const unknown = unknownJobs.length > 0;
    const mine = jobs.filter(j => j.provider === a.provider && !isUnknownJob(j)).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    const active = mine.filter(j => ['queued', 'running', 'paused_limit', 'paused_manual'].includes(j.status));
    const live = active.find(j => ['running', 'queued'].includes(j.status));
    const paused = active.find(j => ['paused_limit', 'paused_manual'].includes(j.status));
    const latest = mine[0];
    let state = 'idle', job = null;
    if (live) { state = 'running'; job = live; }
    else if (paused) { state = 'paused'; job = paused; }
    else if (unknown) { state = 'unknown'; job = null; }
    else if (latest && ['blocked', 'failed'].includes(latest.status) && now - (latest.updatedAt || 0) < 48 * 3600000) { state = 'blocked'; job = latest; }
    // Issue #213: every live or paused job of this agent (a role can run beside another on one agent), not just the newest.
    out[name] = { state, job, jobs: active, last: latest || null, ...(unknown ? { unknownRecords: unknownJobs.slice(0, 5).map(unknownRecordName) } : {}) };
  }
  return out;
}

// The freshest allowance READING the provider itself reported, per provider: from job records and from the tick's
// model-free probes (`probes`: provider → record, see codexAllowanceProbe). Never an estimate. A record with no windows
// (e.g. Codex at the moment it hits its limit, issue #75) is not a reading and never hides an older one that has figures.
export function latestAllowance(jobs, probes = {}) {
  const best = {};
  const offer = (provider, a, source) => {
    if (!hasReading(a)) return;
    const at = a.observedAt || 0;
    if (!best[provider] || at > best[provider].observedAt) best[provider] = { ...a, observedAt: at, source: a.source || source };
  };
  for (const j of jobs) offer(j.provider, j.allowance, 'job');
  for (const [provider, a] of Object.entries(probes || {})) offer(provider, a, 'session-log');
  return best;
}
// Keep the newer of the previous and the new probe reading per provider, so a probe that finds nothing keeps the last one.
export function mergeProbes(prev = {}, next = {}) {
  const out = {};
  for (const [provider, a] of [...Object.entries(prev || {}), ...Object.entries(next || {})]) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(provider) || !hasReading(a)) continue;
    const clean = { provider, status: String(a.status || 'unknown').slice(0, 32), observedAt: Number(a.observedAt) || 0, source: a.source === 'probe' ? 'probe' : 'session-log',
      windows: a.windows.slice(0, 8).map(w => ({ type: String(w.type || '').slice(0, 24), windowMinutes: Number.isFinite(w.windowMinutes) ? w.windowMinutes : null, utilization: Number.isFinite(w.utilization) ? w.utilization : null, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null, status: String(w.status || 'unknown').slice(0, 32) })) };
    if (a.billing && typeof a.billing === 'object') clean.billing = { overageStatus: String(a.billing.overageStatus || 'unknown').slice(0, 32), usingOverage: a.billing.usingOverage === true, creditsAvailable: a.billing.creditsAvailable === true };
    if (!out[provider] || clean.observedAt > out[provider].observedAt) out[provider] = clean;
  }
  return out;
}

const rollup = (pr, team, now) => checksState(pr.statusCheckRollup, retriedIn(team.s?.cancelWatch, pr, now));
// On-demand probe result (issue #110): merged into the tick cache so the next tick and the dashboard see it. Returns false when
// there is no cache yet (a probes-only cache is created: no tick, empty lists, so the reading is never lost). The tick's own write
// merges the same way, so the newer reading wins.
export function storeProbes(root, probes) {
  const prev = readCache(root) || { schema: 1, tick: null, repository: null, pulls: [], issues: [], delivered: [], merged: [], pullFiles: {}, fetchedAt: null };
  atomicJson(cacheFile(root), { ...prev, probes: mergeProbes(prev.probes, probes) });
  return true;
}

// A skipped action (lease conflict, gh error) is a partial failure: the dashboard must not show it as a successful tick.
export function tickOutcome(report) {
  const skipped = Array.isArray(report?.skipped) ? report.skipped : [];
  if (!skipped.length) return { status: 'ok' };
  return { status: 'error', error: `${skipped.length} action(s) skipped: ${skipped.map(s => `${s.what}: ${s.reason}`).join('; ')}`.slice(0, 300) };
}

// Written by the tick (never by the dashboard server). `error` is the failure of this tick, if any.
export function recordTick(root, { now, status, error = null, team = null, jobs, actions = [], probes = {}, ingested = 0, startedAt = null, heldAgents = null, holds = {}, trigger = null, merged = null, noop = false, ghCalls = null, ghMs = null, check = null }) {
  const prev = readCache(root) || {};
  const cache = { schema: 1, tick: { at: now, status, error: error ? redact(error) : null, lastOkAt: status === 'ok' ? now : (prev.tick?.lastOkAt ?? null) },
    repository: team?.c.repository ?? prev.repository ?? null, probes: mergeProbes(prev.probes, probes) };
  if (team?.view) { cache.pulls = compactPulls(team.view.prs); cache.issues = compactIssues(team.view.issues); cache.delivered = [...(team.delivered || [])].filter(Number.isSafeInteger).sort((a, b) => a - b); cache.merged = compactMerged(team.merged); cache.mergedNumbers = (team.merged || []).map(x => x.number).filter(Number.isSafeInteger); cache.fetchedAt = now;
    // file lists the tick read for the second-opinion hold (null = unreadable), so the page shows the same hold as the tick
    cache.pullFiles = team.files instanceof Map ? Object.fromEntries([...team.files].map(([n, f]) => [n, Array.isArray(f) ? f.slice(0, 300).map(x => redact(String(x), 200)) : null])) : (prev.pullFiles || {}); }
  else { cache.pulls = prev.pulls || []; cache.issues = prev.issues || []; cache.delivered = prev.delivered || []; cache.merged = prev.merged || []; cache.mergedNumbers = prev.mergedNumbers || []; cache.pullFiles = prev.pullFiles || {}; cache.fetchedAt = prev.fetchedAt ?? null; }
  atomicJson(cacheFile(root), cache);
  if (!team || (status !== 'ok' && status !== 'error')) return cache;
  const states = agentStates(team.c, jobs, now);
  const allowance = latestAllowance(jobs, cache.probes);
  const snap = { at: now, status, ingested: Number.isSafeInteger(ingested) && ingested > 0 ? ingested : 0,
    plan: actions.map(a => ({ agent: a.agent || null, type: a.type, ref: a.issue ?? a.pr, ...(a.secondOpinion ? { secondOpinion: true } : {}), ...(a.postMerge ? { postMerge: true } : {}) })),
    agents: Object.fromEntries(Object.entries(states).map(([n, s]) => [n, s.state])),
    allowance: Object.fromEntries(Object.entries(team.c.agents).map(([n, a]) => [n, allowance[a.provider] ? { observedAt: allowance[a.provider].observedAt, windows: allowance[a.provider].windows.map(w => ({ type: w.type, windowMinutes: w.windowMinutes ?? null, utilization: w.utilization, resetsAt: w.resetsAt })) } : null])),
    // Issue #487: when the tick began and why each idle agent was idle (upgrade hold, a named hold for that agent, or nothing to do).
    ...(Number.isFinite(startedAt) ? { startedAt } : {}), idle: classifyIdle({ states: Object.fromEntries(Object.entries(states).map(([n, s]) => [n, s.state])), heldAgents, holds, plan: actions }),
    // Issue #406: what started this pass (schedule, job-end, install, inbox, approve); `merged` lists the other requests it absorbed. A snapshot
    // without `trigger` is from before wakes existed and was a scheduled pass.
    ...(typeof trigger === 'string' ? { trigger, ...(Array.isArray(merged) && merged.length ? { merged: merged.filter(x => typeof x === 'string').slice(0, 5) } : {}) } : {}),
    // Issue #755: a pass that GitHub's conditional requests proved unchanged and that did nothing; the gh processes the pass started; what the change check said.
    ...(noop === true ? { noop: true } : {}), ...(Number.isSafeInteger(ghCalls) ? { ghCalls } : {}), ...(Number.isFinite(ghMs) ? { ghMs: Math.round(ghMs) } : {}),
    ...(check && typeof check.result === 'string' ? { check: { result: check.result.slice(0, 20), reason: redact(String(check.reason || ''), 160), probes: Number.isSafeInteger(check.probes) ? check.probes : 0, served: Number.isSafeInteger(check.served) ? check.served : 0 } } : {}),
    redCi: team.view.prs.filter(p => rollup(p, team, now) === 'red').map(p => p.number) };
  // Issue #362: keep a compact, allowlisted timeline of everything the live records hold now, before any of it can expire.
  try { recordTimeline(root, { config: team.c, jobs, events: readEvents(root, jobs.map(j => j.id)), state: readTeamState(root), incidents: readIncidents(root) }); } catch (error) { console.error(`ai-supervisor: timeline record failed: ${error?.name || 'Error'}`); }
  appendSnapshot(root, snap, now);
  return cache;
}
export function appendSnapshot(root, snap, now) {
  const file = historyFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(snap) + '\n', { mode: 0o600 });
  // Rotation (issue #362): move snapshots older than the hot window into the monthly archive, rarely, with an atomic rewrite.
  const size = fs.statSync(file).size;
  // Check at most about once an hour (first tick of the hour), or at once if the file is over the hard cap.
  const hourly = now % 3600000 < 300000 && size > 256 * 1024;
  if (!hourly && size < 16 * 1024 * 1024) return;
  const all = readSnapshots(root), keep = all.filter(s => now - s.at <= RETENTION_MS), old = all.filter(s => now - s.at > RETENTION_MS);
  if (!old.length) return;
  archiveSnapshots(root, old);   // archive first: a crash before the rewrite leaves a duplicate that readers drop, never a loss
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, keep.map(s => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

// Version badge data (no git, no network here). installed: the commit the `current` link points at right now, so a manual upgrade
// is reflected at once; the self-upgrade records are only the fallback and the source of "main" (the newest commit they saw).
// running: the commit this very process was loaded from; when it differs from installed the server needs a restart.
const SHA40 = /^[0-9a-f]{40}$/;
export function codeVersion(url = import.meta.url) { const m = /\/versions\/([0-9a-f]{40})\//.exec(fileURLToPath(url)); return m ? m[1] : null; }
export function readVersion(root, { running = codeVersion(), now = Date.now() } = {}) {
  let last = null;
  try {
    for (const line of fs.readFileSync(path.join(root, 'team', 'upgrades.jsonl'), 'utf8').split('\n')) { try { const r = JSON.parse(line); if (r && typeof r.to === 'string') last = r; } catch (error) { if (!(error instanceof SyntaxError)) throw error; } }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let linked = null, linkedAt = null;
  try { const m = /^versions\/([0-9a-f]{40})$/.exec(fs.readlinkSync(path.join(root, 'current'))); if (m) { linked = m[1]; linkedAt = fs.lstatSync(path.join(root, 'current')).mtimeMs; } } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EINVAL') throw error; }
  if (!last && !linked) return null;
  const fromRecords = last ? (['upgraded', 'verified', 'dashboard_restarted', 'dashboard_restart_failed'].includes(last.result) ? last.to : last.from) : null;
  const installed = linked || fromRecords || '';
  // The records name main only as far as they went. If the link was moved after the newest record (a manual upgrade), they say
  // nothing about main beyond what is installed, so no drift is claimed.
  const stale = last && linked && linked !== last.to && Number.isFinite(last.at) && linkedAt > last.at;
  // Issue #265: live origin/main as the upgrader last fetched it (self-upgrade.json), not the last attempted target. It is only
  // trusted while it was fetched for the installed commit, so a manual swap does not claim stale drift.
  let seen = null, upgradeState = null;
  try { upgradeState = JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.json'), 'utf8')); const m = upgradeState?.main; if (m && SHA40.test(m.sha || '') && m.from === installed) seen = m; } catch { /* no state: fall back to the records */ }
  const main = seen ? seen.sha : (!last || stale ? installed : last.to);
  const behind = seen && Number.isSafeInteger(seen.behind) ? seen.behind : null;
  const run = SHA40.test(running || '') ? running : null;
  // Issue #331: when the upgrade is rate-limited the header says when the next try is.
  let nextTryAt = null; const l = upgradeState?.lastUpgradeAt; if (Number.isFinite(l) && l + MIN_UPGRADE_INTERVAL_MS > now) nextTryAt = l + MIN_UPGRADE_INTERVAL_MS;
  // Issue #695: when merged work is installed next, or why it waits; written by the upgrader, shown as "Next install". Merged is not installed.
  let nextInstall = null; const ni = upgradeState?.nextInstall; if (ni && installed !== main && typeof ni.why === 'string') nextInstall = { at: Number.isFinite(ni.at) ? ni.at : null, why: ni.why.slice(0, 200), state: String(ni.state || '').slice(0, 12) };
  return { nextInstall, installed: String(installed).slice(0, 40), main: String(main).slice(0, 40), drift: !!installed && installed !== main, behind: installed === main ? 0 : behind, nextTryAt: installed === main ? null : nextTryAt, running: run, result: String(last?.result || '').slice(0, 24), at: last?.at ?? null };
}
