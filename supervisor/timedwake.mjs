// Issue #1408: a one-off wake for every moment Foreman already knows work becomes startable, so the work starts then and not at the
// next scheduled pass. Three kinds of known time: the reset of an allowance window an agent is waiting on, the next attempt time of a
// paused or queued job, and the retry time the upgrade step holds.
//   pass end   -> recordPassEnd() works out the earliest such time and records it in team/next-startable.json (one time, or none and why).
//   long-running process (the dashboard server, which already watches the Inbox) -> createTimedWake() arms ONE timer for the recorded
//   time, replaces it when a later pass records a sooner one, clears it when none is recorded, and arms it again from state on start.
// A timer that fires asks for a wake with the reason 'known-time'; the scheduled pass stays the fallback. Nothing here can stop a pass.
import fs from 'node:fs';
import path from 'node:path';
import { latestAllowance, readJobs, readCache } from './dashdata.mjs';
import { limitFromAllowance } from './allowance.mjs';
import { MAX_ATTEMPTS, ATTEMPT_GAP_MS } from './upgrade-attempts.mjs';

export const MARGIN_MS = 5000;               // after the stated time, so the provider has moved on
export const MAX_AHEAD_MS = 24 * 3600000;    // a time further away than this is not armed; the schedule covers it
export const POLL_MS = 5000;                 // how often the long-running process looks at the recorded time
const PAUSED_OR_QUEUED = new Set(['paused_limit', 'queued']);

const recordFile = root => path.join(root, 'team', 'next-startable.json');
const future = (t, now) => Number.isFinite(t) && t > now;

// Pure: every known future time with where it came from, and the reasons a waiting thing gave no time.
export function knownTimes({ now, agents, allowances, jobs, upgrade }) {
  const times = [], notes = [];
  for (const [agent, a] of Object.entries(agents || {})) {
    const limit = limitFromAllowance(allowances?.[a.provider] || null, now);
    if (!limit) continue;
    if (future(limit.resetAt, now)) times.push({ at: limit.resetAt, source: `allowance window of ${agent}` });
    else notes.push(`${agent} waits on an allowance window but the reading has no future reset time`);
  }
  for (const j of jobs || []) {
    if (!PAUSED_OR_QUEUED.has(j?.status) || !future(j.nextAttemptAt, now)) continue;
    times.push({ at: j.nextAttemptAt, source: `job ${String(j.id).slice(0, 8)} next attempt` });
  }
  if (future(upgrade?.fetchRetryAt, now)) times.push({ at: upgrade.fetchRetryAt, source: 'upgrade fetch retry' });
  const install = upgrade?.install;
  if (install?.result === 'transient' && future(install.nextAttemptAt, now)) times.push({ at: install.nextAttemptAt, source: 'upgrade install retry' });
  const list = upgrade?.refusedAttempts?.list;
  const furtherAt = list?.length && list.length < MAX_ATTEMPTS ? list.at(-1).at + ATTEMPT_GAP_MS : null;
  if (future(furtherAt, now)) times.push({ at: furtherAt, source: 'upgrade further attempt' });
  return { times, notes };
}

// Pure: the one time to arm (the soonest, plus the margin), or null with the reason. Equal times are one time.
export function earliestStartable(input) {
  const { now } = input, { times, notes } = knownTimes(input);
  if (!times.length) return { at: null, why: notes.length ? notes.join('; ') : 'nothing waits on a known time' };
  const first = times.reduce((a, b) => (b.at < a.at ? b : a));
  const at = first.at + MARGIN_MS;
  if (at - now > MAX_AHEAD_MS) return { at: null, why: `the soonest known time (${first.source}) is more than 24 hours away` };
  return { at, source: first.source };
}

function upgradeState(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.json'), 'utf8')); } catch { return null; }
}
// The inputs of earliestStartable as the state on disk has them.
export function inputsFromState(root, config, now) {
  const agents = Object.fromEntries(Object.entries(config?.agents || {}).map(([name, x]) => [name, { provider: x.provider }]));
  const jobs = readJobs(root);
  return { now, agents, jobs, allowances: latestAllowance(jobs, readCache(root)?.probes), upgrade: upgradeState(root) };
}

export function readNextStartable(root) {
  try { const r = JSON.parse(fs.readFileSync(recordFile(root), 'utf8')); return Number.isFinite(r?.at) ? r : null; } catch { return null; }
}
// Records the time (or the lack of one and why) and returns what was recorded. A write failure is the caller's to ignore.
export function recordNextStartable(root, found, now) {
  const body = found.at === null ? { at: null, why: found.why, recordedAt: now } : { at: found.at, source: found.source, recordedAt: now };
  fs.mkdirSync(path.dirname(recordFile(root)), { recursive: true, mode: 0o700 });
  const tmp = `${recordFile(root)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 });
  fs.renameSync(tmp, recordFile(root));
  return body;
}

// The pass end step: works out and records the earliest known startable time. Logs why when nothing is armed. Never throws.
export function recordPassEnd({ root, config, now = Date.now(), log = line => console.error(line) }) {
  try {
    const found = earliestStartable(inputsFromState(root, config, now));
    recordNextStartable(root, found, now);
    if (found.at === null && found.why !== 'nothing waits on a known time') log(`ai-supervisor: no known-time wake armed: ${found.why}`);
    return found;
  } catch (error) {
    try { log(`ai-supervisor: known time not recorded: ${error?.name || 'Error'}`); } catch { /* best effort */ }
    return null;
  }
}

// The long-running side. `wake()` asks for a pass with the reason 'known-time'. Timers are injectable so a test drives a fake clock.
export function createTimedWake({ root, config, wake, now = Date.now, timers = globalThis, log = line => console.error(line) }) {
  let armedAt = null, handle = null;
  const clear = () => { if (handle !== null) timers.clearTimeout(handle); handle = null; armedAt = null; };
  function recompute() {
    const found = earliestStartable(inputsFromState(root, config(), now()));
    recordNextStartable(root, found, now());
    if (found.at === null && found.why !== 'nothing waits on a known time') log(`dashboard: no known-time wake armed: ${found.why}`);
  }
  function fire() {
    handle = null; armedAt = null;
    try { wake(); } catch { /* the schedule is the fallback */ }
    try { recompute(); } catch { /* the next pass records it */ }
    sync();
  }
  // Brings the one armed timer in line with the recorded time: none recorded clears it, a different time replaces it.
  function sync() {
    const rec = readNextStartable(root), at = rec?.at ?? null;
    if (at === null || at - now() > MAX_AHEAD_MS + MARGIN_MS) { clear(); return; }
    if (at === armedAt) return;
    clear();
    armedAt = at;
    handle = timers.setTimeout(fire, Math.max(0, at - now()));
    handle?.unref?.();
  }
  // On start the time is worked out again from state, so a restart loses nothing.
  try { recompute(); } catch (error) { log(`dashboard: known time not worked out on start: ${error?.name || 'Error'}`); }
  sync();
  const poll = timers.setInterval(() => { try { sync(); } catch { /* try again next time */ } }, POLL_MS);
  poll?.unref?.();
  return { sync, armed: () => armedAt, stop: () => { clear(); timers.clearInterval(poll); } };
}
