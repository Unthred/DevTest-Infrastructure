// Issue #637: one bounded test run on a given head for the inbox action `run_tests`. A fresh independent clone (never a linked worktree),
// the head checked out detached and verified, then the suite through `ai-supervisor test-slot run`, which applies the test-slot limit and the
// host admission (load and swap) rules and its own maximum runtime. The outer bound below kills the whole group if that does not return.
// The result is saved, redacted, where the overseer and the dashboard can read it: <root>/team/inbox-test-runs/<sha>.json. No model call.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { redactLong } from './redact.mjs';
import { SupervisorError, atomicJson } from './core.mjs';
import { tickLock } from './team.mjs';

export const SUITE = ['node', '--test', '--test-reporter=dot', 'tests/**/*.test.mjs'];
export const MAX_MINUTES = 30, OUTER_GRACE_MS = 5 * 60 * 1000, TAIL_CHARS = 1500;
const SHA = /^[0-9a-f]{40}$/;

const runGit = (args, opts = {}) => spawnSync('git', args, { encoding: 'utf8', timeout: 300000, ...opts });

// `run` is injectable for tests: ({ argv, cwd, timeoutMs }) => Promise<{ code, output, timedOut }>.
export function runBounded({ argv, cwd, timeoutMs }) {
  return new Promise(resolve => {
    const child = spawn(argv[0], argv.slice(1), { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', timedOut = false;
    const take = d => { output = (output + d).slice(-8000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ code: null, output: String(error?.code || 'spawn error'), timedOut }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, output, timedOut }); });
  });
}

export async function cloneAndRunTests({ root, repoPath, sha, pr = null, cli, tmpRoot, maxMinutes = MAX_MINUTES, run = runBounded, now = Date.now }) {
  if (!SHA.test(sha)) throw new SupervisorError('the head is not a 40-character commit id');
  const started = now(), outDir = path.join(root, 'team', 'inbox-test-runs');
  const save = r => { fs.mkdirSync(outDir, { recursive: true, mode: 0o700 }); atomicJson(path.join(outDir, `${sha}.json`), { at: started, sha, pr, ...r }); return r; };
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'inbox-tests-'));
  try {
    const clone = path.join(dir, 'c'), url = runGit(['-C', repoPath, 'remote', 'get-url', 'origin']).stdout?.trim();
    if (!url) return save({ ok: false, summary: 'was not run: the repository has no origin', code: null });
    if (runGit(['clone', '--quiet', '--no-checkout', repoPath, clone]).status !== 0) return save({ ok: false, summary: 'was not run: the clone failed', code: null });
    runGit(['-C', clone, 'remote', 'set-url', 'origin', url]);
    if (runGit(['-C', clone, 'fetch', '--quiet', 'origin', sha]).status !== 0 || runGit(['-C', clone, 'checkout', '--quiet', '--detach', sha]).status !== 0) return save({ ok: false, summary: 'was not run: the head could not be fetched', code: null });
    if (runGit(['-C', clone, 'rev-parse', 'HEAD']).stdout.trim() !== sha) return save({ ok: false, summary: 'was not run: the checkout is not the requested head', code: null });
    const argv = [process.execPath, cli, 'test-slot', 'run', '--label', `inbox tests ${sha.slice(0, 8)}`, '--max-minutes', String(maxMinutes), '--no-reuse', '--', ...SUITE];
    const r = await run({ argv, cwd: clone, timeoutMs: maxMinutes * 60000 + OUTER_GRACE_MS });
    const seconds = Math.round((now() - started) / 1000), tail = redactLong(String(r.output || '').replace(/\u001b\[[0-9;]*m/g, '').slice(-TAIL_CHARS), TAIL_CHARS, '').trim();
    const summary = r.timedOut ? `were stopped at the maximum runtime after ${seconds} s`
      : r.code === 3 ? 'were not run: no free test slot or host headroom in time'
      : r.code === 0 ? `exit 0 in ${seconds} s` : `failed with exit code ${r.code} after ${seconds} s`;
    return save({ ok: r.code === 0 && !r.timedOut, summary, code: r.code, seconds, tail });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Issue #637 review: the run is not done in the tick. The tick records 'running', starts this detached runner and returns; the runner holds
// its own lock (like the install's upgrade.lock, issue #448), so a long run never stops another tick. One run at a time.
export const INBOX_TESTS_LOCK = 'inbox-tests.lock';
const saveRaw = (root, sha, data) => { const dir = path.join(root, 'team', 'inbox-test-runs'); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); atomicJson(path.join(dir, `${sha}.json`), data); };

export function startInboxTestRun({ root, sha, pr, cli, registry = null, spawnFn = spawn, lock = tickLock }) {
  if (!SHA.test(sha)) throw new SupervisorError('the head is not a 40-character commit id');
  const free = lock(root, INBOX_TESTS_LOCK);   // probe: a held lock means a run is in progress
  if (!free) throw new SupervisorError('another inbox test run is in progress; wait for it to finish');
  free();
  saveRaw(root, sha, { at: Date.now(), sha, pr, ok: null, running: true, summary: 'is running' });
  const argv = [cli, ...(registry ? ['--registry', registry] : []), 'inbox-test-run', sha, ...(pr != null ? [String(pr)] : [])];
  const child = spawnFn(process.execPath, argv, { detached: true, stdio: 'ignore', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: root } });
  child.unref?.();
  return { ok: true, started: true, summary: `started; the result is saved to team/inbox-test-runs/${sha}.json` };
}

export async function runLockedInboxTests({ root, sha, pr, cli, repoPath, tmpRoot, run, lock = tickLock }) {
  const release = lock(root, INBOX_TESTS_LOCK);
  if (!release) { saveRaw(root, sha, { at: Date.now(), sha, pr, ok: false, summary: 'was not run: another inbox test run is in progress', code: null }); return null; }
  try { return await cloneAndRunTests({ root, repoPath, sha, pr, cli, tmpRoot, ...(run ? { run } : {}) }); }
  catch (error) { saveRaw(root, sha, { at: Date.now(), sha, pr, ok: false, summary: `failed to run: ${String(error?.message || error).slice(0, 200)}`, code: null }); return null; }
  finally { release(); }
}
