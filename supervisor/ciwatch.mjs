// Issue #1411: a pull request waiting for its CI run is watched, and Foreman wakes the moment the run finishes. Tower accepts no inbound
// connections, so this is the only way to learn of a finished run before the next scheduled pass.
// The watcher decides nothing and starts no job: it polls one head with one GitHub read and, when no check is pending any more, asks for
// a wake with the reason `ci` (supervisor/wake.mjs). The normal pass then reads GitHub and plans. The scheduled pass stays the fallback.
// One record per watched head (team/ci-watch/<pr>-<sha>.json, holding the process like the pass lock does) keeps a later tick from
// watching the same head twice and caps the number of watchers.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { processStart } from './core.mjs';
import { checksState } from './checkstate.mjs';
import { wakeEnv } from './wake.mjs';

export const POLL_MS = 20 * 1000;
export const MAX_WATCH_MS = 45 * 60 * 1000;
export const MAX_WATCHERS = 6;

const dirOf = root => path.join(root, 'team', 'ci-watch');
const recordFile = (root, pr, sha) => path.join(dirOf(root), `${Number(pr)}-${String(sha).replace(/[^0-9a-f]/gi, '')}.json`);
const readRecord = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// A record whose start is null was written for a process that had already gone: treated as dead, never as a live watcher.
const alive = r => !!r && Number.isFinite(r.pid) && r.start != null && processStart(r.pid) === r.start;

// A head whose watch ran out stays marked (pr-sha.timeout) so a later tick does not watch it again; a head stuck pending for good would
// otherwise be re-watched every 45 minutes without end. The scheduled pass covers it. The marker is dropped after a day.
export const TIMEOUT_MARK_MS = 24 * 60 * 60 * 1000;
const markFile = (root, pr, sha) => recordFile(root, pr, sha).replace(/\.json$/, '.timeout');
const markTimeout = (root, pr, sha) => {
  try {
    fs.mkdirSync(dirOf(root), { recursive: true, mode: 0o700 });
    fs.writeFileSync(markFile(root, pr, sha), String(Date.now()), { mode: 0o600 });
  } catch { /* the watch simply may restart */ }
};
function timedOut(root, pr, sha) {
  const file = markFile(root, pr, sha);
  try {
    if (Date.now() - fs.statSync(file).mtimeMs < TIMEOUT_MARK_MS) return true;
    fs.rmSync(file, { force: true });
  } catch { /* no marker */ }
  return false;
}

// Live watcher records; the record of a dead watcher is removed as it is found.
function liveRecords(root) {
  let names; try { names = fs.readdirSync(dirOf(root)).filter(n => n.endsWith('.json')); } catch { return new Map(); }
  const live = new Map();
  for (const n of names) {
    const file = path.join(dirOf(root), n), r = readRecord(file);
    if (alive(r)) live.set(n, r); else fs.rmSync(file, { force: true });
  }
  return live;
}
const writeRecord = (root, pr, sha, pid) => {
  fs.mkdirSync(dirOf(root), { recursive: true, mode: 0o700 });
  fs.writeFileSync(recordFile(root, pr, sha), JSON.stringify({ pr, sha, pid, start: processStart(pid), at: Date.now() }), { mode: 0o600 });
};

// Pure: the heads worth a watcher, a non-draft pull request whose checks are still running.
export const pendingHeads = pulls => (pulls || [])
  .filter(p => p && !p.isDraft && /^[0-9a-f]{7,64}$/i.test(String(p.headRefOid || '')) && checksState(p.statusCheckRollup) === 'pending')
  .map(p => ({ pr: p.number, sha: p.headRefOid }));

export function spawnWatcher({ root, pr, sha, spawnFn = spawn }) {
  // The installed code when there is one (a watcher started before an install ends after it), else this checkout.
  const installed = path.join(root, 'current', 'supervisor', 'ciwatch-main.mjs');
  const target = fs.existsSync(installed) ? installed : fileURLToPath(new URL('./ciwatch-main.mjs', import.meta.url));
  const child = spawnFn(process.execPath, [target, String(pr), sha, '--state-root', root], { detached: true, stdio: 'ignore', env: wakeEnv(root) });
  child.on?.('error', () => {}); child.unref?.();
  return child;
}

// Called by the tick. One watcher per head, at most MAX_WATCHERS at once; a head that cannot be watched is left to the scheduled pass.
export function startCiWatchers({ root, pulls, start, max = MAX_WATCHERS }) {
  const out = { started: [], already: [], unwatched: [] };
  const live = liveRecords(root);
  for (const h of pendingHeads(pulls)) {
    if (live.has(path.basename(recordFile(root, h.pr, h.sha)))) { out.already.push(h.pr); continue; }
    if (timedOut(root, h.pr, h.sha)) { out.unwatched.push(h.pr); continue; }
    if (live.size >= max) { out.unwatched.push(h.pr); continue; }
    try {
      const child = start(h);
      if (!Number.isFinite(child?.pid)) throw new Error('no process');
      writeRecord(root, h.pr, h.sha, child.pid);
      live.set(path.basename(recordFile(root, h.pr, h.sha)), child);
      out.started.push(h.pr);
    } catch { out.unwatched.push(h.pr); }
  }
  return out;
}

// GitHub reads made by watchers: one line appended per read (an O_APPEND write is atomic), consumed by the next tick into its call count.
const readsFile = root => path.join(root, 'team', 'ci-watch-reads.log');
export function noteRead(root) { try { fs.mkdirSync(path.dirname(readsFile(root)), { recursive: true, mode: 0o700 }); fs.appendFileSync(readsFile(root), '1\n', { mode: 0o600 }); } catch { /* a count lost */ } }
export function takeReads(root) {
  const taken = `${readsFile(root)}.take-${process.pid}`;
  try { fs.renameSync(readsFile(root), taken); } catch { return 0; }
  try { return fs.readFileSync(taken, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } finally { fs.rmSync(taken, { force: true }); }
}

// The watcher loop. `readHead()` returns { state, headRefOid, statusCheckRollup }; `wake()` asks for the pass. Never throws: a failed read
// is retried at the next interval. Returns why it ended: finished (a wake was requested), changed, closed or timeout (no wake).
export async function runWatch({ root, pr, sha, readHead, wake, now = Date.now, sleep, pollMs = POLL_MS, maxMs = MAX_WATCH_MS }) {
  const began = now();
  const file = recordFile(root, pr, sha);
  try {
    for (;;) {
      let head = null;
      try { head = await readHead(); } catch { head = null; } finally { noteRead(root); }
      if (head) {
        if (head.state && head.state !== 'OPEN') return 'closed';
        if (head.headRefOid && head.headRefOid !== sha) return 'changed';
        const state = checksState(head.statusCheckRollup);
        if (state !== 'pending' && state !== 'none') { try { wake(); } catch { /* the schedule is the fallback */ } return 'finished'; }
      }
      if (now() - began + pollMs > maxMs) { markTimeout(root, pr, sha); return 'timeout'; }
      await sleep(pollMs);
    }
  } finally { fs.rmSync(file, { force: true }); }
}

