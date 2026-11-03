// Allowance probe (issue #110). Foreman learns a provider's allowance from its own output; an agent held in reviews_only or
// waiting runs no job, so its reading would never refresh and a plan upgrade or an early reset stayed invisible.
//
// A probe is a minimal, tool-free run of the provider CLI, taken from the provider manifest's `probe` section (D-012: no
// provider name in core), started outside any repository, whose only purpose is the allowance record in its output. The
// message text is never read into a stored value: only the adapter's allowance record is kept, tagged `source: 'probe'`.
// A manifest probe of kind `session-log` is the model-free local read (Codex). Nothing here buys credits: a reading that
// shows overage in use or an exhausted window simply keeps the agent held (budget.mjs).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { sessionLogAllowanceProbe, hasReading } from './allowance.mjs';
import { provider, safeEnvironment } from './core.mjs';

export const MINUTE = 60000, HOUR = 3600000;
export const RESET_GRACE_MS = MINUTE;          // "just after a reported reset time passes"
const MAX_LINE = 65536, MAX_OUTPUT = 4 * 1024 * 1024;

// Could a model run now draw on paid overage? True while the newest reading shows overage in use for a window that has not
// reset, or a window that has not reset is used up, or a used-up top-level status has no window reset time, and overage is not explicitly refused.
// No reading at all is not a risk: the probe is how a first reading arrives. Pure.
const USED_UP = ['rejected', 'blocked', 'exhausted', 'limit_reached'], REFUSED = ['rejected', 'disabled'];
const liveWindows = (allowance, now) => (allowance?.windows || []).filter(w => Number.isFinite(w?.resetsAt) && w.resetsAt > now);
// Is a window that has not reset yet used up (utilization at exhausted_at, or a rejected/blocked status)? Pure.
export function usedUpWindow(allowance, now, exhaustedAt = 0.995) {
  return liveWindows(allowance, now).some(w => (Number.isFinite(w.utilization) && w.utilization >= exhaustedAt) || USED_UP.includes(w.status));
}
export function overageRisk(allowance, now, exhaustedAt = 0.995) {
  if (allowance?.billing?.usingOverage === true && liveWindows(allowance, now).length) return true;
  if (REFUSED.includes(allowance?.billing?.overageStatus)) return false;
  // A top-level used-up status with no window reset time cannot be shown to have reset: treat it as live while overage is not refused.
  const timed = (allowance?.windows || []).some(w => Number.isFinite(w?.resetsAt));
  if (!timed && USED_UP.includes(allowance?.status)) return true;
  return usedUpWindow(allowance, now, exhaustedAt);
}

// The kind of the provider's manifest probe ('command', 'session-log') or null.
export function probeKind(registry, providerId) {
  try {
    const entry = JSON.parse(fs.readFileSync(registry, 'utf8')).providers?.[providerId];
    if (!entry || typeof entry.manifest !== 'string' || entry.manifest.includes('..')) return null;
    return JSON.parse(fs.readFileSync(path.join(path.dirname(registry), entry.manifest), 'utf8')).probe?.kind || null;
  } catch { return null; }
}

// Whether a probe is due for one agent. Pure. Never while `normal` (jobs already refresh the reading), except the single
// probe after a held agent's reported reset time has passed. At most one attempt per interval, successful or not.
// D-019 (no provider call while waiting): never while a window that has not reset is used up, whatever the overage status,
// and never while a job of the provider is in the usage-limit wait. The reset probe comes once the window has reset.
//   mode: the computed mode now. stored: the mode the dispatcher recorded. allowance: newest reading of the provider.
//   state: { at, resetFor } of the last attempt for this agent. limitWait: a job of this provider waits on a usage limit.
export function probeDue({ mode, stored = null, allowance = null, state = null, settings, now, limitWait = false }) {
  if (settings.probe === false || limitWait) return null;
  if (state?.at && now - state.at < settings.probe_interval_minutes * MINUTE) return null;
  // Overage in use could draw on credits; a live used-up window means the provider is out until it resets. Never.
  if (overageRisk(allowance, now, settings.exhausted_at) || usedUpWindow(allowance, now, settings.exhausted_at)) return null;
  if (mode !== 'normal') {
    const age = Number.isFinite(allowance?.observedAt) && allowance.observedAt > 0 ? now - allowance.observedAt : Infinity;
    if (age >= settings.probe_age_hours * HOUR) return { reason: 'stale', resetFor: null };
  }
  if (stored && stored.mode !== 'normal' && Number.isFinite(stored.until) && stored.until + RESET_GRACE_MS <= now && state?.resetFor !== stored.until
    && !(Number.isFinite(allowance?.observedAt) && allowance.observedAt >= stored.until)) return { reason: 'reset', resetFor: stored.until };
  return null;
}

// Reduce a provider-observed record to allowance fields only (no free text, no ids) and tag it.
export function cleanProbeRecord(a, now) {
  if (!hasReading(a)) return null;
  const str = (v, n) => String(v ?? 'unknown').replace(/[^A-Za-z0-9_ .:-]/g, '').slice(0, n);
  const num = v => (Number.isFinite(v) ? v : null);
  return { provider: str(a.provider, 32), status: str(a.status, 32), observedAt: now, source: 'probe',
    windows: a.windows.slice(0, 8).map(w => ({ type: str(w.type, 24), windowMinutes: num(w.windowMinutes), utilization: num(w.utilization), resetsAt: num(w.resetsAt), status: str(w.status, 32) })),
    billing: { overageStatus: str(a.billing?.overageStatus, 32), usingOverage: a.billing?.usingOverage === true, creditsAvailable: a.billing?.creditsAvailable === true } };
}

// Run the manifest's probe command in an empty temporary directory and return the last allowance record the adapter saw,
// or null. spawnFn is injectable for tests. Output is read line by line and dropped; only adapter.observe(line).allowance survives.
export function runProbeCommand({ spec, adapter, config, now = Date.now(), spawnFn = spawn, env = process.env }) {
  return new Promise(resolve => {
    let dir; try { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreman-probe-')); } catch { resolve(null); return; }
    let child, allowance = null, done = false, timer = null;
    const finish = value => {
      if (done) return; done = true; clearTimeout(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* a leftover empty directory in tmp is harmless */ }
      resolve(value);
    };
    try { child = spawnFn(spec.command, spec.args || [], { cwd: dir, env: safeEnvironment(env, config.manifest.launch.env_allowlist || []), stdio: ['ignore', 'pipe', 'ignore'], detached: true }); }
    catch { finish(null); return; }
    const kill = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } } };
    timer = setTimeout(() => { kill(); finish(null); }, (spec.timeout_seconds ?? 90) * 1000);
    const decoder = new StringDecoder('utf8');
    let buffer = '', total = 0, discarding = false;
    const line = raw => {
      let seen; try { seen = adapter.observe(raw); } catch { return; }
      if (seen?.allowance) allowance = seen.allowance;
    };
    child.stdout.on('data', chunk => {
      total += chunk.length; if (total > MAX_OUTPUT) { kill(); return; }
      buffer += decoder.write(chunk);
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) { const raw = buffer.slice(0, nl); buffer = buffer.slice(nl + 1); if (!discarding && raw.length <= MAX_LINE) line(raw); discarding = false; }
      if (buffer.length > MAX_LINE) { buffer = ''; discarding = true; }
    });
    child.on('error', () => finish(null));
    child.on('close', () => { if (buffer && !discarding && buffer.length <= MAX_LINE) line(buffer); finish(cleanProbeRecord(allowance, now)); });
  });
}

// One probe of one provider through its manifest. Returns { record } or { record: null, error }.
export async function probeProvider(registry, providerId, { now = Date.now(), spawnFn = spawn, env = process.env, home = undefined } = {}) {
  const { config, adapter } = await provider(registry, providerId);
  const spec = config.manifest.probe;
  if (!spec) return { record: null, error: 'unsupported' };
  if (spec.kind === 'session-log') {
    const r = sessionLogAllowanceProbe({ now, ...(home ? { home } : {}) });
    return r ? { record: { ...r, source: 'session-log' } } : { record: null, error: 'no-reading' };
  }
  const record = await runProbeCommand({ spec, adapter, config, now, spawnFn, env });
  return record ? { record } : { record: null, error: 'no-reading' };
}

// Synchronous: does this provider's manifest declare a probe? (the dashboard decides whether to show the button)
export function hasProbe(registry, providerId) {
  try {
    const entry = JSON.parse(fs.readFileSync(registry, 'utf8')).providers?.[providerId];
    if (!entry || typeof entry.manifest !== 'string' || entry.manifest.includes('..')) return false;
    return !!JSON.parse(fs.readFileSync(path.join(path.dirname(registry), entry.manifest), 'utf8')).probe;
  } catch { return false; }
}

// Probes that are running right now, so a double click or a tick plus a click never starts two runs for one provider.
const running = new Set();
export async function refreshProvider(registry, providerId, opts = {}) {
  if (running.has(providerId)) return { record: null, error: 'busy' };
  running.add(providerId);
  try { return await probeProvider(registry, providerId, opts); } finally { running.delete(providerId); }
}
