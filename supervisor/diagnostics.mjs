// Issue #496: the Diagnostics tab's data. Read-only arithmetic on records the supervisor already keeps (tick snapshots, job records, the
// team state's verdicts) plus the memory flight recorder's host logs. No model call, no GitHub call. Idle time by cause is #487's figure:
// it comes from `idleReport`, never recomputed here. Everything is bounded: a stated retention window, a per-file and a per-call byte
// cap on the recorder logs, and a file-count cap. Output holds numbers and fixed words only (no path, host name or log text).
import fs from 'node:fs';
import path from 'node:path';
import { idleReport, busyIntervals } from './idlecause.mjs';

export const RETENTION_DAYS = 7;                       // history shown on the page; stated on it
export const DAY_MS = 86400000;
export const TICK_INTERVAL_MS = 5 * 60000;             // the planned gap between ticks (the reconcile cron runs every five minutes)
export const LATE_TICK_FACTOR = 2;                     // a gap of at least this many planned intervals is a missed tick
export const DEFAULT_RECORDER_DIR = '/mnt/cache/logs/memory-flight-recorder';
export const MAX_RECORDER_FILES = 40;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;         // per file, per read (a day of host samples is about 3 MiB)
export const MAX_TOTAL_BYTES = 48 * 1024 * 1024;       // per call

const dayStart = ms => Math.floor(ms / DAY_MS) * DAY_MS;
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const round1 = n => Math.round(n * 10) / 10;
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const days = (from, to) => { const out = []; for (let d = dayStart(from); d < to; d += DAY_MS) out.push(d); return out; };
// Per-day summary of a list of { at, minutes } samples.
function perDay(samples, from, to, extra = () => ({})) {
  return days(from, to).map(d => {
    const xs = samples.filter(s => s.at >= d && s.at < d + DAY_MS);
    const m = xs.map(s => s.minutes);
    return { day: dayKey(d), count: xs.length, medianMinutes: m.length ? round1(median(m)) : null, maxMinutes: m.length ? round1(Math.max(...m)) : null, totalMinutes: round1(m.reduce((a, b) => a + b, 0)), ...extra(xs) };
  });
}

// Planned versus actual gaps between consecutive ticks. A gap counts on the day the later tick ran.
export function tickGaps(snapshots, from, to, planned = TICK_INTERVAL_MS) {
  const ats = [...new Set((snapshots || []).map(s => s?.at).filter(Number.isFinite))].filter(a => a >= from && a <= to).sort((a, b) => a - b);
  const gaps = []; for (let i = 1; i < ats.length; i++) gaps.push({ at: ats[i], minutes: (ats[i] - ats[i - 1]) / 60000 });
  const rows = perDay(gaps, from, to, xs => ({ lateCount: xs.filter(g => g.minutes * 60000 >= LATE_TICK_FACTOR * planned).length, lostMinutes: round1(xs.reduce((t, g) => t + Math.max(0, g.minutes - planned / 60000), 0)) }));
  const dayTicks = d => ats.filter(a => a >= d && a < d + DAY_MS).length;
  return { plannedMinutes: planned / 60000, lateAtMinutes: LATE_TICK_FACTOR * planned / 60000, ticks: ats.length, days: rows.map((r, i) => ({ ...r, ticks: dayTicks(dayStart(from) + i * DAY_MS) })) };
}

// Time from one job ending to the agent's next job starting, per agent (jobs of its provider; overlapping jobs are one busy span).
export function jobTurnaround(jobs, agents, from, to) {
  const out = {};
  for (const [agent, provider] of Object.entries(agents)) {
    const busy = busyIntervals(jobs, provider, from, to), gaps = [];
    for (let i = 1; i < busy.length; i++) if (busy[i].start > busy[i - 1].end) gaps.push({ at: busy[i - 1].end, minutes: (busy[i].start - busy[i - 1].end) / 60000 });
    out[agent] = { days: perDay(gaps, from, to) };
  }
  return out;
}

// Time from a review job ending to its verdict being recorded. Carried verdicts (no review job of their own) are not counted.
export function verdictLag(jobs, verdicts, from, to) {
  const byId = new Map((jobs || []).filter(j => j && !j.unreadable && typeof j.id === 'string').map(j => [j.id, j]));
  const lags = [];
  for (const v of Object.values(verdicts || {})) {
    if (!v || v.carriedFrom || !Number.isFinite(v.at) || v.at < from || v.at > to) continue;
    const j = byId.get(v.job);
    if (!j || j.kind !== 'review' || !Number.isFinite(j.updatedAt) || v.at < j.updatedAt) continue;
    lags.push({ at: v.at, minutes: (v.at - j.updatedAt) / 60000 });
  }
  return { days: perDay(lags, from, to) };
}

// #487's idle report, one call per day of the window, so the history sits beside the 24-hour figure on the other pages.
export function idleHistory({ jobs, snapshots, agents, from, to }) {
  return days(from, to).map(d => {
    const a = Math.max(d, from), b = Math.min(d + DAY_MS, to);
    const rep = idleReport({ jobs, snapshots, agents, from: a, to: b });
    return { day: dayKey(d), windowMinutes: round1((b - a) / 60000), agents: Object.fromEntries(Object.entries(rep.agents).map(([n, r]) => [n, { busyMinutes: r.busyMinutes, idleWithWorkMinutes: r.idleWithWorkMinutes, idleWithWorkPercent: r.idleWithWorkPercent, minutes: r.minutes }])) };
  });
}

// ---- memory flight recorder: host-YYYYMMDD[-NNN].jsonl, one sample a minute. Hourly accumulators, kept per file and extended from the
// byte offset already read, so a finished day is read once and today's file only for its new lines.
const FILE = /^host-(\d{4})(\d{2})(\d{2})(?:-\d{3})?\.jsonl$/;
const cache = new Map();            // path -> { size, consumed, hours: Map<hourMs, acc> }
export const clearRecorderCache = () => cache.clear();
const newAcc = () => ({ n: 0, loadSum: 0, loadMax: 0, swapMaxPct: 0, swapMaxKb: 0, ioSum: 0, ioN: 0, ioMax: 0, blockedMax: 0 });
function addSample(hours, rec) {
  const t = Date.parse(rec.timestamp_utc), load = Array.isArray(rec.load_average) ? rec.load_average[0] : NaN;
  if (!Number.isFinite(t) || !Number.isFinite(load)) return false;
  const h = Math.floor(t / 3600000) * 3600000; let a = hours.get(h); if (!a) hours.set(h, a = newAcc());
  a.n++; a.loadSum += load; a.loadMax = Math.max(a.loadMax, load);
  const m = rec.memory_kb;
  if (m && Number.isFinite(m.swap_used_kb) && Number.isFinite(m.swap_total_kb) && m.swap_total_kb > 0) { a.swapMaxPct = Math.max(a.swapMaxPct, m.swap_used_kb / m.swap_total_kb * 100); a.swapMaxKb = Math.max(a.swapMaxKb, m.swap_used_kb); }
  if (Number.isFinite(rec.cpu_iowait_percent)) { a.ioSum += rec.cpu_iowait_percent; a.ioN++; a.ioMax = Math.max(a.ioMax, rec.cpu_iowait_percent); }
  if (Number.isFinite(rec.blocked_tasks)) a.blockedMax = Math.max(a.blockedMax, rec.blocked_tasks);
  return true;
}
// Reads the new bytes of one file (never more than the per-file cap). Returns { bytes, skipped, truncated }.
function readFileInto(file, size, budget) {
  let e = cache.get(file);
  if (!e || size < e.consumed) { e = { size: 0, consumed: 0, hours: new Map() }; cache.set(file, e); }
  let start = e.consumed, truncated = false;
  const cap = Math.min(MAX_FILE_BYTES, budget);
  if (size - start > cap) { start = size - cap; truncated = true; }     // too much new data: the newest part only
  if (size <= start) return { bytes: 0, skipped: 0, truncated };
  const buf = Buffer.alloc(size - start);
  const fd = fs.openSync(file, 'r'); try { fs.readSync(fd, buf, 0, buf.length, start); } finally { fs.closeSync(fd); }
  let text = buf.toString('utf8'); const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return { bytes: buf.length, skipped: 0, truncated };           // no complete line yet
  const used = Buffer.byteLength(text.slice(0, lastNl + 1)); text = text.slice(0, lastNl + 1);
  if (truncated) text = text.slice(text.indexOf('\n') + 1);                       // the first line is cut
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { skipped++; continue; }
    if (rec?.type !== 'host' || !addSample(e.hours, rec)) skipped++;
  }
  e.consumed = start + used; e.size = size;
  return { bytes: buf.length, skipped, truncated };
}
// status: ok | partial | empty | missing | unreadable. `note` is fixed text; nothing from the log or the OS error text is echoed.
export function readRecorder(dir, from, to) {
  const out = { status: 'ok', note: '', files: 0, samples: 0, skippedLines: 0, hourly: [], days: [] };
  let names;
  try { names = fs.readdirSync(dir); } catch (error) {
    if (error?.code === 'ENOENT') return { ...out, status: 'missing', note: 'The memory flight recorder log folder does not exist on this host.' };
    return { ...out, status: 'unreadable', note: 'The memory flight recorder log folder cannot be read.' };
  }
  const first = dayStart(from);
  const wanted = names.filter(n => { const m = FILE.exec(n); return m && Date.UTC(+m[1], +m[2] - 1, +m[3]) >= first && Date.UTC(+m[1], +m[2] - 1, +m[3]) <= to; }).sort().reverse();
  const notes = []; let budget = MAX_TOTAL_BYTES, bad = 0;
  if (wanted.length > MAX_RECORDER_FILES) { wanted.length = MAX_RECORDER_FILES; notes.push('Only the newest log files were read (file limit).'); }
  const seen = new Set(), hours = new Map();
  for (const n of wanted) {
    const file = path.join(dir, n); seen.add(file);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) { bad++; continue; }
      const r = readFileInto(file, st.size, budget); budget -= r.bytes; out.skippedLines += r.skipped;
      if (r.truncated) notes.push('A large log file was read from its newest part only (size limit).');
      if (budget <= 0) { notes.push('The read stopped at the per-call size limit.'); }
      out.files++;
      for (const [h, a] of cache.get(file).hours) { let t = hours.get(h); if (!t) hours.set(h, t = newAcc()); t.n += a.n; t.loadSum += a.loadSum; t.loadMax = Math.max(t.loadMax, a.loadMax); t.swapMaxPct = Math.max(t.swapMaxPct, a.swapMaxPct); t.swapMaxKb = Math.max(t.swapMaxKb, a.swapMaxKb); t.ioSum += a.ioSum; t.ioN += a.ioN; t.ioMax = Math.max(t.ioMax, a.ioMax); t.blockedMax = Math.max(t.blockedMax, a.blockedMax); }
    } catch { bad++; }
    if (budget <= 0) break;
  }
  for (const k of [...cache.keys()]) if (path.dirname(k) === dir && !seen.has(k)) cache.delete(k);     // files that left the window
  if (bad) notes.push(`${bad} log file${bad === 1 ? '' : 's'} could not be read.`);
  if (out.skippedLines) notes.push(`${out.skippedLines} line${out.skippedLines === 1 ? ' was' : 's were'} not valid samples and ${out.skippedLines === 1 ? 'was' : 'were'} skipped.`);
  const hourly = [...hours.entries()].filter(([h]) => h + 3600000 > from && h <= to).sort((a, b) => a[0] - b[0]);
  out.hourly = hourly.map(([h, a]) => ({ at: h, samples: a.n, loadAvg: round1(a.loadSum / a.n), loadMax: round1(a.loadMax), swapMaxPercent: round1(a.swapMaxPct), swapMaxKb: Math.round(a.swapMaxKb), iowaitAvg: a.ioN ? round1(a.ioSum / a.ioN) : null, iowaitMax: a.ioN ? round1(a.ioMax) : null, blockedMax: a.blockedMax }));
  out.samples = out.hourly.reduce((t, h) => t + h.samples, 0);
  out.days = days(from, to).map(d => {
    const xs = out.hourly.filter(h => h.at >= d && h.at < d + DAY_MS), n = xs.reduce((t, h) => t + h.samples, 0), ion = xs.filter(h => h.iowaitAvg !== null);
    if (!n) return { day: dayKey(d), samples: 0 };
    return { day: dayKey(d), samples: n, loadAvg: round1(xs.reduce((t, h) => t + h.loadAvg * h.samples, 0) / n), loadMax: Math.max(...xs.map(h => h.loadMax)), swapMaxPercent: Math.max(...xs.map(h => h.swapMaxPercent)), swapMaxKb: Math.max(...xs.map(h => h.swapMaxKb)),
      iowaitAvg: ion.length ? round1(ion.reduce((t, h) => t + h.iowaitAvg * h.samples, 0) / ion.reduce((t, h) => t + h.samples, 0)) : null, iowaitMax: ion.length ? Math.max(...ion.map(h => h.iowaitMax)) : null, blockedMax: Math.max(...xs.map(h => h.blockedMax)) };
  });
  if (!out.samples) { out.status = bad && !out.files ? 'unreadable' : 'empty'; notes.unshift(out.status === 'unreadable' ? 'No recorder log file could be read.' : 'The recorder log folder has no host samples in this window.'); }
  else if (notes.length) out.status = 'partial';
  out.note = notes.join(' ');
  return out;
}

// Everything the page shows. `recorderDir` null skips the recorder (status "missing").
export function buildDiagnostics({ jobs = [], snapshots = [], verdicts = {}, agents = {}, now = Date.now(), recorderDir = DEFAULT_RECORDER_DIR }) {
  const to = now, from = now - RETENTION_DAYS * DAY_MS;
  const snaps = snapshots.filter(s => Number.isFinite(s?.at) && s.at >= from - DAY_MS);
  return { generatedAt: now, from, to, retentionDays: RETENTION_DAYS, agents: Object.keys(agents),
    ticks: tickGaps(snaps, from, to), turnaround: jobTurnaround(jobs, agents, from, to), verdictLag: verdictLag(jobs, verdicts, from, to),
    idle: idleHistory({ jobs, snapshots: snaps, agents, from, to }),
    recorder: recorderDir ? readRecorder(recorderDir, from, to) : { status: 'missing', note: 'No recorder log folder is configured.', files: 0, samples: 0, hourly: [], days: [] } };
}
