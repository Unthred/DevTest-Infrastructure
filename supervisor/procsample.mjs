// Live process accounting per agent and job (issue #568). Reads /proc directly with node:fs only: no process is spawned, no
// GitHub or model call is made, nothing is written. Only the kernel's short process name (comm) is read; command lines are never
// opened, because they can carry secrets. The result is cached, so any number of open tabs costs one reading per TTL.
//
// Attribution uses only what the supervisor already records on the job: the worker pid and the provider child pid (each checked
// against its recorded start time, so a reused pid is not mistaken for it), plus the child's process group, which the supervisor
// creates with `detached: true` and now keeps after the job ends (`childGroup`, `childEndedAt`). A process is attributed to a job
// when it is in that group or session, or descends from the verified worker or child. A process that matches no job, or matches
// more than one, is counted as unattributed. Nothing is guessed from names or directories.
import fs from 'node:fs';
import path from 'node:path';

export const SAMPLE_TTL_MS = 10000;      // one reading serves every tab for this long
export const CLIENT_POLL_MS = 15000;     // the open page asks again this often
export const STALE_AFTER_MS = 45000;     // three missed polls: the figures are labelled stale
export const HISTORY_POINTS = 120;       // 30 minutes at the client interval
const PAGE_BYTES = 4096, CLK_TCK = 100, SLACK_MS = 3000;

const readText = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };

// One process: null when it vanished or could not be parsed (it exited during the read). `status` adds swap; losing it keeps the rest.
export function readProcess(procRoot, pid) {
  const stat = readText(path.join(procRoot, String(pid), 'stat'));
  if (!stat) return null;
  const open = stat.indexOf('('), close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const f = stat.slice(close + 2).split(' ');
  const ppid = Number(f[1]), pgrp = Number(f[2]), sid = Number(f[3]), start = f[19], rss = Number(f[21]);
  if (![ppid, pgrp, sid, rss].every(Number.isFinite) || !start) return null;
  let swapKb = 0;
  const status = readText(path.join(procRoot, String(pid), 'status'));
  const m = status && /^VmSwap:\s+(\d+) kB/m.exec(status);
  if (m) swapKb = Number(m[1]);
  return { pid: Number(pid), name: stat.slice(open + 1, close).slice(0, 32), state: f[0], ppid, pgrp, sid, start, startTicks: Number(start), rssKb: Math.max(0, rss) * PAGE_BYTES / 1024, swapKb };
}

// The whole table. Entries that disappear between listing and reading are counted, not treated as errors.
export function readTable(procRoot = '/proc') {
  const names = fs.readdirSync(procRoot).filter(n => /^[1-9]\d*$/.test(n));
  const procs = []; let vanished = 0;
  for (const n of names) { const p = readProcess(procRoot, n); if (p) procs.push(p); else vanished += 1; }
  if (!procs.length) throw new Error('no process could be read');
  const stat = readText(path.join(procRoot, 'stat')), btime = stat && /^btime\s+(\d+)/m.exec(stat);
  const mem = readText(path.join(procRoot, 'meminfo')) || '';
  const kb = key => { const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(mem); return m ? Number(m[1]) : null; };
  const swapTotal = kb('SwapTotal'), swapFree = kb('SwapFree');
  return { procs, vanished, bootMs: btime ? Number(btime[1]) * 1000 : null,
    host: { memTotalKb: kb('MemTotal'), memAvailableKb: kb('MemAvailable'), swapUsedKb: swapTotal !== null && swapFree !== null ? swapTotal - swapFree : null, swapTotalKb: swapTotal } };
}

const LIVE_STATES = new Set(['running', 'queued']);
const startMs = (p, bootMs) => (bootMs === null ? null : bootMs + (p.startTicks / CLK_TCK) * 1000);
const sum = list => ({ processes: list.length, rssKb: list.reduce((a, p) => a + p.rssKb, 0), swapKb: list.reduce((a, p) => a + p.swapKb, 0) });

// Pure: a process table and the job records in, per-agent and per-job figures out.
export function attribute({ procs, bootMs = null, host = null, vanished = 0 }, jobs, now) {
  const byPid = new Map(procs.map(p => [p.pid, p]));
  const kids = new Map();
  for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
  const verified = (pid, start) => { const p = pid ? byPid.get(pid) : null; return p && start && p.start === String(start) && p.state !== 'Z' ? p : null; };
  const claims = new Map();   // pid -> job ids that claim it
  const perJob = [];
  for (const j of jobs) {
    if (!j || j.unreadable || !j.id || !j.provider) continue;
    const worker = verified(j.workerPid, j.workerStart), child = verified(j.childPid, j.childStart);
    const alive = Boolean(worker || child);
    const group = Number.isSafeInteger(j.childGroup) && j.childGroup > 1 ? j.childGroup : null;
    const members = new Set();
    const walk = pid => { if (members.has(pid)) return; members.add(pid); for (const k of kids.get(pid) || []) walk(k); };
    if (worker) walk(worker.pid);
    if (child) walk(child.pid);
    if (group) {
      // An ended job's group id can be reused by a later, unrelated process, so only a process that started while the job ran counts.
      const from = Number.isFinite(j.createdAt) ? j.createdAt - SLACK_MS : null, to = alive ? null : (Number.isFinite(j.childEndedAt) ? j.childEndedAt : Number.isFinite(j.updatedAt) ? j.updatedAt : null);
      for (const p of procs) {
        if (p.pgrp !== group && p.sid !== group) continue;
        const s = startMs(p, bootMs);
        if (!alive && (s === null || from === null || to === null || s < from || s > to + SLACK_MS)) continue;
        if (alive && s !== null && from !== null && s < from) continue;
        walk(p.pid);
      }
    }
    for (const pid of members) { if (!claims.has(pid)) claims.set(pid, []); claims.get(pid).push(j.id); }
    perJob.push({ job: j, alive, members });
  }
  const owner = pid => { const c = claims.get(pid); return c && c.length === 1 ? c[0] : null; };   // two claimants: nobody owns it
  const jobRows = [], agents = new Map();
  for (const { job: j, alive, members } of perJob) {
    const mine = [...members].filter(pid => owner(pid) === j.id).map(pid => byPid.get(pid)).filter(Boolean);
    if (!mine.length) continue;
    const row = { id: j.id, agent: j.provider, kind: j.kind || 'unknown', issue: Number.isSafeInteger(j.issue) ? j.issue : null, pr: Number.isSafeInteger(j.pr) ? j.pr : null,
      status: j.status || 'unknown', ageMs: Number.isFinite(j.createdAt) ? Math.max(0, now - j.createdAt) : null, leftover: !alive, ...sum(mine),
      top: topNames(mine) };
    jobRows.push(row);
    const a = agents.get(j.provider) || { agent: j.provider, ...sum([]), jobs: 0, leftoverProcesses: 0, leftoverJobs: 0 };
    a.processes += row.processes; a.rssKb += row.rssKb; a.swapKb += row.swapKb; a.jobs += 1;
    if (row.leftover) { a.leftoverProcesses += row.processes; a.leftoverJobs += 1; }
    agents.set(j.provider, a);
  }
  const attributed = new Set(); for (const pid of claims.keys()) if (owner(pid) !== null) attributed.add(pid);
  const rest = procs.filter(p => !attributed.has(p.pid));
  return { agents: [...agents.values()].sort((a, b) => b.rssKb - a.rssKb), jobs: jobRows.sort((a, b) => b.rssKb - a.rssKb),
    unattributed: { ...sum(rest), top: topNames(rest) }, total: sum(procs), ambiguous: [...claims.values()].filter(c => c.length > 1).length, vanished, host };
}
// Names only (comm), grouped and counted; never arguments.
function topNames(list, n = 4) {
  const m = new Map(); for (const p of list) m.set(p.name, (m.get(p.name) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n).map(([name, count]) => ({ name, count }));
}

// Cached reader. `get()` returns the newest reading, taking a new one only when the cached one is older than the TTL.
// A failed reading is kept as `error` with the last good one beside it, so the page can say so instead of showing old figures as current.
export function createSampler({ readJobs, procRoot = '/proc', now = () => Date.now(), ttlMs = SAMPLE_TTL_MS, read = readTable }) {
  let latest = null, lastGood = null; const history = new Map();
  const sampleOnce = () => {
    const at = now();
    try {
      const table = read(procRoot), result = attribute(table, readJobs(), at);
      lastGood = { at, ...result };
      for (const a of [...result.agents.map(x => ({ agent: x.agent, processes: x.processes, rssKb: x.rssKb, swapKb: x.swapKb })), { agent: '(unattributed)', ...result.unattributed }]) {
        const h = history.get(a.agent) || []; h.push({ at, processes: a.processes, rssKb: a.rssKb, swapKb: a.swapKb });
        while (h.length > HISTORY_POINTS) h.shift(); history.set(a.agent, h);
      }
      latest = { at, ok: true, error: null };
    } catch (error) { latest = { at, ok: false, error: String(error?.message || error).replace(/[^\x20-\x7e]/g, '?').slice(0, 120) }; }
  };
  return {
    get() {
      const t = now();
      if (!latest || t - latest.at >= ttlMs || t < latest.at) sampleOnce();
      return { ok: latest.ok, error: latest.error, attemptedAt: latest.at, reading: lastGood, history: Object.fromEntries(history), intervalMs: CLIENT_POLL_MS };
    }
  };
}

// 'fresh' | 'stale' | 'failed' | 'none' for a sample at time `t`.
export function readingStatus(sample, t) {
  if (!sample) return 'none';
  if (!sample.ok) return 'failed';
  if (!sample.reading) return 'none';
  return t - sample.reading.at > STALE_AFTER_MS ? 'stale' : 'fresh';
}
