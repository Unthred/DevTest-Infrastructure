// Issue #406: start work on events, not only on the five-minute schedule. A finished job, a finished install, a new inbox proposal and a
// homeowner Approve or Reject each ask for one extra reconcile pass instead of leaving the free agent (or the new card) waiting for the
// next scheduled fire. Model-free: a request only records a flag and spawns this program. The schedule stays as the safety net.
//
// One writer model, no waiters. Every pass (scheduled or woken) holds `team/wake-pass.lock` from start to end, upgrade step included.
//   request  -> set the "requested" flag (merged: any number of requests are one flag), then spawn a runner.
//   runner   -> take the pass lock. If it is held, do nothing: the holder re-checks the flag after it releases the lock, so the request
//               cannot be lost however long the pass runs. If it is free, consume the flag, run the pass, release, then re-check the flag.
//   follow-up-> a flag found after release starts exactly one more pass, on the installed code (an install may have happened meanwhile).
// A scheduled fire that finds the lock held sets the same flag (uncounted: it replaces a fire, so it is bounded by the schedule itself).
// Event requests are counted in a rolling hour and capped; past the cap a request is dropped, the drop is recorded for the dashboard and
// the schedule is the fallback. Nothing in this file can stop a scheduled pass: every caller treats a failure here as "no wake".
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { processStart } from './core.mjs';
import { append as appendChange } from './api/eventlog.mjs';

export const TRIGGERS = ['schedule', 'job-end', 'install', 'inbox', 'approve'];
export const EVENT_TRIGGERS = ['job-end', 'install', 'inbox', 'approve'];
// Priority when several requests merge into one pass: the label recorded for it. An install pass verifies new code, so it comes first.
const PRIORITY = ['install', 'approve', 'inbox', 'job-end', 'schedule'];
export const WAKE_MAX_PER_HOUR = 40;
// A pass lock held this long is treated as a hung pass: a scheduled run then goes ahead without it (the tick lock and the install lock
// still serialise the parts that must not overlap), so a hung wake pass can never stop the schedule.
export const PASS_STALE_MS = 45 * 60 * 1000;
const HOUR = 3600 * 1000;
const NAMES = new Set(TRIGGERS);

const wakeFile = root => path.join(root, 'team', 'wake.json');
const clean = list => (Array.isArray(list) ? list.filter(Number.isFinite) : []);
export function readWake(root) {
  try {
    const s = JSON.parse(fs.readFileSync(wakeFile(root), 'utf8'));
    const reasons = Array.isArray(s.requested?.reasons) ? s.requested.reasons.filter(r => NAMES.has(r)) : [];
    return { requested: reasons.length ? { reasons, at: Number.isFinite(s.requested.at) ? s.requested.at : 0 } : null, accepted: clean(s.accepted), capped: clean(s.capped) };
  } catch { return { requested: null, accepted: [], capped: [] }; }
}
function writeWake(root, s) {
  fs.mkdirSync(path.dirname(wakeFile(root)), { recursive: true, mode: 0o700 });
  const tmp = `${wakeFile(root)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 }); fs.renameSync(tmp, wakeFile(root));
}

const ownerOf = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8')); } catch { return null; } };
const live = o => !!o && Number.isFinite(o.pid) && processStart(o.pid) === o.start;
// Release removes the lock only while it is still this process's own: after a takeover mishap the directory may belong to someone else.
function releaseOwned(dir) {
  const o = ownerOf(dir);
  if (o && o.pid === process.pid && o.start === processStart(process.pid)) fs.rmSync(dir, { recursive: true, force: true });
}
// Private `.stale-*` directories left by a failed restore are removed once their owner is gone.
function sweepAside(dir) {
  const base = path.basename(dir) + '.stale-', parent = path.dirname(dir);
  let names; try { names = fs.readdirSync(parent).filter(n => n.startsWith(base)); } catch { return; }
  for (const n of names) { const d = path.join(parent, n); if (!live(ownerOf(d))) fs.rmSync(d, { recursive: true, force: true }); }
}
// A directory lock owned by this process, stale when the owner is gone. The directory appears with its owner file already inside (built
// under a private name and renamed into place), so a contender never sees a lock without an owner and mistakes it for a stale one
// (reviewed on PR #525). Returns a release function, or null while another live process holds it.
export function dirLock(root, name, now = Date.now()) {
  const dir = path.join(root, 'team', name);
  fs.mkdirSync(path.dirname(dir), { recursive: true, mode: 0o700 });
  sweepAside(dir);
  for (let attempt = 0; attempt < 3; attempt++) {
    const mine = `${dir}.new-${process.pid}-${attempt}`;
    fs.rmSync(mine, { recursive: true, force: true });
    fs.mkdirSync(mine, { mode: 0o700 });
    fs.writeFileSync(path.join(mine, 'owner.json'), JSON.stringify({ pid: process.pid, start: processStart(process.pid), at: now }), { mode: 0o600 });
    try { fs.renameSync(mine, dir); return () => releaseOwned(dir); }
    catch (error) {
      fs.rmSync(mine, { recursive: true, force: true });
      if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    }
    const owner = ownerOf(dir);
    if (live(owner)) return null;
    // Take over a dead holder's lock: move it aside first, and put it back if what we moved turns out to be someone's fresh lock.
    const aside = `${dir}.stale-${process.pid}-${attempt}`;
    try { fs.renameSync(dir, aside); } catch { continue; }
    const moved = ownerOf(aside);
    // If the way back is taken meanwhile (a third contender filled the slot), the moved directory still belongs to a live owner: it is never
    // deleted here (issue #711). It stays under its private name, and the next contender's sweep removes it once its owner is gone.
    if (live(moved)) { try { fs.renameSync(aside, dir); } catch { /* left in place, see above */ } return null; }
    fs.rmSync(aside, { recursive: true, force: true });
  }
  return null;
}
// The pass lock plus how old it is, for the scheduled run's hung-pass bypass.
export const wakePassLock = (root, now) => dirLock(root, 'wake-pass.lock', now);
export function passLockAge(root, now = Date.now()) {
  const o = ownerOf(path.join(root, 'team', 'wake-pass.lock'));
  return live(o) && Number.isFinite(o.at) ? now - o.at : 0;
}
// The read-modify-write of wake.json runs under a short lock, so two requesters cannot both read the same count.
function withFileLock(root, fn) {
  let release = null;
  for (let i = 0; i < 300 && !(release = dirLock(root, 'wake-file.lock')); i++) { const end = Date.now() + 10; while (Date.now() < end) { /* brief spin */ } }
  if (!release) throw new Error('wake state is locked');
  try { return fn(); } finally { release(); }
}

export const mergeReasons = (a, b) => [...new Set([...(a || []), ...(b || [])])];
export const labelOf = reasons => PRIORITY.find(r => (reasons || []).includes(r)) || 'schedule';

// An event asks for a pass. Counted and capped. `spawnPass(reason)` starts a detached runner; its failure never propagates (the flag stays
// set, so the next scheduled pass, or the holder of a running pass, still runs it).
export function requestWake({ root, reason, now = Date.now(), cap = WAKE_MAX_PER_HOUR, spawnPass }) {
  if (!EVENT_TRIGGERS.includes(reason)) throw new Error('unknown wake reason');
  const outcome = withFileLock(root, () => {
    const s = readWake(root), accepted = s.accepted.filter(t => now - t < HOUR), capped = s.capped.filter(t => now - t < HOUR);
    if (accepted.length >= cap) { writeWake(root, { requested: s.requested, accepted, capped: [...capped, now] }); return { requested: false, capped: true, why: 'wake cap reached; the scheduled pass is the fallback' }; }
    writeWake(root, { requested: { reasons: mergeReasons(s.requested?.reasons, [reason]), at: s.requested?.at || now }, accepted: [...accepted, now], capped });
    return { requested: true, reason };
  });
  if (outcome.requested) { try { spawnPass(reason); } catch { /* the flag is set; the next pass runs it */ } }
  return outcome;
}
// A scheduled fire that found a pass running: not counted (it replaces a fire).
export function queueScheduled({ root }) {
  return withFileLock(root, () => { const s = readWake(root); writeWake(root, { ...s, requested: { reasons: mergeReasons(s.requested?.reasons, ['schedule']), at: s.requested?.at || Date.now() } }); return { queued: true }; });
}
// The pass takes the request flag as it starts (so a request during the pass sets it again). Returns the merged reasons, or [].
export function takeRequest(root) {
  return withFileLock(root, () => { const s = readWake(root); if (!s.requested) return []; writeWake(root, { ...s, requested: null }); return s.requested.reasons; });
}
export const pendingRequest = root => readWake(root).requested;

// What the dashboard and the idle report show: the rolling-hour count, the cap and whether it was hit.
export function wakeStatus(root, now = Date.now(), cap = WAKE_MAX_PER_HOUR) {
  const s = readWake(root), accepted = s.accepted.filter(t => now - t < HOUR).length, capped = s.capped.filter(t => now - t < HOUR);
  return { cap, acceptedLastHour: accepted, droppedLastHour: capped.length, capHit: capped.length > 0, lastDropAt: capped.length ? Math.max(...capped) : null };
}

// The program every wake runs: the installed code, never the code of the process that asks (a worker started before an install ends after
// it, and a pass that just installed is old code). Only when no installed copy exists (an unversioned checkout) does it fall back to `self`.
export function wakeTarget({ root, self }) {
  const installed = path.join(root, 'current', 'supervisor', 'cli.mjs');
  return fs.existsSync(installed) ? installed : self;
}
// The command line of a pass. A registry is passed on only when the operator gave one: a default is resolved by the code that runs, so a
// pass handed to a newer install loads that install's provider manifests, not the old version's (reviewed on PR #525).
export const wakeArgs = ({ target, reason, root, registry }) => [target, 'reconcile', '--wake', reason, '--state-root', root, ...(registry ? ['--registry', registry] : [])];
export const workerArgs = ({ self, id, root, registry, defaultRegistry }) => [self, 'worker', id, '--state-root', root, ...(path.resolve(registry) === path.resolve(defaultRegistry) ? [] : ['--registry', registry])];

// Start one detached pass runner on the installed code. Used by the supervisor CLI and by the dashboard server (which has no listening
// port of its own to add: the wake is a local process start).
// The environment of a woken pass: the requester's, with HOME and PATH made safe when the requester (a dashboard started by hand) lacks them,
// as the gated cron script pins them (issue #40). Nothing else is added.
export function wakeEnv(root, env = process.env) {
  return { ...env, HOME: env.HOME || '/root', PATH: env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', AI_SUPERVISOR_STATE_ROOT: root };
}
// One line per woken pass in team/wake-passes.log (kept to the last 200 lines). Never the reconcile.log, which has a fixed format. Best effort.
export function recordWakePass(root, entry) {
  try {
    const file = path.join(root, 'team', 'wake-passes.log');
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    // An O_APPEND write of one short line is atomic, so two passes ending together cannot lose a line (review of PR #797; a lock was tried
    // and rejected: the directory lock can stay held by a live process after a contended release). The file is trimmed to the last 200
    // lines only when it has grown well past that, so a trim racing an append can lose at most a line, rarely. Best effort.
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    if (fs.statSync(file).size > 200 * 400) {
      const tmp = `${file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-200).join('\n') + '\n', { mode: 0o600 }); fs.renameSync(tmp, file);
    }
  } catch { /* a log failure never stops a pass */ }
}
export function spawnDetachedPass({ root, reason, self, registry = null, spawnFn = spawn }) {
  const child = spawnFn(process.execPath, wakeArgs({ target: wakeTarget({ root, self }), reason, root, registry }), { detached: true, stdio: 'ignore', env: wakeEnv(root) });
  child.on?.('error', () => {}); child.unref?.();
}
// Issue #985: start an approved prompt now, in its own small process, whatever a running pass is doing. The process takes inbox-lane.lock (one
// at a time; a second finds it held and ends: the holder reads the same approved items), runs `team start-approved` on the installed code and
// ends. Failure to start it is no failure: the woken pass starts the prompt the normal way.
export const laneArgs = ({ target, root, registry }) => [target, 'team', 'start-approved', '--state-root', root, ...(registry ? ['--registry', registry] : [])];
export function spawnDetachedLane({ root, self, registry = null, spawnFn = spawn }) {
  const child = spawnFn(process.execPath, laneArgs({ target: wakeTarget({ root, self }), root, registry }), { detached: true, stdio: 'ignore', env: wakeEnv(root) });
  child.on?.('error', () => {}); child.unref?.();
}
// A new overseer proposal arrives as a file in <inbox>/items/ (the existing write route, foreman-mcp/inbox.mjs). The dashboard server, which
// already reads the inbox, looks at the folder's file names every few seconds (one directory listing, no reads of file content) and calls
// `onNew` when a name appears that it has not seen. Names present when the watcher starts are not new: the schedule picks those up.
export function inboxWatcher({ dir, onNew, intervalMs = 5000, list = d => fs.readdirSync(d), setTimer = setInterval, clearTimer = clearInterval }) {
  let seen = null;
  const poll = () => {
    let names; try { names = list(path.join(dir, 'items')).filter(n => n.endsWith('.json')); } catch { return; }
    if (seen === null) { seen = new Set(names); return; }
    const fresh = names.filter(n => !seen.has(n));
    for (const n of names) seen.add(n);
    if (fresh.length) { try { onNew(fresh.length); } catch { /* the schedule is the fallback */ } }
  };
  poll();
  const timer = setTimer(poll, intervalMs); timer.unref?.();
  return { poll, stop: () => clearTimer(timer) };
}

// Issue #985: what the dashboard and foreman_status show about wakes: the rolling-hour use against the cap, the requests waiting for the
// running pass (reasons and how long they have waited) and how long the running pass has held the lock. Local files only.
export function wakeView(root, now = Date.now(), cap = WAKE_MAX_PER_HOUR) {
  const st = wakeStatus(root, now, cap), req = readWake(root).requested;
  return { ...st, pending: req ? { reasons: req.reasons, since: req.at || null, ageSeconds: req.at ? Math.max(0, Math.round((now - req.at) / 1000)) : null } : null, passRunningSeconds: Math.round(passLockAge(root, now) / 1000) || null };
}

// Issue #985: a new proposal is validated (waiting -> pending) at once, by whoever sees it first, even while a pass runs: the scan only
// writes inbox status files, never Foreman's team state. A small lock keeps two scanners (the dashboard's watcher and the pass) from
// writing the same status; a scanner that finds it held does nothing, because the holder is already scanning the same folder.
export function scanInboxNow({ root, inboxDir, scan, maxPending, now = Date.now(), log = line => console.error(line) }) {
  let release; try { release = dirLock(root, 'inbox-scan.lock', now); } catch { release = null; }
  if (!release) return { scanned: false };
  try {
    const result = scan(inboxDir, now, { maxPending });
    announcePickup(root, result.picked, log);
    return { scanned: true, ...result };
  } finally { release(); }
}

// Issue #1286: the models that show Inbox items. A pickup (a refused item too, it is in the Inbox model) is announced on the change stream
// at once, one event per scan pass, so a screen does not wait for the next tick. A failure to append is logged once; the tick's own event is the fallback.
export const INBOX_MODELS = ['inbox', 'overview', 'appbar'];
function announcePickup(root, picked, log) {
  if (!(picked > 0)) return;
  try { appendChange(root, { type: 'model_changed', models: INBOX_MODELS }); } catch (error) {
    try { log(`ai-supervisor: inbox pickup not announced on the change stream: ${error?.message || error}`); } catch { /* logging is best effort */ }
  }
}

// Issue #1115: true when the scan ran and nothing in it needs a pass. A control item has no click to wake one, so it asks for the pass itself.
export function inboxScanDone(root, config, scan) {
  const r = scanInboxNow({ root, inboxDir: config.inbox.dir, scan, maxPending: config.inbox.max_pending });
  return r.scanned && !r.controls;
}
