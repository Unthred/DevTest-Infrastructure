// Supervisor self-upgrade after reviewed merges (issue #47). Local git and file operations plus the existing upgrade and
// rollback scripts; no model call. Every external effect goes through the injected `deps`, so each rule is tested with fakes.
//
// Order of checks per tick (cheapest first): rollback latch, verification of a pending upgrade, hourly rate limit, detection,
// upgrader guard, review/CI eligibility, quiet wait, pre-checks, upgrade, dry-run health check. The "next live tick" health
// check is `verifyPending`, called by the CLI with the outcome of the live tick that ran under the new version.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { atomicJson } from './core.mjs';
import { checksState, agentOfBranch, DRAIN_DEFAULT_MINUTES } from './team.mjs';
import { makeNamer, shortCommit } from './naming.mjs';

const SHA = /^[0-9a-f]{40}$/;
export const QUIET_MAX_WAIT_MS = DRAIN_DEFAULT_MINUTES * 60 * 1000;   // one source of truth: the shipped team default (issue #191)
// Issue #353: a short cooldown after an install, not an hourly limit. A merged fix installs on the first tick with no running job.
// A loop is still prevented: an install must be verified by a live tick (or rolled back and latched) before the next one starts.
export const MIN_UPGRADE_INTERVAL_MS = 2 * 60 * 1000;
export const VERIFY_MAX_WAIT_MS = 60 * 60 * 1000;
// An environmental failure (clone, fetch, checkout or GitHub unreachable) is retried with backoff and never latches a commit (#69, #101):
// the first retry after ENV_RETRY_MS, doubling each time up to ENV_RETRY_MAX_MS. Only a failed validator or test run latches.
export const ENV_RETRY_MS = 10 * 60 * 1000;
export const ENV_RETRY_MAX_MS = 4 * 60 * 60 * 1000;
// Issue #302: what a live tick says about the new version. Only a thrown error or a skipped item that is a real fault fails it.
// A lease held by a running job is an expected wait, reported under `waiting` and never `skipped`; an item flagged `expected`
// is ignored too. Items needing the homeowner are reported under `blocked`: they are the condition, not a fault of the code.
export function liveTickOutcome(tick) {
  if (tick?.error) return { ok: false, reason: tick.error };
  const faults = Array.isArray(tick?.skipped) ? tick.skipped.filter(item => !item?.expected) : [];
  return faults.length ? { ok: false, reason: faults[0]?.reason } : { ok: true, reason: null };
}
export const envBackoffMs = attempts => Math.min(ENV_RETRY_MS * 2 ** Math.max(0, (attempts || 1) - 1), ENV_RETRY_MAX_MS);
// Only the bootstrap installer cannot install itself: a change to it is a needs-homeowner card (issue #101). The main upgrader
// (supervisor/upgrade.mjs, tools/upgrade-supervisor.sh, tools/rollback-supervisor.sh) installs like any other reviewed change.
export const BOOTSTRAP_PATHS = ['tools/bootstrap-install.sh'];
// Exit codes of tools/bootstrap-install.sh.
export const BOOTSTRAP_EXIT = { transient: 10, checks: 11, payload: 12, swap: 13 };
const short = shortCommit;

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
    out.push({ pid: Number(name), host: opt('--host'), port: opt('--port'), version: runningSha(argv[cli]), argv });
  }
  return out;
}
export async function restartDashboardServer(sha, { procRoot = '/proc', wrapper = '/root/bin/ai-supervisor', kill = (pid, sig) => process.kill(pid, sig), start, startOld, health, sleep = ms => new Promise(r => setTimeout(r, ms)), tries = 50, settleMs = 1500 } = {}) {
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
  // The port cannot be shared, so the old process had to stop first. If the new one does not come up healthy, it is stopped and the
  // old version is started again with its own original command line, so the dashboard is serving again (issue #135).
  const healthPort = old.port || process.env.DASHBOARD_PORT || '8731';
  const recover = async why => {
    const fresh = findDashboards(procRoot).filter(d => d.version === sha);
    for (const d of fresh) { try { kill(d.pid, 'SIGTERM'); } catch { /* already gone */ } }
    for (let i = 0; i < tries && !fresh.every(d => { try { kill(d.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }); i++) await sleep(200);
    let back = false;
    if (old.argv?.length) {
      try { (startOld || defaultStartArgv)(old.argv); back = true; } catch { back = false; }
      if (back && health) { back = false; for (let j = 0; j < tries && !back; j++) { back = await health(old.host, healthPort); if (!back) await sleep(200); } }
    }
    return { ok: false, recovered: back, reason: `${why}; the new process was stopped and ${back ? `the old version${old.version ? ` ${short(old.version)}` : ''} is serving again` : 'the old version could NOT be started again, so nothing is serving now'}` };
  };
  // Issue #193: a process that exists (or answered once) may still exit straight away, e.g. EADDRINUSE or a bad --host. After it
  // looks up, wait a short grace period and require it to still be running (and, with a health check, still answering).
  const settled = async () => {
    await sleep(settleMs);
    if (!findDashboards(procRoot).some(d => d.version === sha)) return false;
    return health ? Boolean(await health(old.host, healthPort)) : true;
  };
  const up = { ok: true, restarted: true, host: old.host, port: old.port };
  for (let i = 0; i < tries; i++) {
    if (findDashboards(procRoot).some(d => d.version === sha)) {
      // Health check (issue #135): the new process must answer, not merely exist. Retried while it binds its port.
      if (!health) return (await settled()) ? up : recover(`the dashboard server on ${short(sha)} did not stay running`);
      for (let j = 0; j < tries; j++) { if (await health(old.host, healthPort)) return (await settled()) ? up : recover(`the dashboard server on ${short(sha)} answered but did not stay up`); await sleep(200); }
      return recover(`the dashboard server started on ${short(sha)} but did not answer its health check`);
    }
    await sleep(200);
  }
  return recover(`the dashboard server did not come back on ${short(sha)}`);
}
// GET /api/view.json must answer 200 (it needs the supervisor state, so this proves more than an open port).
export const httpHealth = (host, port) => new Promise(resolve => {
  const req = http.get({ host, port: Number(port) || Number(process.env.DASHBOARD_PORT) || 8731, path: '/api/view.json', headers: { host: `${host}:${port}` }, timeout: 5000 }, res => { res.resume(); resolve(res.statusCode === 200); });
  req.on('timeout', () => { req.destroy(); resolve(false); }); req.on('error', () => resolve(false));
});
// Issue #193: like the AI Dashboard user script, the restarted server gets only PATH and HOME and appends its output to
// dashboard.log (if that file cannot be opened it falls back to no output rather than failing the restart).
const DASHBOARD_LOG = '/mnt/cache/ai-supervisor/dashboard.log';
const dashboardSpawn = (cmd, args) => {
  let fd = null; try { fd = fs.openSync(process.env.DASHBOARD_LOG || DASHBOARD_LOG, 'a', 0o600); } catch { fd = null; }
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/root', ...(process.env.DASHBOARD_PORT ? { DASHBOARD_PORT: process.env.DASHBOARD_PORT } : {}) };
  try { spawn(cmd, args, { detached: true, stdio: fd === null ? 'ignore' : ['ignore', fd, fd], env }).unref(); } finally { if (fd !== null) fs.closeSync(fd); }
};
const defaultStartArgv = argv => dashboardSpawn(argv[0], argv.slice(1));
const defaultStart = (wrapper, args) => dashboardSpawn(wrapper, args);

// What the team step receives from the upgrade step (issues #134, #191): a hold only while an install is pending (busy) or was just
// made by this old process (upgraded); every other outcome, rolled-back and failures included, lets dispatch go ahead.
export const holdOf = (result, s) => (result === 'busy' || result === 'upgraded' ? { to: s?.holding?.to || s?.pending?.to || null } : null);

export class SelfUpgrade {
  constructor({ root, deps, clock = { now: () => Date.now() }, drainMaxMs = QUIET_MAX_WAIT_MS }) {
    this.root = root; this.d = deps; this.clock = clock; this.drainMaxMs = drainMaxMs;   // issue #136: the configurable drain bound
    this.dir = path.join(root, 'team');
    this.stateFile = path.join(this.dir, 'self-upgrade.json');
    this.latchFile = path.join(this.dir, 'self-upgrade.latch');       // the homeowner clears the latch by removing this file
    this.recordFile = path.join(this.dir, 'upgrades.jsonl');          // dashboard (#32) input: one JSON object per line
    this.s = { alerted: {}, prechecked: {} };
    try { this.s = { ...this.s, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // PRs named by the shared formatter (issue #147); best effort, bare numbers if GitHub cannot be read.
  async prNames(prs) {
    let names = null; try { names = await this.d.names?.(); } catch { names = null; }
    return (prs || []).map(n => (names ? names.pr(n).text : `PR #${n}`)).join(', ') || 'no pull requests';
  }
  // The last install outcome, shown by `team status` and the dashboard (and read by #105's Install stage). result is one of: installed
  // (awaiting the live tick), verified, transient (retried at nextAttemptAt), blocked (failed validator or tests; waits for a newer
  // main), needs-homeowner, rolled_back, rollback_failed.
  noteInstall(i) { this.s.install = { at: this.clock.now(), ...i }; }
  save() { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); atomicJson(this.stateFile, this.s); }
  latch() { try { return JSON.parse(fs.readFileSync(this.latchFile, 'utf8')); } catch { return fs.existsSync(this.latchFile) ? { reason: 'unreadable latch' } : null; } }
  clearLatch() { fs.rmSync(this.latchFile, { force: true }); }
  installCommand(target) {
    let url = null; try { url = this.d.remoteUrl?.(); } catch { url = null; }
    return `bash tools/bootstrap-install.sh install ${url || '<REPO_URL>'} ${target}`;
  }
  noteMain(from, target) {
    if (!SHA.test(target || '')) return;
    let behind = null; if (from === target) behind = 0; else { try { const n = this.d.commitsBehind?.(from, target); if (Number.isSafeInteger(n) && n >= 0) behind = n; } catch { behind = null; } }
    const m = this.s.main;
    if (m && m.sha === target && m.from === from && m.behind === behind) return;
    this.s.main = { sha: target, from, behind, at: this.clock.now() }; this.save();
  }
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
    const dp = this.s.dashboardPending;
    if (dp && !this.s.pending) await this.restartDashboard({ from: dp.from, to: dp.to }, dp.rollingBack === true);
    const result = await this.stepInner();
    if (result !== 'busy' && this.s.holding) { delete this.s.holding; this.save(); }
    return result;
  }
  async stepInner() {
    if (this.latch()) return 'latched';
    if (this.s.pending) return 'awaiting-verification';
    const from = this.d.installed();
    if (!from) return 'not-versioned';
    if (this.s.lastUpgradeAt && this.clock.now() - this.s.lastUpgradeAt < MIN_UPGRADE_INTERVAL_MS) {
      // Issue #331: the rate limit holds back the upgrade, not the display. Refresh main every tick so the header never claims "Up to date" on a stale ref.
      if (!(this.s.fetchRetryAt && this.clock.now() < this.s.fetchRetryAt)) { try { this.noteMain(from, this.d.fetchMain()); } catch { /* display only: the next tick tries again */ } }
      return 'rate-limited';
    }
    let target;
    const t0 = this.clock.now();
    if (this.s.fetchRetryAt && t0 < this.s.fetchRetryAt) return 'github-unreachable';
    try { target = this.d.fetchMain(); } catch (error) {
      // GitHub unreachable (or fetch failed): transient. Nothing is latched; the next attempt is after the backoff.
      const n = (this.s.fetchFailures || 0) + 1, retryAt = t0 + envBackoffMs(n);
      this.s.fetchFailures = n; this.s.fetchRetryAt = retryAt;
      this.noteInstall({ result: 'transient', sha: null, attempts: n, reason: `GitHub unreachable: ${String(error?.message || error).slice(0, 120)}`, nextAttemptAt: retryAt });
      this.save();
      return 'github-unreachable';
    }
    if (this.s.fetchFailures) { delete this.s.fetchFailures; delete this.s.fetchRetryAt; if (this.s.install?.result === 'transient' && !this.s.install.sha) delete this.s.install; this.save(); }
    // Issue #265: the dashboard reads main and how far behind the install is from here (live origin/main), not from the last attempt.
    this.noteMain(from, target);
    if (this.s.handDeploy && this.s.handDeploy.from !== from) { delete this.s.handDeploy; this.save(); }   // the installed commit moved: the item is done
    if (!SHA.test(target || '') || target === from) { delete this.s.waitingSince; delete this.s.waitingFor; this.save(); return 'current'; }
    if (!this.d.isAncestor(from, target)) {
      await this.alert(`${target}:diverged`, `Supervisor self-upgrade skipped: installed ${short(from)} is not an ancestor of main ${short(target)}.`);
      return 'diverged';
    }
    const files = this.d.changedFiles(from, target);
    if (!files.some(f => f.startsWith('supervisor/'))) return 'no-supervisor-change';
    const touched = files.filter(f => BOOTSTRAP_PATHS.includes(f));
    if (touched.length) {
      await this.alert(`${target}:upgrader`, `Supervisor upgrade to ${short(target)}: needs the homeowner: changes the bootstrap installer (${touched.join(', ')}), which cannot install itself. Not upgraded automatically.`);
      // Issue #265: one record per target (the alert above is already once per target), and one Needs you item until the install moves.
      if (this.s.handDeploy?.to !== target) {
        this.record({ from, to: target, result: 'refused', reason: 'changes the bootstrap installer', files: touched });
        this.s.handDeploy = { from, to: target, files: touched.slice(0, 10), command: this.installCommand(target), at: this.clock.now() };
      }
      this.noteInstall({ result: 'needs-homeowner', sha: target, reason: 'changes the bootstrap installer' }); this.save();
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
    if (latched && !(latched.environmental && now - latched.at >= envBackoffMs(latched.attempts))) return 'precheck-failed';
    // The wait belongs to one target: a newer main starts a fresh wait instead of inheriting the old start (review of PR #162).
    if (this.s.waitingFor !== target || this.s.waitingSince == null) { this.s.waitingSince = now; this.s.waitingFor = target; }
    // Drain (issue #136): while jobs run and the bound is not reached, no new job starts; the install happens at the first job
    // boundary. At the bound the install goes ahead without waiting further; it replaces files only and never kills a running job.
    const running = await this.d.activeJobs();
    if (running > 0 && now - this.s.waitingSince < this.drainMaxMs) { this.s.holding = { to: target, since: this.s.waitingSince, jobs: running }; this.save(); return 'busy'; }
    const checks = { eligibility: 'ok', quiet: running > 0 ? 'forced-after-wait' : 'idle' };
    const pre = await this.d.preChecks(target);
    if (!pre.ok) {
      const attempts = pre.environmental ? (latched?.environmental ? (latched.attempts || 1) + 1 : 1) : 0;
      this.s.prechecked[target] = pre.environmental ? { at: now, environmental: true, attempts } : now; delete this.s.waitingSince; delete this.s.waitingFor;
      this.noteInstall(pre.environmental
        ? { result: 'transient', sha: target, reason: pre.reason, attempts, nextAttemptAt: now + envBackoffMs(attempts) }
        : { result: 'blocked', sha: target, reason: pre.reason });
      this.save();
      await this.alert(`${target}:precheck`, `Supervisor upgrade to ${short(target)} not done: pre-check failed (${pre.reason}).`);
      this.record({ from, to: target, prs: eligibility.prs, checks: { ...checks, preChecks: 'failed' }, result: 'precheck_failed', reason: pre.reason });
      return 'precheck-failed';
    }
    checks.preChecks = 'ok';
    // The rate-limit stamp is written before the upgrade, so a crash mid-upgrade cannot cause an immediate second attempt.
    this.s.lastUpgradeAt = now; delete this.s.waitingSince; delete this.s.waitingFor; this.save();
    const up = await this.d.upgrade(target);
    if (!up.ok && up.environmental) {
      // The clean copy could not be taken at install time (GitHub unreachable): nothing was swapped, so retry, do not roll back.
      const attempts = (latched?.environmental ? (latched.attempts || 1) : 0) + 1;
      this.s.prechecked[target] = { at: now, environmental: true, attempts }; delete this.s.lastUpgradeAt;
      this.noteInstall({ result: 'transient', sha: target, reason: up.reason, attempts, nextAttemptAt: now + envBackoffMs(attempts) }); this.save();
      this.record({ from, to: target, prs: eligibility.prs, checks, result: 'precheck_failed', reason: up.reason });
      return 'precheck-failed';
    }
    if (!up.ok && up.blocked) {
      // The install-time validator, tests or payload check failed before anything was swapped: block only this commit until a newer
      // main, with one alert. No rollback and no global latch (#101).
      this.s.prechecked[target] = now; delete this.s.lastUpgradeAt;
      this.noteInstall({ result: 'blocked', sha: target, reason: up.reason }); this.save();
      await this.alert(`${target}:precheck`, `Supervisor upgrade to ${short(target)} not done: install-time check failed (${up.reason}).`);
      this.record({ from, to: target, prs: eligibility.prs, checks: { ...checks, installChecks: 'failed' }, result: 'precheck_failed', reason: up.reason });
      return 'precheck-failed';
    }
    if (!up.ok) {
      const rb = await this.rollback(from, target, `upgrade script failed: ${up.reason}`, eligibility.prs, checks);
      return rb;
    }
    const dry = await this.d.dryRunTick();
    if (!dry.ok) return this.rollback(from, target, `team tick --dry-run failed: ${dry.reason}`, eligibility.prs, { ...checks, dryRun: 'failed' });
    checks.dryRun = 'ok';
    this.s.pending = { from, to: target, prs: eligibility.prs, checks, at: now };
    this.noteInstall({ result: 'installed', sha: target, reason: null }); this.save();
    this.record({ from, to: target, prs: eligibility.prs, checks, result: 'upgraded' });
    await this.alert(`${target}:upgraded`, `Supervisor upgraded to ${short(target)} (${await this.prNames(eligibility.prs)}).`);
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
    delete this.s.pending; this.noteInstall({ result: 'verified', sha: p.to, reason: null }); this.save();
    this.record({ from: p.from, to: p.to, prs: p.prs, checks: { ...p.checks, liveTick: 'ok' }, result: 'verified' });
    await this.restartDashboard(p);
    return 'verified';
  }

  // After a verified upgrade the dashboard server is restarted so it does not keep serving old code. It never touches jobs or
  // the dispatcher; a failure is recorded and alerted once and the page's own mismatch warning stays up until it is fixed.
  // p.to is the version the server must end on: the new one after an install; after a rollback p is {from: failed, to: restored}.
  async restartDashboard(p, rollingBack = false) {
    const target = p.to;
    if (typeof this.d.restartDashboard !== 'function') return;
    // Issue #193: remembered before the restart so a tick that dies between the 'verified' record and the outcome record is retried.
    this.s.dashboardPending = { from: p.from, to: p.to, rollingBack }; this.save();
    let r;
    try { r = await this.d.restartDashboard(target); } catch (error) { r = { ok: false, reason: String(error?.message || error).slice(0, 160) }; }
    // The outcome is recorded first and the intent cleared after it, so a loss between the two re-runs the restart (a duplicate record at worst) instead of leaving nothing.
    this.record({ from: p.from, to: p.to, result: r.ok ? 'dashboard_restarted' : 'dashboard_restart_failed', reason: r.ok ? (r.restarted ? null : r.reason) : r.reason, ...(r.ok && r.restarted ? { restarted: true } : {}) });
    delete this.s.dashboardPending; this.save();
    if (!r.ok) await this.alert(`${p.to}:dashboard${rollingBack ? ':rollback' : ''}`, `Dashboard server was not restarted on ${short(target)} after the ${rollingBack ? 'rollback' : 'upgrade'}: ${r.reason}. Check the dashboard and restart it by hand if needed (the page shows "restart pending" until then).`);
  }

  async rollback(from, to, reason, prs, checks) {
    let result = { ok: false, reason: 'rollback not attempted' };
    try { result = await this.d.rollback(from, to); } catch (error) { result = { ok: false, reason: String(error?.message || error).slice(0, 160) }; }
    delete this.s.pending;
    const note = result.ok ? reason : `${reason}; ROLLBACK FAILED (${result.reason}), manual repair needed`;
    this.noteInstall({ result: result.ok ? 'rolled_back' : 'rollback_failed', sha: to, reason: note.slice(0, 200) }); this.save();
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.latchFile, JSON.stringify({ at: this.clock.now(), from, to, reason: note }), { mode: 0o600 });
    this.record({ from, to, prs, checks, result: result.ok ? 'rolled_back' : 'rollback_failed', reason: note });
    // A rollback also restarts the dashboard so the badge and the running commit agree (issue #135); jobs are never touched.
    if (result.ok) await this.restartDashboard({ from: to, to: from }, true);
    await this.alert(`${to}:rolledback`, `Upgrade to ${short(to)} rolled back: ${note}. Automatic upgrades are paused until the homeowner clears ${this.latchFile}.`);
    return result.ok ? 'rolled-back' : 'rollback-failed';
  }

  // Every first-parent commit in (from, to] must be a merged PR whose merged head has a dispatcher-recorded PASS from the
  // independent reviewer and green CI. A direct commit to main, or any missing proof, makes the range ineligible. A PASS from the
  // author's own provider counts when the dispatcher recorded it as independent (a different model, issue #152; or an earlier
  // interim PASS recorded under D-021).
  async eligibility(from, to) {
    const prs = [];
    for (const c of this.d.mainCommits(from, to)) {
      if (!c.pr || !SHA.test(c.head || '')) return { ok: false, prs, reason: `commit ${short(c.sha)} on main is not a reviewed pull request merge` };
      const pull = await this.d.mergedPull(c.pr);
      const author = agentOfBranch(this.d.config, pull?.headRefName);
      if (!pull || pull.state !== 'MERGED' || pull.headRefOid !== c.head || !author) return { ok: false, prs, reason: `PR #${c.pr} could not be matched to its merged head` };
      prs.push(c.pr);
      const v = this.d.verdict(c.pr, c.head);
      const independent = v?.interim === true || (v?.independent === true && this.d.independenceApproved?.() === true);
      if (v?.verdict !== 'PASS' || (v.reviewer === author && !independent) || !this.d.config.agents[v.reviewer])
        return { ok: false, prs, reason: `PR #${c.pr} has no recorded PASS from an independent reviewer at merged head ${short(c.head)}` };
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

export function realDeps({ root, config, gh, listActive, verdictFor, independenceApproved = () => false, wrapper = '/root/bin/ai-supervisor', run = defaultRun, sendAlert }) {
  const repo = config.repo_path;
  const git = (...a) => { const r = run('git', ['-C', repo, ...a]); if (r.status !== 0) throw new Error(`git ${a[0]} failed`); return r.stdout.trim(); };
  const remoteUrl = () => git('remote', 'get-url', 'origin');
  // The bootstrap installer is taken from the installed commit, not the target: it is the one file a range may not change.
  const bootstrap = (mode, sha, timeoutMs) => {
    const dir = scratch();
    try {
      const from = installedSha(root);
      if (!from) return { ok: false, reason: 'no installed version to take the bootstrap installer from' };
      const script = path.join(dir, 'bootstrap-install.sh');
      fs.writeFileSync(script, git('show', `${from}:tools/bootstrap-install.sh`), { mode: 0o700 });
      const r = run('bash', [script, mode, remoteUrl(), sha], { timeoutMs });
      if (r.status === 0) return { ok: true };
      const reason = tail(r);
      if (r.status === BOOTSTRAP_EXIT.transient) return { ok: false, environmental: true, reason };
      // Exit 11 (validator/tests) and 12 (payload re-verify) happen before the swap: block the commit, never roll back.
      const blocked = r.status === BOOTSTRAP_EXIT.checks || r.status === BOOTSTRAP_EXIT.payload;
      return { ok: false, ...(blocked ? { blocked: true } : {}), reason: r.status === BOOTSTRAP_EXIT.payload ? `refused: ${reason}` : reason };
    } catch (error) { return { ok: false, environmental: true, reason: String(error?.message || error).slice(0, 160) }; }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'self-upgrade-'));
  return {
    config,
    installed: () => installedSha(root),
    fetchMain: () => { git('fetch', '--quiet', 'origin', 'main'); return git('rev-parse', 'origin/main'); },
    isAncestor: (a, b) => run('git', ['-C', repo, 'merge-base', '--is-ancestor', a, b]).status === 0,
    remoteUrl,
    commitsBehind: (a, b) => Number(git('rev-list', '--count', `${a}..${b}`)),
    changedFiles: (a, b) => git('diff', '--name-only', a, b).split('\n').filter(Boolean),
    mainCommits: (a, b) => git('rev-list', '--first-parent', '--parents', '--reverse', `${a}..${b}`).split('\n').filter(Boolean).map(line => {
      const [sha, ...parents] = line.split(' ');
      const m = parents.length === 2 ? /^Merge pull request #(\d+) /.exec(git('log', '-1', '--format=%s', sha)) : null;
      return { sha, pr: m ? Number(m[1]) : null, head: parents[1] || null };
    }),
    mergedPull: n => gh.getMergedPull(n),
    names: async () => makeNamer({ repo: config.repository, issues: await gh.listIssues(), merged: await gh.listMergedPulls() }),
    verdict: verdictFor,
    independenceApproved,
    activeJobs: async () => (await listActive()).length,
    preChecks: async sha => bootstrap('check', sha, 2400000),
    upgrade: async sha => bootstrap('install', sha, 3000000),
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
    restartDashboard: async sha => restartDashboardServer(sha, { wrapper, health: httpHealth }),
    alert: sendAlert
  };
}
