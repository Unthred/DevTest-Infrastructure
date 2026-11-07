// Issue #972: hold new job starts while Tower itself is overloaded (swap, available memory, load per core), read from /proc.
// Only starts are held: a running job is never stopped because of host load. Two levels with hysteresis (a level latches when a hold
// threshold is crossed and releases only when every figure is back past its resume threshold, so it does not flap):
//   start  implement and continue jobs (the work that adds the most load)
//   hard   reviews, fixes, CI fixes, rebases and approved inbox prompts (allowed one level higher than the start level)
// Read-only: /proc only, no command line, no writes outside the caller's state. A figure that cannot be read never holds anything.
import fs from 'node:fs';
import os from 'node:os';
import { SupervisorError } from './core.mjs';

export const DEFAULT_HOST_GATE = {
  enabled: true,
  hold: { swap_percent: 85, memory_available_mb: 4096, load_per_core: 1.5 },
  resume: { swap_percent: 75, memory_available_mb: 5120, load_per_core: 1.2 },
  hard_hold: { swap_percent: 95, memory_available_mb: 2048, load_per_core: 2.5 },
  hard_resume: { swap_percent: 90, memory_available_mb: 3072, load_per_core: 2.0 },
};
const SETS = ['hold', 'resume', 'hard_hold', 'hard_resume'];
const KEYS = ['swap_percent', 'memory_available_mb', 'load_per_core'];
// Job types per level; anything else (a merge is not a job start) is never held.
export const LEVEL_OF_TYPE = { implement: 'start', continue: 'start', review: 'hard', fix: 'hard', cifix: 'hard', rebase: 'hard', inbox: 'hard' };

export function normalizeHostGate(input) {
  if (input === undefined) return structuredClone(DEFAULT_HOST_GATE);
  const bad = m => { throw new SupervisorError(`invalid team config: host_gate ${m}`); };
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('must be an object');
  for (const k of Object.keys(input)) if (k !== 'enabled' && !SETS.includes(k)) bad(`has unknown key ${k}`);
  if ('enabled' in input && typeof input.enabled !== 'boolean') bad('enabled must be true or false');
  const out = { enabled: input.enabled ?? true };
  for (const s of SETS) {
    const given = input[s] ?? {};
    if (typeof given !== 'object' || Array.isArray(given) || given === null) bad(`${s} must be an object`);
    for (const k of Object.keys(given)) if (!KEYS.includes(k)) bad(`${s} has unknown key ${k}`);
    out[s] = { ...DEFAULT_HOST_GATE[s], ...given };
    for (const k of KEYS) if (!(typeof out[s][k] === 'number' && Number.isFinite(out[s][k]) && out[s][k] > 0)) bad(`${s}.${k} must be a positive number`);
    if (out[s].swap_percent > 100) bad(`${s}.swap_percent must be at most 100`);
  }
  // Hysteresis: a resume threshold must be no stricter than its hold threshold, or the level could never release (or would flap).
  for (const [h, r] of [['hold', 'resume'], ['hard_hold', 'hard_resume']]) {
    if (out[r].swap_percent > out[h].swap_percent) bad(`${r}.swap_percent must not be above ${h}.swap_percent`);
    if (out[r].memory_available_mb < out[h].memory_available_mb) bad(`${r}.memory_available_mb must not be below ${h}.memory_available_mb`);
    if (out[r].load_per_core > out[h].load_per_core) bad(`${r}.load_per_core must not be above ${h}.load_per_core`);
  }
  // The hard level is one level above the start level: it must not trip earlier.
  if (out.hard_hold.swap_percent < out.hold.swap_percent || out.hard_hold.memory_available_mb > out.hold.memory_available_mb || out.hard_hold.load_per_core < out.hold.load_per_core) bad('hard_hold must be no stricter than hold');
  return out;
}

const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };

// The figures the gate judges, plus the core count. Anything unreadable is null.
export function readHostFigures({ proc = '/proc', cores = null } = {}) {
  const la = (readText(`${proc}/loadavg`) || '').trim().split(/\s+/);
  const mem = {}; for (const line of (readText(`${proc}/meminfo`) || '').split('\n')) { const m = /^(\w+):\s+(\d+)/.exec(line); if (m) mem[m[1]] = Number(m[2]); }
  let n = cores;
  if (!Number.isInteger(n) || n < 1) { const cpuinfo = readText(`${proc}/cpuinfo`); n = cpuinfo ? (cpuinfo.match(/^processor\s*:/gm) || []).length : 0; }
  if (!n) { try { n = os.cpus().length; } catch { n = 0; } }
  const swapTotal = mem.SwapTotal, swapFree = mem.SwapFree;
  const five = Number(la[1]);
  return {
    cores: n > 0 ? n : null,
    load: { one: Number(la[0]) || null, five: Number.isFinite(five) && la[1] !== undefined ? five : null, fifteen: Number(la[2]) || null },
    loadPerCore: n > 0 && Number.isFinite(five) && la[1] !== undefined ? Math.round((five / n) * 100) / 100 : null,
    memoryAvailableMb: Number.isFinite(mem.MemAvailable) ? Math.round(mem.MemAvailable / 1024) : null,
    memoryTotalMb: Number.isFinite(mem.MemTotal) ? Math.round(mem.MemTotal / 1024) : null,
    swapPercent: swapTotal > 0 && Number.isFinite(swapFree) ? Math.round(((swapTotal - swapFree) / swapTotal) * 1000) / 10 : null,
    swapUsedMb: swapTotal > 0 && Number.isFinite(swapFree) ? Math.round((swapTotal - swapFree) / 1024) : null,
    swapTotalMb: Number.isFinite(swapTotal) ? Math.round(swapTotal / 1024) : null,
  };
}

const gb = mb => `${Math.round((mb / 1024) * 10) / 10} GB`;
// One figure against a hold and a resume threshold. 'breach' = at or past the hold threshold; 'recovering' = latched and not yet past resume.
function judge(sample, hold, resume) {
  const out = [];
  const swap = sample.swapPercent;
  if (Number.isFinite(swap)) out.push({ key: 'swap', breach: swap >= hold.swap_percent, clear: swap < resume.swap_percent,
    now: `swap ${Math.round(swap)}%`, hold: `swap ${Math.round(swap)}% ≥ ${hold.swap_percent}%`, wait: `swap ${Math.round(swap)}%, resumes below ${resume.swap_percent}%` });
  const mem = sample.memoryAvailableMb;
  if (Number.isFinite(mem)) out.push({ key: 'memory', breach: mem < hold.memory_available_mb, clear: mem >= resume.memory_available_mb,
    now: `memory ${gb(mem)} available`, hold: `memory ${gb(mem)} available < ${gb(hold.memory_available_mb)}`, wait: `memory ${gb(mem)} available, resumes at ${gb(resume.memory_available_mb)}` });
  const lpc = sample.loadPerCore;
  if (Number.isFinite(lpc)) out.push({ key: 'load', breach: lpc > hold.load_per_core, clear: lpc <= resume.load_per_core,
    now: `load ${lpc}/core`, hold: `load ${lpc}/core > ${hold.load_per_core}`, wait: `load ${lpc}/core, resumes at ${resume.load_per_core} or less` });
  return out;
}

// Advance one level's latch. `prev` is the stored latch ({ held, since, reason } or undefined). Returns the new latch.
export function stepLevel(prev, sample, hold, resume, now) {
  const f = judge(sample, hold, resume);
  const breaching = f.filter(x => x.breach), notClear = f.filter(x => !x.clear);
  const held = breaching.length > 0 || (!!prev?.held && notClear.length > 0);
  if (!held) return { held: false, since: null, reason: null };
  const reason = `held: ${(breaching.length ? [...breaching.map(x => x.hold), ...notClear.filter(x => !x.breach).map(x => x.wait)] : notClear.map(x => x.wait)).join(', ')}`;
  return { held: true, since: prev?.held && Number.isFinite(prev.since) ? prev.since : now, reason };
}

// The whole gate state after one sample: { at, sample, start: latch, hard: latch }. A disabled gate never holds.
export function stepGate(prev, sample, cfg, now) {
  if (!cfg?.enabled) return { at: now, sample, enabled: false, start: { held: false, since: null, reason: null }, hard: { held: false, since: null, reason: null } };
  return { at: now, sample, enabled: true, start: stepLevel(prev?.start, sample, cfg.hold, cfg.resume, now), hard: stepLevel(prev?.hard, sample, cfg.hard_hold, cfg.hard_resume, now) };
}

// Why a job type may not start now, or null. The start level also holds when the hard level does (it is the stricter gate).
export function hostRefusal(gate, type) {
  if (!gate?.enabled) return null;
  const level = LEVEL_OF_TYPE[type];
  if (!level) return null;
  if (gate.hard?.held) return gate.hard.reason;
  if (level === 'start' && gate.start?.held) return gate.start.reason;
  return null;
}

// The Overview's host card: each figure with a status (ok / warning: held-level latch still waiting for the resume threshold / action:
// past a hold threshold), and what is held and since when. Null when no tick has sampled the host yet.
export function hostView(gate, cfg, now) {
  if (!gate?.sample) return null;
  const c = cfg ?? DEFAULT_HOST_GATE, s = gate.sample;
  const level = (hold, resume, latch) => (key) => {
    const f = judge(s, hold, resume).find(x => x.key === key);
    if (!f) return 'info';
    return f.breach ? 'action' : (latch?.held && !f.clear) ? 'warning' : 'ok';
  };
  const worst = (...a) => (a.includes('action') ? 'action' : a.includes('warning') ? 'warning' : a.includes('info') ? 'info' : 'ok');
  const startSev = level(c.hold, c.resume, gate.start), hardSev = level(c.hard_hold, c.hard_resume, gate.hard);
  const sevOf = key => worst(startSev(key) === 'action' ? 'warning' : startSev(key), hardSev(key));   // past the start threshold only: amber; past the hard one: red
  const figures = [
    { key: 'swap', label: 'Swap used', text: Number.isFinite(s.swapPercent) ? `${s.swapPercent}%${Number.isFinite(s.swapUsedMb) ? ` (${gb(s.swapUsedMb)} of ${gb(s.swapTotalMb)})` : ''}` : 'unknown' },
    { key: 'memory', label: 'Memory available', text: Number.isFinite(s.memoryAvailableMb) ? `${gb(s.memoryAvailableMb)}${Number.isFinite(s.memoryTotalMb) ? ` of ${gb(s.memoryTotalMb)}` : ''}` : 'unknown' },
    { key: 'load', label: 'Load per core (5 min)', text: Number.isFinite(s.loadPerCore) ? `${s.loadPerCore}${Number.isFinite(s.cores) ? ` (${s.cores} cores)` : ''}` : 'unknown' },
  ].map(f => ({ ...f, sev: sevOf(f.key) }));
  const lv = l => ({ held: !!l?.held, since: l?.held ? l.since : null, heldMs: l?.held && Number.isFinite(l.since) ? Math.max(0, now - l.since) : null, reason: l?.held ? l.reason : null });
  return { enabled: gate.enabled !== false, at: gate.at, ageMs: Number.isFinite(gate.at) ? Math.max(0, now - gate.at) : null, figures, start: lv(gate.start), hard: lv(gate.hard) };
}
