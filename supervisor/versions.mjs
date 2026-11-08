// Issue #846: cleanup of side-by-side supervisor installs. Each install lives in versions/<40-hex sha>; `current` is a link to one of
// them. A directory is removed only when nothing names it: not the current version, not the rollback target (the last good version),
// not a pending install, not a dashboard server, and not any job that could still run (running, queued or paused). A blocked job is terminal: recovery queues it again and a new worker stamps the then-current version.
// Pure file operations, no model call. Anything unexpected keeps the directory.
import fs from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
const FRESH_MS = 10 * 60 * 1000;   // a directory touched in the last ten minutes may be an install in progress: never removed
// Job states that can still run code from the version they started on. completed, failed, stopped and blocked never resume by
// themselves (a blocked job is recovered by queueing it again, and its next worker stamps the version it then runs on).
export const LIVE_JOB_STATES = new Set(['queued', 'running', 'paused_limit', 'paused_manual']);

// The versions the job records name. `unknown` counts running jobs with no recorded version (started before this rule existed, or not
// yet stamped): the caller must not remove anything while one exists. A queued or paused job with no version has no worker yet; its
// next worker stamps the version it starts on, so it holds nothing.
export function jobVersions(root) {
  const dir = path.join(root, 'jobs'); const versions = new Set(); let unknown = 0;
  let names = []; try { names = fs.readdirSync(dir); } catch { return { versions, unknown }; }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let j; try { j = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { unknown++; continue; }   // unreadable: assume it references something
    if (!LIVE_JOB_STATES.has(j.status)) continue;
    if (typeof j.supervisorVersion === 'string' && SHA.test(j.supervisorVersion)) versions.add(j.supervisorVersion);
    else if (j.supervisorVersion !== 'source' && j.status === 'running') unknown++;   // 'source' = ran from a checkout, no install directory involved
  }
  return { versions, unknown };
}

// keep: shas that must stay. Returns { removed, kept, skipped } and never throws for a directory it cannot remove.
export function pruneVersions({ root, keep, now = Date.now(), remove = (d) => fs.rmSync(d, { recursive: true, force: true }) }) {
  const base = path.join(root, 'versions');
  let entries; try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { return { removed: [], kept: [], skipped: 'no versions directory' }; }
  const removed = [], kept = [];
  for (const e of entries) {
    if (!SHA.test(e.name)) continue;   // anything else in the directory is not ours
    const dir = path.join(base, e.name);
    if (keep.has(e.name) || !e.isDirectory()) { kept.push(e.name); continue; }   // a symlink or file is never followed or removed
    let fresh = false; try { fresh = now - fs.statSync(dir).mtimeMs < FRESH_MS; } catch { fresh = true; }
    if (fresh) { kept.push(e.name); continue; }
    try { remove(dir); removed.push(e.name); } catch { kept.push(e.name); }
  }
  return { removed, kept };
}
