// Data layer of the team dashboard (issue #32). The tick WRITES a compact cache and history here; the dashboard server
// only READS. Nothing in this file calls GitHub or a model. All persisted values are already redacted: no prompts, no raw
// provider output, no session ids, no tokens, no account details.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicJson } from './core.mjs';
import { checksState, prerequisites } from './team.mjs';
import { hasReading } from './allowance.mjs';

export const RETENTION_MS = 35 * 86400000;
export const MAX_SNAPSHOTS = 12000;          // five-minute ticks for ~41 days; the age bound normally applies first
export const STALE_TICK_MS = 10 * 60000;
export const dashDir = root => path.join(root, 'dashboard');
const cacheFile = root => path.join(dashDir(root), 'cache.json');
const historyFile = root => path.join(dashDir(root), 'snapshots.jsonl');

// Anything shown on the page that originates from an error message or free text passes through this.
export function redact(value, max = 200) {
  return String(value ?? '')
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[email]')
    .replace(/\b(?:gh[pousr]_|github_pat_|sk-|xox[abp]-)[\w-]{8,}/g, '[token]')
    .replace(/\b[Bb]earer\s+[\w.~+/=-]{8,}/g, 'Bearer [token]')
    .replace(/\b(?!0{40}\b)(?![0-9a-f]{40}\b)[A-Za-z0-9_-]{40,}\b/g, '[token]')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

export function readJobs(root) {
  const dir = path.join(root, 'jobs'); const out = [];
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.json')) continue;
    try { out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); } catch (error) { if (!(error instanceof SyntaxError) && error.code !== 'ENOENT') throw error; }
  }
  return out;
}
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
export function readSnapshots(root) {
  let text; try { text = fs.readFileSync(historyFile(root), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const line of text.split('\n')) { try { const s = JSON.parse(line); if (s && Number.isFinite(s.at)) out.push(s); } catch (error) { if (!(error instanceof SyntaxError)) throw error; } }
  return out;
}

// What the cache keeps of GitHub data: just enough for the planner and the page, nothing else (no bodies, no comments).
export const compactPulls = prs => (prs || []).map(p => ({ number: p.number, title: redact(p.title, 120), headRefName: redact(p.headRefName, 100), headRefOid: p.headRefOid, baseRefName: redact(p.baseRefName, 60), isDraft: p.isDraft === true, mergeable: p.mergeable, mergeStateStatus: p.mergeStateStatus,
  url: typeof p.url === 'string' ? p.url.slice(0, 200) : null,
  statusCheckRollup: (p.statusCheckRollup || []).slice(0, 40).map(c => ({ name: redact(c.name || c.context || '', 80), status: c.status, conclusion: c.conclusion, state: c.state })) }));
// Recently merged PRs (number, title, time) for the "merged today" section of `team status`.
export const compactMerged = merged => (merged || []).filter(m => Number.isSafeInteger(m.number) && typeof m.mergedAt === 'string')
  .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt)).slice(0, 30).map(m => ({ number: m.number, title: redact(m.title, 120), mergedAt: m.mergedAt }));
export const compactIssues = issues => (issues || []).map(i => ({ number: i.number, title: redact(i.title, 120), state: i.state,
  labels: (i.labels || []).includes('needs-homeowner')
    ? ['needs-homeowner', ...(i.labels || []).filter(l => l !== 'needs-homeowner').slice(0, 9).map(l => redact(l, 40))]
    : (i.labels || []).slice(0, 10).map(l => redact(l, 40)),
  prerequisites: prerequisites(i.body) }));

// idle | running | paused | blocked, per agent, from the supervisor's own job records.
export function agentStates(config, jobs, now) {
  const out = {};
  for (const [name, a] of Object.entries(config.agents)) {
    const mine = jobs.filter(j => j.provider === a.provider).sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    const active = mine.filter(j => ['queued', 'running', 'paused_limit', 'paused_manual'].includes(j.status));
    const live = active.find(j => ['running', 'queued'].includes(j.status));
    const paused = active.find(j => ['paused_limit', 'paused_manual'].includes(j.status));
    const latest = mine[0];
    let state = 'idle', job = null;
    if (live) { state = 'running'; job = live; }
    else if (paused) { state = 'paused'; job = paused; }
    else if (latest && ['blocked', 'failed'].includes(latest.status) && now - (latest.updatedAt || 0) < 48 * 3600000) { state = 'blocked'; job = latest; }
    out[name] = { state, job, last: latest || null };
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
    const clean = { provider, status: String(a.status || 'unknown').slice(0, 32), observedAt: Number(a.observedAt) || 0, source: 'session-log',
      windows: a.windows.slice(0, 8).map(w => ({ type: String(w.type || '').slice(0, 24), windowMinutes: Number.isFinite(w.windowMinutes) ? w.windowMinutes : null, utilization: Number.isFinite(w.utilization) ? w.utilization : null, resetsAt: Number.isFinite(w.resetsAt) ? w.resetsAt : null, status: String(w.status || 'unknown').slice(0, 32) })) };
    if (!out[provider] || clean.observedAt > out[provider].observedAt) out[provider] = clean;
  }
  return out;
}

const rollup = pr => checksState(pr.statusCheckRollup);

// A skipped action (lease conflict, gh error) is a partial failure: the dashboard must not show it as a successful tick.
export function tickOutcome(report) {
  const skipped = Array.isArray(report?.skipped) ? report.skipped : [];
  if (!skipped.length) return { status: 'ok' };
  return { status: 'error', error: `${skipped.length} action(s) skipped: ${skipped.map(s => `${s.what}: ${s.reason}`).join('; ')}`.slice(0, 300) };
}

// Written by the tick (never by the dashboard server). `error` is the failure of this tick, if any.
export function recordTick(root, { now, status, error = null, team = null, jobs, actions = [], probes = {} }) {
  const prev = readCache(root) || {};
  const cache = { schema: 1, tick: { at: now, status, error: error ? redact(error) : null, lastOkAt: status === 'ok' ? now : (prev.tick?.lastOkAt ?? null) },
    repository: team?.c.repository ?? prev.repository ?? null, probes: mergeProbes(prev.probes, probes) };
  if (team?.view) { cache.pulls = compactPulls(team.view.prs); cache.issues = compactIssues(team.view.issues); cache.delivered = [...(team.delivered || [])].filter(Number.isSafeInteger).sort((a, b) => a - b); cache.merged = compactMerged(team.merged); cache.fetchedAt = now; }
  else { cache.pulls = prev.pulls || []; cache.issues = prev.issues || []; cache.delivered = prev.delivered || []; cache.merged = prev.merged || []; cache.fetchedAt = prev.fetchedAt ?? null; }
  atomicJson(cacheFile(root), cache);
  if (!team || (status !== 'ok' && status !== 'error')) return cache;
  const states = agentStates(team.c, jobs, now);
  const allowance = latestAllowance(jobs, cache.probes);
  const snap = { at: now, status,
    plan: actions.map(a => ({ agent: a.agent || null, type: a.type, ref: a.issue ?? a.pr, ...(a.secondOpinion ? { secondOpinion: true } : {}), ...(a.postMerge ? { postMerge: true } : {}) })),
    agents: Object.fromEntries(Object.entries(states).map(([n, s]) => [n, s.state])),
    allowance: Object.fromEntries(Object.entries(team.c.agents).map(([n, a]) => [n, allowance[a.provider] ? { observedAt: allowance[a.provider].observedAt, windows: allowance[a.provider].windows.map(w => ({ type: w.type, windowMinutes: w.windowMinutes ?? null, utilization: w.utilization, resetsAt: w.resetsAt })) } : null])),
    redCi: team.view.prs.filter(p => rollup(p) === 'red').map(p => p.number) };
  appendSnapshot(root, snap, now);
  return cache;
}
export function appendSnapshot(root, snap, now) {
  const file = historyFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(snap) + '\n', { mode: 0o600 });
  // Bounded retention: trim by age and count, rarely, with an atomic rewrite.
  const size = fs.statSync(file).size;
  // Check at most about once an hour (first tick of the hour), or at once if the file is over the hard cap.
  const hourly = now % 3600000 < 300000 && size > 256 * 1024;
  if (!hourly && size < 16 * 1024 * 1024) return;
  const keep = readSnapshots(root).filter(s => now - s.at <= RETENTION_MS).slice(-MAX_SNAPSHOTS);
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, keep.map(s => JSON.stringify(s)).join('\n') + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

// Version badge data (no git, no network here). installed: the commit the `current` link points at right now, so a manual upgrade
// is reflected at once; the self-upgrade records are only the fallback and the source of "main" (the newest commit they saw).
// running: the commit this very process was loaded from; when it differs from installed the server needs a restart.
const SHA40 = /^[0-9a-f]{40}$/;
export function codeVersion(url = import.meta.url) { const m = /\/versions\/([0-9a-f]{40})\//.exec(fileURLToPath(url)); return m ? m[1] : null; }
export function readVersion(root, { running = codeVersion() } = {}) {
  let last = null;
  try {
    for (const line of fs.readFileSync(path.join(root, 'team', 'upgrades.jsonl'), 'utf8').split('\n')) { try { const r = JSON.parse(line); if (r && typeof r.to === 'string') last = r; } catch (error) { if (!(error instanceof SyntaxError)) throw error; } }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let linked = null, linkedAt = null;
  try { const m = /^versions\/([0-9a-f]{40})$/.exec(fs.readlinkSync(path.join(root, 'current'))); if (m) { linked = m[1]; linkedAt = fs.lstatSync(path.join(root, 'current')).mtimeMs; } } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EINVAL') throw error; }
  if (!last && !linked) return null;
  const fromRecords = last ? (['upgraded', 'verified'].includes(last.result) ? last.to : last.from) : null;
  const installed = linked || fromRecords || '';
  // The records name main only as far as they went. If the link was moved after the newest record (a manual upgrade), they say
  // nothing about main beyond what is installed, so no drift is claimed.
  const stale = last && linked && linked !== last.to && Number.isFinite(last.at) && linkedAt > last.at;
  const main = !last || stale ? installed : last.to;
  const run = SHA40.test(running || '') ? running : null;
  return { installed: String(installed).slice(0, 40), main: String(main).slice(0, 40), drift: !!installed && installed !== main, running: run, result: String(last?.result || '').slice(0, 24), at: last?.at ?? null };
}
