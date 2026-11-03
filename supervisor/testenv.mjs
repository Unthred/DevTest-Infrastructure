// Issue #469: lighter test runs. (1) A worker limit per suite: `node --test` gets `--test-concurrency=N` so one suite no longer
// runs a child process per file. (2) A configured temp root (cache drive) so test clones and temp files stay off the RAM disk.
// (3) A sweep for leftovers: only directories with the tests' own prefixes, old enough, not open and not any process's cwd.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_TEST_CONCURRENCY = 8;   // set from the measurements in docs/team-loop.md (3 Nov 2026, Tower)
export const TEST_PREFIXES = ['supervisor-regress-', 'supervisor-test-', 'supervisor-cron-', 'supervisor-cron35-', 'devtest-broker-', 'nm-', 'gatelog-', 'hr-src-', 'hr-clone-', 'foreman-448-', 'foreman-469-'];
export const DEFAULT_SWEEP_AGE_HOURS = 24;

// Adds `--test-concurrency=N` after `node --test` unless the command already sets it. Other commands pass through unchanged.
export function withTestConcurrency(cmd, n) {
  const isNodeTest = /(^|\/)node$/.test(cmd[0] || '') && cmd.includes('--test');
  if (!isNodeTest || !Number.isSafeInteger(n) || n < 1 || cmd.some(a => a.startsWith('--test-concurrency'))) return cmd;
  const i = cmd.indexOf('--test');
  return [...cmd.slice(0, i + 1), `--test-concurrency=${n}`, ...cmd.slice(i + 1)];
}

// The environment for the child: TMPDIR points at the configured root (created if missing). An unusable root is ignored, never fatal.
export function testEnv(env, tmpRoot) {
  if (!tmpRoot || !path.isAbsolute(tmpRoot)) return env;
  try { fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 }); fs.accessSync(tmpRoot, fs.constants.W_OK); } catch { return env; }
  return { ...env, TMPDIR: tmpRoot };
}

// Directories (by real path) that some process has as cwd or has open. Read from /proc; if /proc cannot be read the sweep removes nothing.
function busyPaths(procDir) {
  const busy = new Set();
  for (const pid of fs.readdirSync(procDir).filter(n => /^\d+$/.test(n))) {
    for (const link of ['cwd', 'root']) { try { busy.add(fs.readlinkSync(path.join(procDir, pid, link))); } catch { /* gone or not ours */ } }
    let fds; try { fds = fs.readdirSync(path.join(procDir, pid, 'fd')); } catch { continue; }
    for (const fd of fds) { try { busy.add(fs.readlinkSync(path.join(procDir, pid, 'fd', fd))); } catch { /* closed */ } }
  }
  return busy;
}
const inUse = (dir, busy) => { for (const b of busy) if (b === dir || b.startsWith(dir + path.sep)) return true; return false; };

// Removes leftovers under `tmpRoot`. `dryRun` reports without removing. Returns { removed, kept, skipped } and appends to `logFile`.
export function sweepTestTemp({ tmpRoot, prefixes = TEST_PREFIXES, ageHours = DEFAULT_SWEEP_AGE_HOURS, now = Date.now(), dryRun = false, logFile, procDir = '/proc' } = {}) {
  const out = { removed: [], kept: [], skipped: [] };
  if (!tmpRoot || !path.isAbsolute(tmpRoot) || !fs.existsSync(tmpRoot)) return out;
  let busy; try { busy = busyPaths(procDir); } catch (error) { out.skipped.push(`cannot read ${procDir}: ${error.code || 'error'}`); return out; }
  const cutoff = now - ageHours * 3600000;
  for (const name of fs.readdirSync(tmpRoot)) {
    if (!prefixes.some(p => name.startsWith(p))) continue;
    const full = path.join(tmpRoot, name);
    let st; try { st = fs.lstatSync(full); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) { out.kept.push({ name, why: 'not a plain directory' }); continue; }
    if (st.mtimeMs > cutoff) { out.kept.push({ name, why: 'too new' }); continue; }
    if (inUse(full, busy)) { out.kept.push({ name, why: 'in use' }); continue; }
    if (!dryRun) { try { fs.rmSync(full, { recursive: true, force: true }); } catch (error) { out.kept.push({ name, why: `remove failed: ${error.code || 'error'}` }); continue; } }
    out.removed.push(name);
  }
  if (logFile && !dryRun && out.removed.length) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.appendFileSync(logFile, JSON.stringify({ at: new Date(now).toISOString(), tmpRoot, ageHours, removed: out.removed }) + '\n');
  }
  return out;
}

// Issue #469: skip a repeat full suite only when the exact same tree already passed it. The key is the git tree hash of a clean
// checkout (a dirty tree, or no git, is never reused), the command and the node version. A pass is recorded only after a real run
// exits 0, so every tree that merges or installs has passed the full suite somewhere; a record older than `maxAgeHours` is ignored.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
export const DEFAULT_REUSE_HOURS = 24;
export function suiteKey(cwd, cmd) {
  const isNodeTest = /(^|\/)node$/.test(cmd[0] || '') && cmd.includes('--test');
  if (!isNodeTest) return null;
  try {
    const git = args => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (git(['status', '--porcelain', '--untracked-files=all', '--ignored=no']) !== '') return null;
    const tree = git(['rev-parse', 'HEAD^{tree}']);
    if (!/^[0-9a-f]{40,64}$/.test(tree)) return null;
    const key = crypto.createHash('sha256').update(JSON.stringify([tree, cmd, process.version])).digest('hex');
    return { key, tree };
  } catch { return null; }
}
export function findPass(file, key, { now = Date.now(), maxAgeHours = DEFAULT_REUSE_HOURS } = {}) {
  if (!key || !(maxAgeHours > 0)) return null;
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  for (const line of text.trim().split('\n').reverse()) {
    let r; try { r = JSON.parse(line); } catch { continue; }
    if (r.key === key.key && now - Date.parse(r.at) <= maxAgeHours * 3600000 && now >= Date.parse(r.at)) return r;
  }
  return null;
}
export function recordPass(file, key, { now = Date.now(), label } = {}) {
  if (!key) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), key: key.key, tree: key.tree, label: label ?? null }) + '\n');
}
