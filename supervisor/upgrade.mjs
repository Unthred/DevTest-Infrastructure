// Supervisor self-upgrade after reviewed merges (issue #47). Local git and file operations plus the existing upgrade and
// rollback scripts; no model call. Every external effect goes through the injected `deps`, so each rule is tested with fakes.
//
// Order of checks per tick (cheapest first): rollback latch, verification of a pending upgrade, hourly rate limit, detection,
// upgrader guard, review/CI eligibility, quiet wait, pre-checks, upgrade, dry-run health check. The "next live tick" health
// check is `verifyPending`, called by the CLI with the outcome of the live tick that ran under the new version.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { atomicJson } from './core.mjs';
import { checksState, agentOfBranch } from './team.mjs';

const SHA = /^[0-9a-f]{40}$/;
export const QUIET_MAX_WAIT_MS = 30 * 60 * 1000;
export const MIN_UPGRADE_INTERVAL_MS = 60 * 60 * 1000;
export const VERIFY_MAX_WAIT_MS = 60 * 60 * 1000;
// An environmental pre-check failure (clone, fetch or checkout) is retried after this; only a failed check latches a commit (#69).
export const ENV_RETRY_MS = 60 * 60 * 1000;
// A change to any of these cannot be deployed by the upgrader it modifies: the homeowner deploys it by hand.
export const UPGRADER_PATHS = ['tools/upgrade-supervisor.sh', 'tools/rollback-supervisor.sh', 'supervisor/upgrade.mjs'];
const short = sha => String(sha).slice(0, 7);

export function installedSha(root) {
  try { const m = /^versions\/([0-9a-f]{40})$/.exec(fs.readlinkSync(path.join(root, 'current'))); return m ? m[1] : null; } catch { return null; }
}
// The version this process is running from (…/versions/<sha>/supervisor/cli.mjs), or null when run from a source checkout.
export function runningSha(file) {
  const m = /\/versions\/([0-9a-f]{40})\/supervisor\/[^/]+$/.exec(file);
  return m ? m[1] : null;
}

// ---- dashboard server restart (issue #155). The read-only dashboard server is a long-lived process started by hand or by the
// AI Dashboard user script; a self-upgrade moves the `current` link but not that process, so it would keep serving old code.
// This finds only `cli.mjs dashboard serve` processes (never a worker or a job), stops them, and starts the same host and port
// from the new version. Every effect is injectable so the rule is tested without a real process.
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
export function findDashboards(procRoot = '/proc', self = process.pid) {
  const out = [];
  let names = []; try { names = fs.readdirSync(procRoot); } catch { return out; }
  for (const name of names) {
    if (!/^\d+$/.test(name) || Number(name) === self) continue;
    let argv; try { argv = fs.readFileSync(path.join(procRoot, name, 'cmdline'), 'utf8').split('\0').filter(Boolean); } catch { continue; }
    const cli = /(^|\/)(node|nodejs)$/.test(argv[0] || '') ? argv.findIndex((a, i) => i === 1 && /(^|\/)supervisor\/cli\.mjs$/.test(a)) : -1;
    if (cli < 0 || argv[cli + 1] !== 'dashboard' || argv[cli + 2] !== 'serve') continue;
    const opt = key => { const i = argv.indexOf(key); return i > cli && i + 1 < argv.length ? argv[i + 1] : null; };
    out.push({ pid: Number(name), host: opt('--host'), port: opt('--port'), version: runningSha(argv[cli]) });
  }
  return out;
}
export async function restartDashboardServer(sha, { procRoot = '/proc', wrapper = '/root/bin/ai-supervisor', kill = (pid, sig) => process.kill(pid, sig), start, sleep = ms => new Promise(r => setTimeout(r, ms)), tries = 50 } = {}) {
  const found = findDashboards(procRoot);
  if (!found.length) return { ok: true, restarted: false, reason: 'no dashboard server was running' };
  if (found.every(d => d.version === sha)) return { ok: true, restarted: false, reason: 'already on the new version' };
  const old = found.find(d => IPV4.test(d.host || '') && /^\d+$/.test(d.port || '')) || found[0];
  if (!IPV4.test(old.host || '')) return { ok: false, reason: 'the running dashboard server has no readable --host, so it cannot be restarted the same way' };
  for (const d of found) { try { kill(d.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') return { ok: false, reason: `could not stop dashboard pid ${d.pid}: ${error.code || 'error'}` }; } }
  const gone = () => { try { return found.every(d => { try { kill(d.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }); } catch { return false; } };
  for (let i = 0; i < tries && !gone(); i++) await sleep(200);
  if (!gone()) return { ok: false, reason: 'the old dashboard server did not stop' };
  const args = ['dashboard', 'serve', '--host', old.host, ...(old.port ? ['--port', old.port] : [])];
  try { (start || defaultStart)(wrapper, args); } catch (error) { return { ok: false, reason: `could not start the dashboard server: ${String(error?.message || error).slice(0, 120)}` }; }
  for (let i = 0; i < tries; i++) {
    if (findDashboards(procRoot).some(d => d.version === sha)) return { ok: true, restarted: true, host: old.host, port: old.port };
    await sleep(200);
  }
  return { ok: false, reason: `the dashboard server did not come back on ${short(sha)}` };
}
const defaultStart = (wrapper, args) => { spawn(wrapper, args, { detached: true, stdio: 'ignore', env: process.env }).unref(); };

export class SelfUpgrade {
  constructor({ root, deps, clock = { now: () => Date.now() } }) {
    this.root = root; this.d = deps; this.clock = clock;
    this.dir = path.join(root, 'team');
    this.stateFile = path.join(this.dir, 'self-upgrade.json');
    this.latchFile = path.join(this.dir, 'self-upgrade.latch');       // the homeowner clears the latch by removing this file
    this.recordFile = path.join(this.dir, 'upgrades.jsonl');          // dashboard (#32) input: one JSON object per line
    this.s = { alerted: {}, prechecked: {} };
    try { this.s = { ...this.s, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  save() { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); atomicJson(this.stateFile, this.s); }
  latch() { try { return JSON.parse(fs.readFileSync(this.latchFile, 'utf8')); } catch { return fs.existsSync(this.latchFile) ? { reason: 'unreadable latch' } : null; } }
  clearLatch() { fs.rmSync(this.latchFile, { force: true }); }
  record(entry) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.recordFile, `${JSON.stringify({ at: this.clock.now(), ...entry })}\n`, { mode: 0o600 });
  }
  // One alert per key, recorded before delivery so a failing channel cannot cause a repeat every tick.
  async alert(key, text) {
    if (this.s.alerted[key]) return;
    this.s.alerted[key] = this.clock.now(); this.save();
    try { await this.d.alert(text); } catch { /* delivery failure is kept in the alert log by the sender; the upgrade decision is unaffected */ }
  }

  // Returns a short result string for the tick report. `holding` (read by `team status` and the dashboard) is set only while the
  // result is 'busy': an upgrade is pending and eligible, and new jobs are held back (issue #134).
  async step() {
    const result = await this.stepInner();
    if (result !== 'busy' && this.s.holding) { delete this.s.holding; this.save(); }
    return result;
  }
  async stepInner() {
    if (this.latch()) return 'latched';
    if (this.s.pending) return 'awaiting-verification';
    const from = this.d.installed();
    if (!from) return 'not-versioned';
    if (this.s.lastUpgradeAt && this.clock.now() - this.s.lastUpgradeAt < MIN_UPGRADE_INTERVAL_MS) return 'rate-limited';
    const target = this.d.fetchMain();
    if (!SHA.test(target || '') || target === from) { delete this.s.waitingSince; this.save(); return 'current'; }
    if (!this.d.isAncestor(from, target)) {
      await this.alert(`${target}:diverged`, `Supervisor self-upgrade skipped: installed ${short(from)} is not an ancestor of main ${short(target)}.`);
      return 'diverged';
    }
    const files = this.d.changedFiles(from, target);
    if (!files.some(f => f.startsWith('supervisor/'))) return 'no-supervisor-change';
    const touched = files.filter(f => UPGRADER_PATHS.includes(f));
    if (touched.length) {
      await this.alert(`${target}:upgrader`, `Supervisor upgrade to ${short(target)}: deploy needed: changes the upgrader (${touched.join(', ')}). Not upgraded automatically.`);
      this.record({ from, to: target, result: 'refused', reason: 'changes the upgrader', files: touched });
      return 'upgrader-changed';
    }
    const eligibility = await this.eligibility(from, target);
    if (!eligibility.ok) {
      await this.alert(`${target}:eligibility`, `Supervisor upgrade to ${short(target)} not done: ${eligibility.reason}.`);
      this.record({ from, to: target, prs: eligibility.prs, result: 'refused', reason: eligibility.reason });
      return 'not-eligible';
    }
    const now = this.clock.now();
    // A failed check latches this commit until a newer main; an environmental failure is retried after ENV_RETRY_MS (#69).
    // Checked before the quiet wait so a latched target never holds dispatch for a commit that will not be installed (#134).
    const latched = this.s.prechecked[target];
    if (latched && !(latched.environmental && now - latched.at >= ENV_RETRY_MS)) return 'precheck-failed';
    this.s.waitingSince ??= now;
    if ((await this.d.activeJobs()) > 0 && now - this.s.waitingSince < QUIET_MAX_WAIT_MS) { this.s.holding = { to: target, since: this.s.holding?.to === target ? this.s.holding.since : now }; this.save(); return 'busy'; }
    const checks = { eligibility: 'ok', quiet: (await this.d.activeJobs()) > 0 ? 'forced-after-wait' : 'idle' };
    const pre = await this.d.preChecks(target);
    if (!pre.ok) {
      this.s.prechecked[target] = pre.environmental ? { at: now, environmental: true } : now; delete this.s.waitingSince; this.save();
      await this.alert(`${target}:precheck`, `Supervisor upgrade to ${short(target)} not done: pre-check failed (${pre.reason}).`);
      this.record({ from, to: target, prs: eligibility.prs, checks: { ...checks, preChecks: 'failed' }, result: 'precheck_failed', reason: pre.reason });
      return 'precheck-failed';
    }
    checks.preChecks = 'ok';
    // The rate-limit stamp is written before the upgrade, so a crash mid-upgrade cannot cause an immediate second attempt.
    this.s.lastUpgradeAt = now; delete this.s.waitingSince; this.save();
    const up = await this.d.upgrade(target);
    if (!up.ok) {
      const rb = await this.rollback(from, target, `upgrade script failed: ${up.reason}`, eligibility.prs, checks);
      return rb;
    }
    const dry = await this.d.dryRunTick();
    if (!dry.ok) return this.rollback(from, target, `team tick --dry-run failed: ${dry.reason}`, eligibility.prs, { ...checks, dryRun: 'failed' });
    checks.dryRun = 'ok';
    this.s.pending = { from, to: target, prs: eligibility.prs, checks, at: now }; this.save();
    this.record({ from, to: target, prs: eligibility.prs, checks, result: 'upgraded' });
    await this.alert(`${target}:upgraded`, `Supervisor upgraded to ${short(target)} (PRs ${eligibility.prs.map(n => `#${n}`).join(', ')}).`);
    return 'upgraded';
  }

  // `ok` is false when the live tick threw or reported skipped items; `running` is the sha this process runs from.
  async verifyPending({ running, ok, reason }) {
    const p = this.s.pending;
    if (!p) return null;
    const now = this.clock.now();
    if (running !== p.to) {
      if (now - p.at < VERIFY_MAX_WAIT_MS) return 'awaiting-verification';
      return this.rollback(p.from, p.to, 'no live tick ran under the new version within an hour', p.prs, { ...p.checks, liveTick: 'missing' });
    }
    if (!ok) return this.rollback(p.from, p.to, `live tick failed: ${String(reason || 'error').slice(0, 160)}`, p.prs, { ...p.checks, liveTick: 'failed' });
    delete this.s.pending; this.save();
    this.record({ from: p.from, to: p.to, prs: p.prs, checks: { ...p.checks, liveTick: 'ok' }, result: 'verified' });
    await this.restartDashboard(p);
    return 'verified';
  }

  // After a verified upgrade the dashboard server is restarted so it does not keep serving old code. It never touches jobs or
  // the dispatcher; a failure is recorded and alerted once and the page's own mismatch warning stays up until it is fixed.
  async restartDashboard(p) {
    if (typeof this.d.restartDashboard !== 'function') return;
    let r;
    try { r = await this.d.restartDashboard(p.to); } catch (error) { r = { ok: false, reason: String(error?.message || error).slice(0, 160) }; }
    this.record({ from: p.from, to: p.to, result: r.ok ? 'dashboard_restarted' : 'dashboard_restart_failed', reason: r.ok ? (r.restarted ? null : r.reason) : r.reason, ...(r.ok && r.restarted ? { restarted: true } : {}) });
    if (!r.ok) await this.alert(`${p.to}:dashboard`, `Dashboard server was not restarted after the upgrade to ${short(p.to)}: ${r.reason}. Restart it by hand; the page warns that it may be out of date.`);
  }

  async rollback(from, to, reason, prs, checks) {
    let result = { ok: false, reason: 'rollback not attempted' };
    try { result = await this.d.rollback(from, to); } catch (error) { result = { ok: false, reason: String(error?.message || error).slice(0, 160) }; }
    delete this.s.pending; this.save();
    const note = result.ok ? reason : `${reason}; ROLLBACK FAILED (${result.reason}), manual repair needed`;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.latchFile, JSON.stringify({ at: this.clock.now(), from, to, reason: note }), { mode: 0o600 });
    this.record({ from, to, prs, checks, result: result.ok ? 'rolled_back' : 'rollback_failed', reason: note });
    await this.alert(`${to}:rolledback`, `Upgrade to ${short(to)} rolled back: ${note}. Automatic upgrades are paused until the homeowner clears ${this.latchFile}.`);
    return result.ok ? 'rolled-back' : 'rollback-failed';
  }

  // Every first-parent commit in (from, to] must be a merged PR whose merged head has a dispatcher-recorded PASS from the
  // opposite agent and green CI. A direct commit to main, or any missing proof, makes the range ineligible. An interim
  // (D-021) PASS from the author's own provider counts while interim review is enabled; the dispatcher records that flag
  // only after checking D-021 is homeowner-approved, and the post-merge review still follows.
  async eligibility(from, to) {
    const prs = [];
    for (const c of this.d.mainCommits(from, to)) {
      if (!c.pr || !SHA.test(c.head || '')) return { ok: false, prs, reason: `commit ${short(c.sha)} on main is not a reviewed pull request merge` };
      const pull = await this.d.mergedPull(c.pr);
      const author = agentOfBranch(this.d.config, pull?.headRefName);
      if (!pull || pull.state !== 'MERGED' || pull.headRefOid !== c.head || !author) return { ok: false, prs, reason: `PR #${c.pr} could not be matched to its merged head` };
      prs.push(c.pr);
      const v = this.d.verdict(c.pr, c.head);
      const interim = v?.interim === true && this.d.config.interim_review?.enabled === true;
      if (v?.verdict !== 'PASS' || (v.reviewer === author && !interim) || !this.d.config.agents[v.reviewer])
        return { ok: false, prs, reason: `PR #${c.pr} has no recorded PASS from the opposite agent at merged head ${short(c.head)}` };
      if (checksState(pull.statusCheckRollup) !== 'green') return { ok: false, prs, reason: `CI was not green on PR #${c.pr} at merged head ${short(c.head)}` };
    }
    return { ok: true, prs };
  }
}

// ---- real dependencies (used by the CLI only)
const defaultRun = (cmd, args, { cwd, timeoutMs = 120000, input } = {}) => {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C' } });
  return { status: r.status ?? (r.error ? 127 : 1), stdout: r.stdout || '', stderr: r.stderr || '' };
};
const tail = r => String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 200);

export function realDeps({ root, config, gh, listActive, verdictFor, wrapper = '/root/bin/ai-supervisor', run = defaultRun, sendAlert }) {
  const repo = config.repo_path;
  const git = (...a) => { const r = run('git', ['-C', repo, ...a]); if (r.status !== 0) throw new Error(`git ${a[0]} failed`); return r.stdout.trim(); };
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'self-upgrade-'));
  const withCheckout = (sha, fn) => {
    const dir = scratch();
    try {
      const checkout = path.join(dir, 'src');
      const c = run('git', ['clone', '--quiet', '--no-local', repo, checkout], { timeoutMs: 300000 });
      if (c.status !== 0) return { ok: false, environmental: true, reason: `clone failed: ${tail(c)}` };
      // A clone of the local repository carries only its branches. The target comes from fetchMain (origin/main), which the
      // local main may be behind, so the clone also takes the repository's remote-tracking refs (#69).
      const f = run('git', ['-C', checkout, 'fetch', '--quiet', 'origin', '+refs/remotes/origin/*:refs/remotes/origin/*'], { timeoutMs: 300000 });
      if (f.status !== 0) return { ok: false, environmental: true, reason: `fetch failed: ${tail(f)}` };
      const d = run('git', ['-C', checkout, 'checkout', '--quiet', '--detach', sha]);
      if (d.status !== 0) return { ok: false, environmental: true, reason: `checkout failed: ${tail(d)}` };
      return fn(checkout);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  return {
    config,
    installed: () => installedSha(root),
    fetchMain: () => { git('fetch', '--quiet', 'origin', 'main'); return git('rev-parse', 'origin/main'); },
    isAncestor: (a, b) => run('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b]).status === 0,
    changedFiles: (a, b) => git('diff', '--name-only', a, b).split('\n').filter(Boolean),
    mainCommits: (a, b) => git('rev-list', '--first-parent', '--parents', '--reverse', `${a}..${b}`).split('\n').filter(Boolean).map(line => {
      const [sha, ...parents] = line.split(' ');
      const m = parents.length === 2 ? /^Merge pull request #(\d+) /.exec(git('log', '-1', '--format=%s', sha)) : null;
      return { sha, pr: m ? Number(m[1]) : null, head: parents[1] || null };
    }),
    mergedPull: n => gh.getMergedPull(n),
    verdict: verdictFor,
    activeJobs: async () => (await listActive()).length,
    preChecks: async sha => withCheckout(sha, checkout => {
      const v = run('node', ['tools/validate-project.mjs'], { cwd: checkout, timeoutMs: 300000 });
      if (v.status !== 0) return { ok: false, reason: `validator: ${tail(v)}` };
      const t = run('node', ['--test', 'tests/**/*.test.mjs'], { cwd: checkout, timeoutMs: 1800000 });
      return t.status === 0 ? { ok: true } : { ok: false, reason: `tests: ${tail(t)}` };
    }),
    upgrade: async sha => withCheckout(sha, checkout => {
      const u = run('bash', ['tools/upgrade-supervisor.sh'], { cwd: checkout, timeoutMs: 600000 });
      return u.status === 0 ? { ok: true } : { ok: false, reason: tail(u) };
    }),
    dryRunTick: async () => {
      const r = run(wrapper, ['team', 'tick', '--dry-run'], { timeoutMs: 180000 });
      if (r.status !== 0) return { ok: false, reason: tail(r) };
      try {
        const out = JSON.parse(r.stdout);
        if (typeof out?.skipped === 'string' || !Array.isArray(out?.actions)) return { ok: false, reason: 'dry-run did not run a plan' };
      } catch { return { ok: false, reason: 'dry-run output is not JSON' }; }
      return { ok: true };
    },
    rollback: async (from, to) => {
      const dir = scratch();
      try {
        // The script is taken from the previous version: the guard guarantees the range did not change it.
        const script = path.join(dir, 'rollback-supervisor.sh');
        fs.writeFileSync(script, git('show', `${from}:tools/rollback-supervisor.sh`), { mode: 0o700 });
        const r = run('bash', [script, '--supervisor', to, from]);
        return r.status === 0 ? { ok: true } : { ok: false, reason: tail(r) };
      } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    },
    restartDashboard: async sha => restartDashboardServer(sha, { wrapper }),
    alert: sendAlert
  };
}
