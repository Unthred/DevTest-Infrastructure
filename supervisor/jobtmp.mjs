// Issue #1007: scratch space for Foreman jobs lives on the cache drive, not in the RAM-backed root volume.
// Every job gets its own folder under <state root>/tmp (TMPDIR and CLAUDE_CODE_TMPDIR point at it), made when the job starts and
// removed when it ends, whatever the outcome. A tick sweeps what a crash left behind, and a host check holds new starts when the
// root volume or swap is nearly full.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SWEEP_AGE_MS = 6 * 3600000;
export const DISK_HOLD_PERCENT = 80;
export const jobTmpRoot = root => path.join(root, 'tmp');
export const jobTmpName = id => `job-${String(id).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64)}`;

// Creates the job's folder (and its parent) and returns its path, or null when it cannot be made (the job then keeps the inherited TMPDIR).
export function makeJobTmp(root, id) {
  try {
    const base = jobTmpRoot(root); fs.mkdirSync(base, { recursive: true, mode: 0o700 });
    const dir = path.join(base, jobTmpName(id)); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch { return null; }
}
export function removeJobTmp(dir) {
  if (!dir) return false;
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); return true; } catch { return false; }
}
export const tmpEnv = dir => (dir ? { TMPDIR: dir, CLAUDE_CODE_TMPDIR: dir } : {});

function sizeOf(p, depth = 0) {
  let st; try { st = fs.lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.blocks ? st.blocks * 512 : st.size;
  if (depth > 40) return 0;
  let n = 0; try { for (const e of fs.readdirSync(p)) n += sizeOf(path.join(p, e), depth + 1); } catch { /* unreadable */ }
  return n;
}

// Removes folders under <root>/tmp older than ageMs whose job is not active. `ownedIds` are the active job ids. Returns { removed, bytes }.
export function sweepJobTmp(root, { ownedIds = [], ageMs = SWEEP_AGE_MS, now = Date.now(), logFile } = {}) {
  const base = jobTmpRoot(root), out = { removed: [], bytes: 0 };
  let names; try { names = fs.readdirSync(base); } catch { return out; }
  const owned = new Set(ownedIds.map(jobTmpName));
  for (const name of names) {
    if (owned.has(name)) continue;
    const p = path.join(base, name);
    let st; try { st = fs.lstatSync(p); } catch { continue; }
    if (!(now - st.mtimeMs > ageMs)) continue;
    const bytes = sizeOf(p);
    if (removeJobTmp(p) && !fs.existsSync(p)) { out.removed.push(name); out.bytes += bytes; }
  }
  if (out.removed.length && logFile) { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, JSON.stringify({ at: new Date(now).toISOString(), removed: out.removed.length, freedBytes: out.bytes }) + '\n'); } catch { /* the report carries it */ } }
  return out;
}

export function readSwap(meminfo = '/proc/meminfo') {
  try {
    const t = fs.readFileSync(meminfo, 'utf8'), n = k => Number((new RegExp(`^${k}:\\s+(\\d+)`, 'm').exec(t) || [])[1]);
    const total = n('SwapTotal'), free = n('SwapFree');
    return total > 0 && Number.isFinite(free) ? { percent: Math.round(((total - free) / total) * 100), usedKb: total - free } : null;
  } catch { return null; }
}
export function readDisk(dir = '/') {
  try { const s = fs.statfsSync(dir); const total = s.blocks * s.bsize, free = s.bavail * s.bsize; return total > 0 ? { percent: Math.round(((total - free) / total) * 100), freeBytes: free } : null; } catch { return null; }
}
// The biggest entries in /tmp and the job folders, for the Inbox item. Bounded and read-only.
export function topConsumers(dirs, n = 5) {
  const rows = [];
  for (const d of dirs) { let names = []; try { names = fs.readdirSync(d); } catch { continue; } for (const name of names.slice(0, 400)) rows.push({ path: path.join(d, name), bytes: sizeOf(path.join(d, name)) }); }
  return rows.sort((a, b) => b.bytes - a.bytes).slice(0, n);
}
// { hold, reasons, disk, swap, top } — hold when the root volume is over 80%. Swap used never holds (issue #1151): memory pressure is
// judged by hostpressure.mjs from swap activity and available memory. Readers are injectable for tests.
export function hostPressure({ disk = readDisk(), swap = readSwap(), dirs = [os.tmpdir()], diskLimit = DISK_HOLD_PERCENT } = {}) {
  const reasons = [];
  if (disk && disk.percent > diskLimit) reasons.push(`the root volume is ${disk.percent}% full`);
  return { hold: reasons.length > 0, reasons, disk, swap, top: reasons.length ? topConsumers(dirs) : [] };
}
export const pressureText = p => `${p.reasons.join(' and ')}; new job starts are held until it recovers (under ${DISK_HOLD_PERCENT}% disk).${p.top.length ? ` Largest: ${p.top.map(t => `${t.path} ${(t.bytes / 1048576).toFixed(0)} MB`).join('; ')}.` : ''}`;

// Leak guard (issue #1007): a fresh TMPDIR inside the inherited one for a test run. finish() removes it and returns what the run left behind.
export function guardTmp(env = process.env, base = env.TMPDIR || os.tmpdir()) {
  let dir; try { dir = fs.mkdtempSync(path.join(base, 'test-guard-')); fs.chmodSync(dir, 0o755); } catch { return { env, finish: () => [] }; }
  return { env: { ...env, TMPDIR: dir }, dir, finish() { let left = []; try { left = fs.readdirSync(dir).sort(); } catch { /* gone */ } removeJobTmp(dir); return left; } };
}
export const leakText = left => `the test run left ${left.length} item(s) in its TMPDIR: ${left.slice(0, 20).join(', ')}`;
