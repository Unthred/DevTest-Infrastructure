// Data layer of the team dashboard (issue #32). The tick WRITES a compact cache and history here; the dashboard server
// only READS. Nothing in this file calls GitHub or a model. All persisted values are already redacted: no prompts, no raw
// provider output, no session ids, no tokens, no account details.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './core.mjs';
import { checksState, prerequisites } from './team.mjs';

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
export const compactPulls = prs => (prs || []).map(p => ({ number: p.number, title: redact(p.title, 120), headRefName: redact(p.headRefName, 100), headRefOid: p.headRefOid, baseRefName: redact(p.baseRefName, 60), isDraft: p.isDraft === true, mergeable: p.mergeable,
  url: typeof p.url === 'string' ? p.url.slice(0, 200) : null,
  statusCheckRollup: (p.statusCheckRollup || []).slice(0, 40).map(c => ({ name: redact(c.name || c.context || '', 80), status: c.status, conclusion: c.conclusion, state: c.state })) }));
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

// The freshest allowance record the provider itself reported, per provider. Never an estimate.
export function latestAllowance(jobs) {
  const best = {};
  for (const j of jobs) if (j.allowance && Array.isArray(j.allowance.windows)) {
    const at = j.allowance.observedAt || 0;
    if (!best[j.provider] || at > best[j.provider].observedAt) best[j.provider] = { ...j.allowance, observedAt: at };
  }
  return best;
}

const rollup = pr => checksState(pr.statusCheckRollup);

// A skipped action (lease conflict, gh error) is a partial failure: the dashboard must not show it as a successful tick.
export function tickOutcome(report) {
  const skipped = Array.isArray(report?.skipped) ? report.skipped : [];
  if (!skipped.length) return { status: 'ok' };
  return { status: 'error', error: `${skipped.length} action(s) skipped: ${skipped.map(s => `${s.what}: ${s.reason}`).join('; ')}`.slice(0, 300) };
}

// Written by the tick (never by the dashboard server). `error` is the failure of this tick, if any.
export function recordTick(root, { now, status, error = null, team = null, jobs, actions = [] }) {
  const prev = readCache(root) || {};
  const cache = { schema: 1, tick: { at: now, status, error: error ? redact(error) : null, lastOkAt: status === 'ok' ? now : (prev.tick?.lastOkAt ?? null) },
    repository: team?.c.repository ?? prev.repository ?? null };
  if (team?.view) { cache.pulls = compactPulls(team.view.prs); cache.issues = compactIssues(team.view.issues); cache.delivered = [...(team.delivered || [])].filter(Number.isSafeInteger).sort((a, b) => a - b); cache.fetchedAt = now; }
  else { cache.pulls = prev.pulls || []; cache.issues = prev.issues || []; cache.delivered = prev.delivered || []; cache.fetchedAt = prev.fetchedAt ?? null; }
  atomicJson(cacheFile(root), cache);
  if (!team || (status !== 'ok' && status !== 'error')) return cache;
  const states = agentStates(team.c, jobs, now);
  const allowance = latestAllowance(jobs);
  const snap = { at: now, status,
    plan: actions.map(a => ({ agent: a.agent || null, type: a.type, ref: a.issue ?? a.pr })),
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
