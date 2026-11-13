// Issue #1151: the host pressure hold measures whether starting a job would hurt the host, not how full swap ever got.
// Memory pressure is sustained swap activity (pages in plus out per second, averaged over a window) or available memory under a
// floor. Swap used percent alone never holds starts; it is a low priority warning. Disk thresholds are unchanged (issue #1007).
// This module has two halves: pure decisions (evaluateHostPressure, the sample window) and the readers that carry them out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorError } from './core.mjs';
import { hostPressure as diskPressure } from './jobtmp.mjs';

export const HOST_PRESSURE_DEFAULTS = Object.freeze({
  disk_percent: 80,              // root volume used percent above which starts are held
  swap_pages_per_second: 200,    // pages swapped in plus out per second, averaged over the window, above which starts are held
  swap_window_minutes: 5,        // the averaging window
  min_available_mb: 1024,        // available memory below which starts are held
  swap_warn_percent: 90          // swap used percent that raises a low priority warning only
});
const KEYS = Object.keys(HOST_PRESSURE_DEFAULTS);
const MINUTE = 60000;
const MAX_STATE_AGE_MS = 30 * MINUTE;   // a pressure record older than this is not trusted (the tick that wrote it is no longer running)
const MAX_SAMPLES = 120;

// Validates team.json `host_pressure` (absent is fine) and returns the configuration with defaults filled in.
export function hostPressureConfig(section) {
  if (section === undefined) return { ...HOST_PRESSURE_DEFAULTS };
  if (!section || typeof section !== 'object' || Array.isArray(section) || Object.keys(section).some(k => !KEYS.includes(k))) {
    throw new SupervisorError(`invalid team config: host_pressure takes only ${KEYS.join(', ')}`);
  }
  const out = { ...HOST_PRESSURE_DEFAULTS, ...section };
  const range = { disk_percent: [1, 100], swap_pages_per_second: [1, 1e7], swap_window_minutes: [1, 120], min_available_mb: [0, 1e7], swap_warn_percent: [1, 100] };
  for (const [k, [lo, hi]] of Object.entries(range)) {
    if (!(typeof out[k] === 'number' && Number.isFinite(out[k]) && out[k] >= lo && out[k] <= hi)) throw new SupervisorError(`invalid team config: host_pressure.${k}`);
  }
  return out;
}

// ---- pure decisions

// Samples are [atMs, cumulativePages]. A counter that went down (reboot) starts the window again. Returns the samples to keep.
export function addSwapSample(samples, sample, windowMinutes) {
  const keep = Array.isArray(samples) ? samples.filter(s => Array.isArray(s) && Number.isFinite(s[0]) && Number.isFinite(s[1])) : [];
  if (sample == null) return keep;
  const last = keep.at(-1);
  const base = last && (sample[1] < last[1] || sample[0] <= last[0]) ? [] : keep;
  const oldest = sample[0] - windowMinutes * MINUTE * 2;
  return [...base.filter(s => s[0] >= oldest), sample].slice(-MAX_SAMPLES);
}

// Average pages per second over the window ending at the newest sample, or null while the history does not cover half the window.
// The start is the newest sample at or before the window's start (ticks can be further apart than the window), else the oldest inside it.
export function swapRate(samples, windowMinutes) {
  const last = samples.at(-1);
  if (!last) return null;
  const windowStart = last[0] - windowMinutes * MINUTE;
  const from = samples.findLast(s => s[0] <= windowStart) || samples.find(s => s[0] >= windowStart);
  const seconds = from ? (last[0] - from[0]) / 1000 : 0;
  if (seconds < windowMinutes * 30) return null;
  return (last[1] - from[1]) / seconds;
}

const round1 = n => Math.round(n * 10) / 10;

// readings: { diskPercent, swapPercent, swapRate, availableMb } (any may be null = unreadable, which never holds).
// Returns every measure with its current value and limit, so the surfaces can show them whether or not they tripped.
export function evaluateHostPressure(cfg, readings) {
  const { diskPercent = null, swapPercent = null, swapRate: rate = null, availableMb = null } = readings;
  const window = cfg.swap_window_minutes;
  const measures = [
    { id: 'disk', label: 'Root volume used', unit: '%', value: diskPercent, limit: cfg.disk_percent, hold: true, tripped: diskPercent != null && diskPercent > cfg.disk_percent,
      text: `the root volume is ${diskPercent}% full (limit ${cfg.disk_percent}%)` },
    { id: 'swap-activity', label: `Swap activity, ${window} minute average`, unit: ' pages/s', value: rate == null ? null : round1(rate), limit: cfg.swap_pages_per_second, hold: true,
      tripped: rate != null && rate > cfg.swap_pages_per_second, text: `swap activity is ${rate == null ? '?' : Math.round(rate)} pages per second over ${window} minutes (limit ${cfg.swap_pages_per_second})` },
    { id: 'memory', label: 'Available memory', unit: ' MB', value: availableMb, limit: cfg.min_available_mb, hold: true, below: true,
      tripped: availableMb != null && availableMb < cfg.min_available_mb, text: `available memory is ${availableMb} MB (floor ${cfg.min_available_mb} MB)` },
    { id: 'swap-used', label: 'Swap used', unit: '%', value: swapPercent, limit: cfg.swap_warn_percent, hold: false,
      tripped: swapPercent != null && swapPercent > cfg.swap_warn_percent, text: `swap is ${swapPercent}% used (a warning only; it does not hold starts)` }
  ];
  const holding = measures.filter(m => m.hold && m.tripped);
  return { hold: holding.length > 0, reasons: holding.map(m => m.text), measures, warnings: measures.filter(m => !m.hold && m.tripped).map(m => m.text) };
}

export const pressureText = p => {
  const largest = p.top?.length ? ` Largest: ${p.top.map(t => `${t.path} ${(t.bytes / 1048576).toFixed(0)} MB`).join('; ')}.` : '';
  return `${(p.reasons || []).join(' and ')}; new job starts are held until it recovers.${largest}`;
};

// What the tick keeps in state.hostPressure: enough for every surface to show the same hold and the same thresholds.
export function pressureRecord(p, now, previous = null) {
  return {
    at: now, hold: !!p.hold, reasons: p.reasons || [], reason: p.hold ? `host pressure: ${(p.reasons || []).join(' and ')}` : null,
    measures: p.measures || previous?.measures || [], warnings: p.warnings || [], samples: p.samples || previous?.samples || []
  };
}
export function recordHostPressure(team, p) {
  team.s.hostPressure = pressureRecord(p, team.clock.now(), team.s.hostPressure);
  return p;
}

// The hold in force as the surfaces see it: the last tick's record while it is fresh, otherwise none.
export function activeHostHold(state, now) {
  const r = state?.hostPressure;
  return r?.hold && Number.isFinite(r.at) && now - r.at <= MAX_STATE_AGE_MS && r.reason ? r : null;
}

// For foreman_status and the Health page: current values next to their thresholds, and the hold if one is in force.
export function hostPressureView(state, cfg, now) {
  const r = state?.hostPressure || null;
  const active = activeHostHold(state, now);
  const thresholds = hostPressureConfig(cfg?.host_pressure);
  return {
    hold: !!active, reason: active?.reason ?? null, readAt: r?.at ?? null, thresholds,
    measures: (r?.measures || []).map(({ id, label, unit, value, limit, hold, tripped, below }) => ({ id, label, unit, value, limit, holdsStarts: hold, tripped, below: !!below })),
    warnings: r?.warnings || []
  };
}

// ---- readers

const kb = (text, key) => Number((new RegExp(`^${key}:\\s+(\\d+)`, 'm').exec(text) || [])[1]);
export function readMemory(meminfo = '/proc/meminfo') {
  try {
    const t = fs.readFileSync(meminfo, 'utf8');
    const total = kb(t, 'SwapTotal');
    const free = kb(t, 'SwapFree');
    const avail = kb(t, 'MemAvailable');
    return {
      availableMb: Number.isFinite(avail) ? Math.round(avail / 1024) : null,
      swapPercent: total > 0 && Number.isFinite(free) ? Math.round(((total - free) / total) * 100) : null
    };
  } catch { return { availableMb: null, swapPercent: null }; }
}
// Cumulative pages swapped in plus out since boot, or null when unreadable.
export function readSwapPages(vmstat = '/proc/vmstat') {
  try {
    const t = fs.readFileSync(vmstat, 'utf8');
    const get = key => Number((new RegExp(`^${key}\\s+(\\d+)`, 'm').exec(t) || [])[1]);
    const total = get('pswpin') + get('pswpout');
    return Number.isFinite(total) ? total : null;
  } catch { return null; }
}

// One reading for the tick. `readers` are test seams. Disk comes from the existing check so its figures and top consumers are unchanged.
export function readHostPressure(team, readers = {}) {
  const cfg = hostPressureConfig(team.c.host_pressure);
  const now = team.clock.now();
  const dirs = [os.tmpdir(), path.join(team.root || '', 'tmp')];
  const disk = (readers.disk || diskPressure)({ dirs, diskLimit: cfg.disk_percent });
  const mem = (readers.memory || readMemory)();
  const pages = (readers.swapPages || readSwapPages)();
  const samples = addSwapSample(team.s.hostPressure?.samples, pages == null ? null : [now, pages], cfg.swap_window_minutes);
  const verdict = evaluateHostPressure(cfg, { diskPercent: disk.disk?.percent ?? null, swapPercent: mem.swapPercent, swapRate: swapRate(samples, cfg.swap_window_minutes), availableMb: mem.availableMb });
  return { ...verdict, disk: disk.disk, top: disk.top?.length && verdict.reasons.some(r => r.startsWith('the root volume')) ? disk.top : [], samples };
}
