// Supervisor self-upgrade after reviewed merges (issue #47). Local git and file operations plus the existing upgrade and
// rollback scripts; no model call. Every external effect goes through the injected `deps`, so each rule is tested with fakes.
//
// Order of checks per tick (cheapest first): rollback latch, verification of a pending upgrade, hourly rate limit, detection,
// upgrader guard, review/CI eligibility, quiet wait, pre-checks, upgrade, dry-run health check. The "next live tick" health
// check is `verifyPending`, called by the CLI with the outcome of the live tick that ran under the new version.
import { mcpNeedsInstall } from './mcpinstall.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { atomicJson } from './core.mjs';
import { makeJobTmp, removeJobTmp, jobTmpRoot, hostPressure, pressureText, leakText } from './jobtmp.mjs';
import { readRearm, rearmUpgradeState } from './robust.mjs';
import { withTestSlot, DEFAULT_TEST_SLOTS } from './testslots.mjs';
import { checksState, agentOfBranch, DRAIN_DEFAULT_MINUTES, MIN_INSTALL_GAP_DEFAULT_MINUTES } from './team.mjs';
import { makeNamer, shortCommit } from './naming.mjs';
import { redact, redactLong, redactAddresses } from './redact.mjs';

const SHA = /^[0-9a-f]{40}$/;
// Issue #488: a refusal reason kept in the upgrade history and shown on the dashboard carries no secret, address or absolute path.
// Deliberately narrower than HOST_PORT_SKIP in supervisor/redact.mjs (issue #858): a refusal reason keeps fewer file-name exemptions and
// redacts any host:port, including image tags (node:20) and a trailing .digit, so it can only over-redact, never leak. A test pins this.
const HOST_PORT_SKIP = /\.(?:mjs|cjs|js|json|sh|md|ya?ml|ts|txt|log)$/i;
const escRe = x => x.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\$&");
// Issue #501: also hide a bare host:port token (tower:8123) and any operator-configured local domain (DEVTEST_LOCAL_DOMAINS, comma-separated), even under a public suffix.
export const refusalText = (r, localDomains = (process.env.DEVTEST_LOCAL_DOMAINS || '').split(',')) => {
  let out = redactAddresses(redact(r, 300)).replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]').replace(/\b(?:[a-z0-9-]+\.)+(?:lan|local|internal|home|intranet|corp|private|localdomain|arpa)\b(?::\d+)?(?:\/\S*)?/gi, '[host]');
  const doms = localDomains.map(d => d.trim().replace(/^\.+/, '')).filter(d => /^[a-z0-9.-]+$/i.test(d));
  if (doms.length) out = out.replace(new RegExp('\\b(?:[a-z0-9-]+\\.)*(?:' + doms.map(escRe).join('|') + ')\\b(?::\\d+)?(?:\\/\\S*)?', 'gi'), '[host]');
  return out.replace(/(?<![\w.:/-])[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?:\d{2,5}\b/gi, m => HOST_PORT_SKIP.test(m.replace(/:\d+$/, '')) ? m : '[host]').replace(/(?<![\w.:/-])(?:\/[\w.@+-]+){2,}/g, '[path]');
};
export const URGENT_REQUEST_MAX_MS = 24 * 3600 * 1000;   // issue #708: an install-now request nobody spent lapses after a day
export const MIN_INSTALL_GAP_MS = MIN_INSTALL_GAP_DEFAULT_MINUTES * 60 * 1000;   // issue #695: the shipped batching window
export const QUIET_MAX_WAIT_MS = DRAIN_DEFAULT_MINUTES * 60 * 1000;   // one source of truth: the shipped team default (issue #191)
// Issue #353: a short cooldown after an install, not an hourly limit. A merged fix installs on the first tick with no running job.
// A loop is still prevented: an install must be verified by a live tick (or rolled back and latched) before the next one starts.
export const MIN_UPGRADE_INTERVAL_MS = 2 * 60 * 1000;
export const WATCHDOG_BASE_MS = 5 * 60 * 1000;      // issue #209: the delay before the second restart attempt, doubling up to the cap
export const WATCHDOG_MAX_MS = 60 * 60 * 1000;
export const WATCHDOG_RESET_MS = 30 * 60 * 1000;    // the attempt count resets after the server has answered for this long since the last attempt
export const VERIFY_MAX_WAIT_MS = 60 * 60 * 1000;
// An environmental failure (clone, fetch, checkout or GitHub unreachable) is retried with backoff and never latches a commit (#69, #101):
// the first retry after ENV_RETRY_MS, doubling each time up to ENV_RETRY_MAX_MS. Only a failed validator or test run latches.
export const ENV_RETRY_MS = 10 * 60 * 1000;
export const ENV_RETRY_MAX_MS = 4 * 60 * 60 * 1000;
// Issue #581: a commit refused by a failed check gets one more attempt after this delay without waiting for main to move
// (a check that fails only under load is not a defect of the commit). A second failure latches it until a newer main.
// Issue #692: a live tick that fails only because GitHub could not be reached says nothing about the new code. It is retried with the same
// bounded backoff and does not roll back or latch; the install stays pending until a live tick passes, fails for a real reason, or
// GitHub-only failures last LIVE_RETRY_MAX_MS (24 h), when it rolls back and latches with that stated reason.
// Only text that names GitHub (the host, or a failed gh/git call) counts; a bare ECONNREFUSED or ETIMEDOUT from other code is a real fault.
const GH_ANCHOR = /github\.com|^\s*(?:gh|git)\b[^:\n]*\bfailed:/i;
const GH_TRANSPORT = /error connecting to|could not resolve host|tcp connect error|\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EOF)\b|network is unreachable|no route to host|connection (?:timed out|reset by peer|refused)|i\/o timeout|TLS handshake timeout|context deadline exceeded|Client\.Timeout|dial tcp|proxyconnect|failed to connect to|temporary failure in name resolution/i;
export const isGithubConnectionError = reason => { const t = String(reason || ''); return GH_ANCHOR.test(t) && GH_TRANSPORT.test(t); };
// A live tick that keeps failing only on GitHub for this long is no longer a blip: it rolls back and latches with a clear reason.
export const LIVE_RETRY_MAX_MS = 24 * 60 * 60 * 1000;
export const PRECHECK_RETRY_MS = 30 * 60 * 1000;
// Issue #302: what a live tick says about the new version. Only a thrown error or a skipped item that is a real fault fails it.
// A lease held by a running job is an expected wait, reported under `waiting` and never `skipped`; an item flagged `expected`
// is ignored too. Items needing the homeowner are reported under `blocked`: they are the condition, not a fault of the code.
export function liveTickOutcome(tick) {
  if (tick?.error) return { ok: false, reason: tick.error };
  const faults = Array.isArray(tick?.skipped) ? tick.skipped.filter(item => !item?.expected) : [];
  return faults.length ? { ok: false, reason: faults[0]?.reason, reasons: faults.map(f => f?.reason) } : { ok: true, reason: null };
}
// Issue #489: the explicit list of paths that do NOT need an install. The list is the only rule: every other path (bin/, supervisor/,
// tools/ outside tools/ci/, a root file that is not *.md, and anything unknown) needs one.
export const NO_INSTALL_PREFIXES = ['tests/', 'docs/', '.github/', 'tools/ci/'];
export const needsNoInstall = file => typeof file === 'string' && !file.includes('..') && (NO_INSTALL_PREFIXES.some(p => file.startsWith(p)) || /^[^/]+\.md$/.test(file));
export const rangeNeedsInstall = files => files.some(f => !needsNoInstall(f));

export const envBackoffMs = attempts => Math.min(ENV_RETRY_MS * 2 ** Math.max(0, (attempts || 1) - 1), ENV_RETRY_MAX_MS);
// Only the bootstrap installer cannot install itself: a change to it is a needs-homeowner card (issue #101). The main upgrader
// (supervisor/upgrade.mjs, tools/upgrade-supervisor.sh, tools/rollback-supervisor.sh) installs like any other reviewed change.
// The exact command printed for a refused update (issue #446).
export const handInstallCommand = sha => `/root/bin/ai-supervisor self-upgrade hand-install ${sha}`;
export const BOOTSTRAP_PATHS = ['tools/bootstrap-install.sh'];
// Exit codes of tools/bootstrap-install.sh.
export const BOOTSTRAP_EXIT = { transient: 10, checks: 11, payload: 12, swap: 13 };
const short = shortCommit;
// Issue #412: the installer prints "tests failed: a; b", then "--- excerpt ---" and a bounded excerpt (see tools/bootstrap-install.sh).
// An older installer prints only the summary ("tests: ..."); that still counts as a test failure but carries no names.
export function parseTestFailure(stderr) {
  const text = String(stderr || '');
  const m = /^tests failed: (.*)$/m.exec(text);
  if (!m) return /^tests: /m.test(text) ? { kind: 'tests', tests: [], excerpt: '' } : null;
  const names = redact(m[1], 600).split('; ').map(x => x.trim()).filter(Boolean).slice(0, 6);
  const at = text.indexOf('--- excerpt ---');
  const excerpt = at < 0 ? '' : redactLong(text.slice(at + '--- excerpt ---'.length).replace(/^\r?\n/, '').trimEnd(), 1500, '[excerpt cut]');
  return { kind: 'tests', tests: names, excerpt };
}
const isTestFailure = r => !!r && r.ok === false && !r.environmental && r.kind === 'tests' && !r.retried;
const failureFields = r => (r.kind === 'tests' ? { tests: (r.tests || []).slice(0, 5), excerpt: String(r.excerpt || '').slice(0, 1500), ...(r.retried ? { retried: true } : {}) } : {});
const excerptNote = r => (r.kind === 'tests' && r.excerpt ? `\nFailure output (excerpt):\n${String(r.excerpt).slice(0, 600)}` : '');
const testsOf = x => (x?.tests?.length ? x.tests.join('; ') : null);

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
// Issue #209: `revive` ({host, port, argv, version}: the last server seen answering) lets the tick watchdog start a server that is
// not running at all, and `force` restarts one that is on the right version but does not answer. Without them nothing running means
// nothing to do (the upgrade path never starts a dashboard that was not there). A start that fails or does not answer is tried once
// more, then the last good command line is started again, so the dashboard is not left down.
export async function restartDashboardServer(sha, { procRoot = '/proc', wrapper = '/root/bin/ai-supervisor', kill = (pid, sig) => process.kill(pid, sig), start, startOld, health, sleep = ms => new Promise(r => setTimeout(r, ms)), tries = 50, settleMs = 1500, settleProbes = 3, settleProbeMs = 2000, settleMaxMs = 60000, settleMinMs = 10000, restartMaxMs = 150000, recoverMaxMs = 30000, now = Date.now, logMark = defaultLogMark, logTail = defaultLogTail, revive = null, force = false } = {}) {
  const startedAt = now();
  const found = findDashboards(procRoot);
  if (!found.length && !revive) return { ok: true, restarted: false, reason: 'no dashboard server was running' };
  if (found.length && !force && found.every(d => d.version === sha)) return { ok: true, restarted: false, reason: 'already on the new version' };
  const old = found.find(d => IPV4.test(d.host || '') && /^\d+$/.test(d.port || '')) || found[0] || revive;
  if (!IPV4.test(old.host || '')) return { ok: false, reason: 'the running dashboard server has no readable --host, so it cannot be restarted the same way' };
  for (const d of found) { try { kill(d.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') return { ok: false, reason: `could not stop dashboard pid ${d.pid}: ${error.code || 'error'}` }; } }
  const gone = () => { try { return found.every(d => { try { kill(d.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }); } catch { return false; } };
  for (let i = 0; i < tries && !gone(); i++) await sleep(200);
  if (!gone()) return { ok: false, reason: 'the old dashboard server did not stop' };
  const args = ['dashboard', 'serve', '--host', old.host, ...(old.port ? ['--port', old.port] : [])];
  // The port cannot be shared, so the old process had to stop first. If the new one does not come up healthy, it is stopped and the
  // old version is started again with its own original command line, so the dashboard is serving again (issue #135).
  const healthPort = old.port || process.env.DASHBOARD_PORT || '8731';
  // Issue #725: an overall deadline (restartMaxMs) bounds the start attempts, not only the settle wait: every health probe is cut off
  // when it arrives, and no further attempt starts after it. Recovery has its own budget (recoverMaxMs) so the old version still gets
  // a fair chance to come back after the deadline has been used up.
  const deadline = startedAt + restartMaxMs;
  const probe = async until => {
    const left = until - now(); if (left <= 0 || !health) return false;
    let timer; const cut = new Promise(r => { timer = setTimeout(() => r(false), left); });
    try { return await Promise.race([Promise.resolve().then(() => health(old.host, healthPort)).catch(() => false), cut]); } finally { clearTimeout(timer); }
  };
  const recover = async why => {
    const fresh = findDashboards(procRoot).filter(d => d.version === sha);
    for (const d of fresh) { try { kill(d.pid, 'SIGTERM'); } catch { /* already gone */ } }
    for (let i = 0; i < tries && !fresh.every(d => { try { kill(d.pid, 0); return false; } catch (error) { return error.code === 'ESRCH'; } }); i++) await sleep(200);
    let back = false;
    if (old.argv?.length) {
      try { (startOld || defaultStartArgv)(old.argv); back = true; } catch { back = false; }
      if (back && health) { back = false; const until = now() + recoverMaxMs; for (let j = 0; j < tries && !back && now() < until; j++) { back = await probe(until); if (!back) await sleep(200); } }
    }
    return { ok: false, recovered: back, reason: `${why}; the new process was stopped and ${back ? `the old version${old.version ? ` ${short(old.version)}` : ''} is serving again` : 'the old version could NOT be started again, so nothing is serving now'}` };
  };
  // Issue #193: a process that exists (or answered once) may still exit straight away, e.g. EADDRINUSE or a bad --host. After it
  // looks up, wait a short grace period and require it to still be running (and, with a health check, still answering).
  // Issue #632: under heavy load a healthy server can take seconds to build its first view, so one failed probe is not a failure.
  // After the grace period the process must still exist, and (with a health check) answer `settleProbes` probes in a row; a probe
  // that fails while the process is still running is retried until `settleMaxMs`. A process that has exited fails at once.
  const alive = () => findDashboards(procRoot).some(d => d.version === sha);
  const settled = async () => {
    await sleep(Math.max(0, Math.min(settleMs, deadline - now())));
    if (!alive()) return { cause: 'exited' };
    if (!health) return { ok: true };
    // Bounded by elapsed time, probe duration included: each probe is cut off when the deadline arrives.
    // Issue #810: the window is capped by the overall deadline but never shorter than settleMinMs, so a healthy server that answers
    // late is not rolled back before it could show a stable streak. The window actually used is reported.
    const began = now();
    const until = Math.max(Math.min(began + settleMaxMs, deadline), began + Math.min(settleMinMs, settleMaxMs));
    let streak = 0;
    for (let i = 0, rounds = Math.max(settleProbes, Math.ceil(settleMaxMs / Math.max(1, settleProbeMs))); i < rounds; i++) {
      if (i) { const gap = until - now(); if (gap <= 0) break; await sleep(Math.min(settleProbeMs, gap)); }
      if (!alive()) return { cause: 'exited' };
      if (until - now() <= 0) break;
      const ok = await probe(until);
      streak = ok ? streak + 1 : 0;
      if (streak >= settleProbes) return { ok: true };
    }
    return { cause: 'unresponsive', windowMs: until - began };
  };
  const failWith = async (cause, text, mark) => {
    let said = ''; try { said = redactAddresses(redact((await logTail(mark)) || '', 600)).trim(); } catch { said = ''; }
    return { fail: text, cause, ...(said ? { output: said } : {}) };
  };
  const afterSettle = async mark => {
    const r = await settled();
    if (r.ok) return up;
    return r.cause === 'exited'
      ? failWith('exited', `the dashboard server on ${short(sha)} ${health ? 'answered but did not stay up (the process exited after start)' : 'did not stay running'}`, mark)
      : failWith('unresponsive', `the dashboard server on ${short(sha)} is running but stopped answering its health check for ${Math.max(1, Math.round((r.windowMs ?? settleMaxMs) / 1000))} s`, mark);
  };
  const up = { ok: true, restarted: true, host: old.host, port: old.port };
  const attempt = async () => {
    let mark = null; try { mark = await logMark(); } catch { mark = null; }
    try { (start || defaultStart)(wrapper, args); } catch (error) { return { fail: `could not start the dashboard server: ${String(error?.message || error).slice(0, 120)}` }; }
    for (let i = 0; i < tries && now() < deadline; i++) {
      if (findDashboards(procRoot).some(d => d.version === sha)) {
        // Health check (issue #135): the new process must answer, not merely exist. Retried while it binds its port.
        if (!health) return afterSettle(mark);
        for (let j = 0; j < tries && now() < deadline; j++) { if (await probe(deadline)) return afterSettle(mark); if (!alive()) return failWith('exited', `the dashboard server on ${short(sha)} exited before it answered its health check`, mark); await sleep(200); }
        return failWith('unresponsive', `the dashboard server started on ${short(sha)} but did not answer its health check`, mark);
      }
      await sleep(200);
    }
    return { fail: `the dashboard server did not come back on ${short(sha)}` };
  };
  let res = await attempt();
  if (!res.fail) return res;
  // Issue #209: one more try with the new version before falling back to the last good one.
  const stopNew = async () => {
    for (const d of findDashboards(procRoot).filter(x => x.version === sha)) { try { kill(d.pid, 'SIGTERM'); } catch { /* already gone */ } }
    for (let i = 0; i < tries && findDashboards(procRoot).some(d => d.version === sha); i++) await sleep(200);
  };
  const first = res.fail, firstCause = res.cause, firstOutput = res.output;
  await stopNew();
  const retried = now() < deadline;
  if (retried) res = await attempt();
  if (!res.fail) return res;
  const out = res.output || firstOutput;
  const r = await recover(`${res.fail} (${retried ? `tried twice; first: ${first}` : 'tried once (overall deadline reached)'})${out ? `; the new process said: ${out.slice(0, 200)}` : ''}`);
  return { ...r, cause: res.cause || firstCause, ...(out ? { output: out } : {}) };
}
// Issue #632: why a failed restart failed, kept in the record: a cause ('exited' or 'unresponsive') and what the new process wrote to
// the dashboard log since it was started (redacted, at most 600 characters). A detached server's exit code is not observable, so the
// output is the evidence of why it exited.
const failDetail = r => (r && !r.ok ? { ...(r.cause ? { cause: r.cause } : {}), ...(r.output ? { output: redact(r.output, 600) } : {}) } : {});
const dashboardLogFile = () => (process.env.NODE_TEST_CONTEXT && !process.env.DASHBOARD_LOG ? null : (process.env.DASHBOARD_LOG || DASHBOARD_LOG));
function defaultLogMark() { try { const f = dashboardLogFile(); return f ? fs.statSync(f).size : 0; } catch { return 0; } }
function defaultLogTail(mark) {
  const f = dashboardLogFile(); if (!f) return '';
  let fd; try {
    fd = fs.openSync(f, 'r'); const size = fs.fstatSync(fd).size, from = Math.max(Number(mark) || 0, size - 4096);
    if (size <= from) return '';
    const buf = Buffer.alloc(size - from); fs.readSync(fd, buf, 0, buf.length, from);
    return buf.toString('utf8').trim().split('\n').slice(-8).join(' | ');
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
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
  // Issue #448: a test run must never start the real server or append to the live log. Under the node test runner the caller has to
  // inject its own start, or set DASHBOARD_LOG to a file of its own; reaching this default without either is a bug in the test.
  if (process.env.NODE_TEST_CONTEXT && !process.env.DASHBOARD_LOG) throw new Error('refusing to start the real dashboard server from a test run');
  let fd = null; try { fd = fs.openSync(process.env.DASHBOARD_LOG || DASHBOARD_LOG, 'a', 0o600); } catch { fd = null; }
  const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME || '/root', ...(process.env.DASHBOARD_PORT ? { DASHBOARD_PORT: process.env.DASHBOARD_PORT } : {}) };
  try { spawn(cmd, args, { detached: true, stdio: fd === null ? 'ignore' : ['ignore', fd, fd], env }).unref(); } finally { if (fd !== null) fs.closeSync(fd); }
};
const defaultStartArgv = argv => dashboardSpawn(argv[0], argv.slice(1));
const defaultStart = (wrapper, args) => dashboardSpawn(wrapper, args);

// What the team step receives from the upgrade step (issues #134, #191): a hold only when this old process just made an install (upgraded); every other outcome, rolled-back and failures included, lets dispatch go ahead.
// Issue #845: why a merged commit is not installed yet, by step result, in terms of the rule (no fixed wait is involved).
export const NEXT_INSTALL_WHY = {
  'not-eligible': 'the merged range is not eligible yet: a pull request in it still lacks a passing independent review or green checks',
  'precheck-failed': 'the pre-install validator or tests failed (or could not run); retried with backoff or when main moves',
  'github-unreachable': 'GitHub could not be read; retried with backoff',
  'upgrader-changed': 'the range changes the bootstrap installer, which needs the homeowner to hand-install it',
  latched: 'the rollback latch is set; installs after the homeowner clears it',
};
export const holdOf = (result, s) => (result === 'upgraded' ? { to: s?.pending?.to || null } : null);

export class SelfUpgrade {
  constructor({ root, deps, clock = { now: () => Date.now() }, drainMaxMs = QUIET_MAX_WAIT_MS, minGapMs = MIN_INSTALL_GAP_MS, lock = null, lockWaitMs = 30000, lockSleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }) {
    this.lock = lock; this.lockWaitMs = lockWaitMs; this.lockSleep = lockSleep;   // issue #798: lock() returns an unlock function, or null while another process holds upgrade.lock
    this.root = root; this.d = deps; this.clock = clock; this.drainMaxMs = drainMaxMs; this.minGapMs = minGapMs;   // issue #136: the configurable drain bound; issue #695: minGapMs is the batching window between installs (0 = off)
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
  // Issue #412: the first run failed and the repeat in a fresh copy passed. Recorded with the test names; one alert per target.
  async noteFlaky(target, first, stage) {
    this.s.flaky = { sha: target, at: this.clock.now(), stage, tests: (first.tests || []).slice(0, 5), excerpt: String(first.excerpt || '').slice(0, 1500) };
    this.save();
    this.record({ to: target, result: 'flaky_test', stage, reason: first.reason, tests: this.s.flaky.tests, excerpt: this.s.flaky.excerpt });
    await this.alert(`${target}:flaky`, `Supervisor upgrade to ${short(target)}: ${stage} tests failed once and passed on the repeat in a fresh copy (flaky: ${testsOf(first) || 'test name not reported'}). The install went ahead.`);
  }
  noteInstall(i) { this.s.install = { at: this.clock.now(), ...i }; }
  save() { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); atomicJson(this.stateFile, this.s); }
  latch() { try { return JSON.parse(fs.readFileSync(this.latchFile, 'utf8')); } catch { return fs.existsSync(this.latchFile) ? { reason: 'unreadable latch' } : null; } }
  clearLatch() { fs.rmSync(this.latchFile, { force: true }); }
  installCommand(target) {
    let url = null; try { url = this.d.remoteUrl?.(); } catch { url = null; }
    return handInstallCommand(target);
  }
  noteMain(from, target) {
    if (!SHA.test(target || '')) return;
    let behind = null; if (from === target) behind = 0; else { try { const n = this.d.commitsBehind?.(from, target); if (Number.isSafeInteger(n) && n >= 0) behind = n; } catch { behind = null; } }
    const m = this.s.main;
    if (m && m.sha === target && m.from === from && m.behind === behind) return;
    this.s.main = { sha: target, from, behind, at: this.clock.now() }; this.save();
  }
  // Issue #488: a refused upgrade (not eligible, diverged, or a non-environmental check failure) is one Needs you item for this target
  // until the installed commit or main moves. Environmental failures never come here; they stay a supervisor health warning.
  refuse(from, to, kind, reason) {
    const r = refusalText(reason), old = this.s.refusal;
    if (old && old.from === from && old.to === to && old.kind === kind && old.reason === r) return r;
    this.s.refusal = { from, to, kind, reason: r, at: this.clock.now() }; this.save();
    return r;
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

  // Issue #695: when the batching window since the last finished install ends (null = no window: first install, or min_install_gap_minutes 0).
  // It survives a restart because lastFinishedAt is in the state file; lastUpgradeAt covers state written before the field existed.
  batchDueAt() {
    const last = this.s.lastFinishedAt ?? this.s.lastUpgradeAt;
    return this.minGapMs > 0 && Number.isFinite(last) ? last + this.minGapMs : null;
  }
  // Issue #695: the homeowner asks for the next install to skip the batching window (CLI: self-upgrade install-now).
  // Issue #708: refused when the install is already current (nothing to install, so the request would linger and skip a later window);
  // a request not spent within URGENT_REQUEST_MAX_MS lapses. Urgency is spent only by an install (or lapses / is dropped when current).
  // Issue #798: the CLI's read-then-write of the state file runs under upgrade.lock (the tick holds it for its whole step), so a tick that
  // loaded its copy earlier cannot write it back over this change. Waits up to lockWaitMs; held:false means the lock could not be taken.
  withStateLock(fn) {
    if (!this.lock) return { held: true, value: fn() };
    const end = Date.now() + this.lockWaitMs; let unlock = this.lock();
    while (!unlock && Date.now() < end) { this.lockSleep(250); unlock = this.lock(); }
    if (!unlock) return { held: false };
    try { return { held: true, value: fn() }; } finally { unlock(); }
  }
  rereadState() {
    // Built from the file alone: a key the daemon deleted since this object was built must not come back on save.
    try { this.s = { alerted: {}, prechecked: {}, ...JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) }; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  // Main as seen now: a live fetch, falling back to the main recorded at the last tick (which can be one tick old); null if neither is known.
  currentMain() {
    try { const t = this.d.fetchMain?.(); if (SHA.test(t || '')) return t; } catch { /* use the recorded main */ }
    const m = this.s.main; return m && SHA.test(m.sha || '') ? m.sha : null;
  }
  // The urgent.to target is shown for information only: a request stays in force until an install spends it, it lapses, or main is current.
  requestInstallNow() {
    const r = this.withStateLock(() => {
      this.rereadState();
      const from = this.d.installed(), main = this.currentMain();
      if (!main) return { ok: false, reason: 'main is not known yet (GitHub unreachable and no tick has recorded it); try again shortly' };
      if (main === from) return { ok: false, reason: 'the installed version is already main; nothing to install' };
      this.s.urgent = { reason: 'homeowner request', at: this.clock.now(), to: main }; this.save();
      return { ok: true };
    });
    return r.held ? r.value : { ok: false, reason: 'an install step holds upgrade.lock; try again in a minute' };
  }
  // The urgent request as status shows it: the same lapse rule as urgentNow, without changing the state.
  urgentView(now = this.clock.now()) {
    const u = this.s.urgent;
    if (!u) return null;
    return u.reason === 'homeowner request' && !(now - u.at < URGENT_REQUEST_MAX_MS) ? null : u;
  }
  // The urgent request in force, or null. A homeowner request lapses after URGENT_REQUEST_MAX_MS; a rollback's urgency does not.
  urgentNow(now) {
    const u = this.s.urgent;
    if (!u) return null;
    if (u.reason === 'homeowner request' && !(now - u.at < URGENT_REQUEST_MAX_MS)) { delete this.s.urgent; this.save(); return null; }
    return u;
  }
  // Issue #708: a hand-install finished: the batching window is measured from it, and a pending install-now is spent.
  // Rereads the state file first, since the CLI object may be older than the daemon's last write.
  noteHandInstalled() {
    const apply = () => { this.rereadState(); this.s.lastFinishedAt = this.clock.now(); delete this.s.urgent; delete this.s.nextInstall; this.save(); };
    // Issue #798: under upgrade.lock, so no tick is mid-step with an older copy. If the lock stays busy the update still goes ahead (the
    // reread builds the state from the latest file, then the note sets its own fields); losing it would leave the batching window wrong.
    if (!this.withStateLock(apply).held) apply();
  }

  // Returns a short result string for the tick report. Issue #845: running jobs never delay an install, so nothing waits on them; the
  // dashboard's "Next install" names the rule that is holding the install (never a fixed time), from NEXT_INSTALL_WHY or the batching rule.
  async step() {
    const dp = this.s.dashboardPending;
    if (dp && !this.s.pending) await this.restartDashboard({ from: dp.from, to: dp.to }, dp.rollingBack === true);
    const result = await this.stepInner();
    if (this.s.holding) { delete this.s.holding; this.save(); }   // state written by a version that still drained
    const why = NEXT_INSTALL_WHY[result];
    if (why) { this.s.nextInstall = { to: this.s.main?.sha || null, at: null, why, state: result.slice(0, 12) }; this.save(); }
    else if (result !== 'batched' && this.s.nextInstall) { delete this.s.nextInstall; this.save(); }
    return result;
  }
  async stepInner() {
    if (this.latch()) return 'latched';
    if (this.s.pending) return 'awaiting-verification';
    const from = this.d.installed();
    if (!from) return 'not-versioned';
    // Issue #995: a halt or breaker that cleared re-arms every wait, the install's included, so nothing waits on a backoff earned before the recovery.
    { const re = rearmUpgradeState(this.s, readRearm(this.root), this.clock.now()); if (re.length) { this.s.rearmed = { at: this.clock.now(), items: re }; this.save(); } }
    if (this.s.lastUpgradeAt && this.clock.now() - this.s.lastUpgradeAt < MIN_UPGRADE_INTERVAL_MS) {
      // Issue #331: the rate limit holds back the upgrade, not the display. Refresh main every tick so the header never claims "Up to date" on a stale ref.
      if (!(this.s.fetchRetryAt && this.clock.now() < this.s.fetchRetryAt)) { try { this.noteMain(from, this.d.fetchMain()); } catch { const n = (this.s.fetchFailures || 0) + 1; this.s.fetchFailures = n; this.s.fetchRetryAt = this.clock.now() + envBackoffMs(n); this.save(); /* display only: back off like the upgrade path */ } }
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
    if (this.s.refusal && (this.s.refusal.from !== from || this.s.refusal.to !== target)) { delete this.s.refusal; this.save(); }   // issue #488: the installed commit or main moved
    if (this.s.handDeploy && this.s.handDeploy.from !== from) { delete this.s.handDeploy; this.save(); }   // the installed commit moved: the item is done
    if (!SHA.test(target || '') || target === from) { if (this.s.urgent?.reason === 'homeowner request') delete this.s.urgent; this.save(); return 'current'; }
    if (!this.d.isAncestor(from, target)) {
      await this.alert(`${target}:diverged`, `Supervisor self-upgrade skipped: installed ${short(from)} is not an ancestor of main ${short(target)}.`);
      const why = this.refuse(from, target, 'diverged', `installed ${short(from)} is not an ancestor of main ${short(target)}`);
      if (this.s.divergedRecorded !== target) { this.s.divergedRecorded = target; this.save(); this.record({ from, to: target, result: 'refused', kind: 'diverged', reason: why }); }
      return 'diverged';
    }
    const files = this.d.changedFiles(from, target);
    if (!rangeNeedsInstall(files)) return 'no-supervisor-change';   // issue #489: only the no-install list exempts a path
    const touched = files.filter(f => BOOTSTRAP_PATHS.includes(f));
    if (touched.length) {
      await this.alert(`${target}:upgrader`, `Supervisor upgrade to ${target}: needs the homeowner: changes the bootstrap installer (${touched.join(', ')}), which cannot install itself. Not upgraded automatically. To install it, paste on Tower: ${this.installCommand(target)} (it pauses starts, drains jobs, installs with validator and tests, checks dry-run, dashboard and the next live tick, rolls back on any failure, and always resumes).`);
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
      this.record({ from, to: target, prs: eligibility.prs, result: 'refused', kind: 'not-eligible', reason: this.refuse(from, target, 'not-eligible', eligibility.reason) });
      return 'not-eligible';
    }
    if (this.s.refusal?.kind === 'not-eligible') { delete this.s.refusal; this.save(); }
    const now = this.clock.now();
    // A failed check latches this commit until a newer main; an environmental failure is retried after ENV_RETRY_MS (#69).
    // Checked before the quiet wait so a latched target never holds dispatch for a commit that will not be installed (#134).
    const latched = this.s.prechecked[target];
    const retryDue = typeof latched === 'number' && !this.s.precheckRetried?.[target] && now - latched >= PRECHECK_RETRY_MS;
    if (latched && !retryDue && !(latched.environmental && now - latched.at >= envBackoffMs(latched.attempts))) return 'precheck-failed';
    // Issue #845: no drain. A running job needs nothing from the install: each version is its own immutable directory under versions/<sha>
    // and the install only repoints `current`, so a running worker keeps executing the files it started from, and the tick (ingest, post-
    // conditions, rebase checks) always runs the installed code against job records that older workers wrote. The install therefore happens
    // in this tick whatever is running, and new jobs start on the new code from the next tick (the install wakes one at once).
    // Optional batching (issue #695, off by default): with self_upgrade.min_install_gap_minutes above 0, a merge waits for the window
    // since the last finished install while work is running or planned; nothing running and nothing planned installs at once.
    const running = await this.d.activeJobs();
    const dueAt = this.batchDueAt(), urgent = this.urgentNow(now);
    if (!urgent && dueAt != null && now < dueAt) {
      let planned = 0; if (running === 0) { try { planned = Number(await this.d.plannedWork?.()) || 0; } catch { planned = 0; } }
      if (running > 0 || planned > 0) {
        const why = `batching is on (self_upgrade.min_install_gap_minutes ${Math.round(this.minGapMs / 60000)}): installs when the window since the last install ends (about ${Math.max(1, Math.round((dueAt - now) / 60000))} min), or sooner when nothing is running or planned`;
        this.s.nextInstall = { to: target, at: null, why, state: 'batched' }; this.save();
        return 'batched';
      }
    }
    const checks = { eligibility: 'ok', quiet: running > 0 ? 'jobs-running-unaffected' : 'idle' };
    let pre = await this.d.preChecks(target);
    // Issue #412: a failed test run is repeated once in a fresh clean copy (each installer call takes its own) before the commit is
    // latched. It runs here, in this tick, before dispatch, so no job can be starting while it runs.
    let flaky = null;
    if (isTestFailure(pre)) {
      const first = pre;
      pre = await this.d.preChecks(target);
      if (pre.ok) flaky = first; else if (isTestFailure(pre)) pre = { ...pre, retried: true };
    }
    if (!pre.ok) {
      const attempts = pre.environmental ? (latched?.environmental ? (latched.attempts || 1) + 1 : 1) : 0;
      this.s.prechecked[target] = pre.environmental ? { at: now, environmental: true, attempts } : now;
      this.s.precheckRetried = this.retriedFor(target, retryDue);   // one delayed retry per commit, kept across environmental outcomes
      this.noteInstall(pre.environmental
        ? { result: 'transient', sha: target, reason: pre.reason, attempts, nextAttemptAt: now + envBackoffMs(attempts) }
        : { result: 'blocked', sha: target, reason: pre.reason, ...failureFields(pre) });
      this.save();
      await this.alert(`${target}:precheck`, `Supervisor upgrade to ${short(target)} not done: pre-check failed (${pre.reason}).${excerptNote(pre)}`);
      if (!pre.environmental) this.refuse(from, target, 'precheck', pre.reason);
      this.record({ from, to: target, prs: eligibility.prs, checks: { ...checks, preChecks: 'failed' }, result: 'precheck_failed', reason: pre.environmental ? pre.reason : refusalText(pre.reason), ...failureFields(pre) });
      return 'precheck-failed';
    }
    checks.preChecks = flaky ? 'ok-after-retry' : 'ok';
    if (flaky) await this.noteFlaky(target, flaky, 'pre-check');
    // The rate-limit stamp is written before the upgrade, so a crash mid-upgrade cannot cause an immediate second attempt.
    this.s.lastUpgradeAt = now; delete this.s.urgent; delete this.s.nextInstall; this.save();
    let up = await this.d.upgrade(target);
    if (isTestFailure(up)) {   // the same single repeat for a failure at install time, before anything was swapped
      const first = up;
      up = await this.d.upgrade(target);
      if (up.ok) { checks.installChecks = 'ok-after-retry'; await this.noteFlaky(target, first, 'install'); } else if (isTestFailure(up)) up = { ...up, retried: true };
    }
    if (!up.ok && up.environmental) {
      // The clean copy could not be taken at install time (GitHub unreachable): nothing was swapped, so retry, do not roll back.
      const attempts = (latched?.environmental ? (latched.attempts || 1) : 0) + 1;
      this.s.prechecked[target] = { at: now, environmental: true, attempts }; delete this.s.lastUpgradeAt;
      this.s.precheckRetried = this.retriedFor(target, retryDue);
      this.noteInstall({ result: 'transient', sha: target, reason: up.reason, attempts, nextAttemptAt: now + envBackoffMs(attempts) }); this.save();
      this.record({ from, to: target, prs: eligibility.prs, checks, result: 'precheck_failed', reason: up.reason });
      return 'precheck-failed';
    }
    if (!up.ok && up.blocked) {
      // The install-time validator, tests or payload check failed before anything was swapped: block only this commit until a newer
      // main, with one alert. No rollback and no global latch (#101).
      this.s.prechecked[target] = now; delete this.s.lastUpgradeAt;
      this.s.precheckRetried = this.retriedFor(target, retryDue);
      this.noteInstall({ result: 'blocked', sha: target, reason: up.reason, ...failureFields(up) }); this.save();
      await this.alert(`${target}:precheck`, `Supervisor upgrade to ${short(target)} not done: install-time check failed (${up.reason}).${excerptNote(up)}`);
      this.refuse(from, target, 'install-check', up.reason);
      this.record({ from, to: target, prs: eligibility.prs, checks: { ...checks, installChecks: 'failed' }, result: 'precheck_failed', reason: refusalText(up.reason), ...failureFields(up) });
      return 'precheck-failed';
    }
    if (!up.ok) {
      const rb = await this.rollback(from, target, `upgrade script failed: ${up.reason}`, eligibility.prs, checks);
      return rb;
    }
    const dry = await this.d.dryRunTick();
    if (!dry.ok) return this.rollback(from, target, `team tick --dry-run failed: ${dry.reason}`, eligibility.prs, { ...checks, dryRun: 'failed' });
    checks.dryRun = 'ok';
    await this.noteMcp(from, target, files);
    this.s.pending = { from, to: target, prs: eligibility.prs, checks, at: now };
    this.noteInstall({ result: 'installed', sha: target, reason: null }); this.save();
    this.record({ from, to: target, prs: eligibility.prs, checks, result: 'upgraded' });
    await this.alert(`${target}:upgraded`, `Supervisor upgraded to ${short(target)} (${await this.prNames(eligibility.prs)}).`);
    return 'upgraded';
  }

  // Issue #946: the swap also updates the MCP server copy when foreman-mcp/ changed. That step never undoes the supervisor swap; its
  // installer restores the previous copy on failure and the outcome is read here: a failure is recorded and alerted once per target.
  async noteMcp(from, target, files) {
    if (typeof this.d.mcpResult !== 'function') return;
    let r = null; try { r = await this.d.mcpResult(target); } catch { r = null; }
    const changed = mcpNeedsInstall(files);
    if (!r || r.sha !== target) {
      if (!changed) return;   // nothing in foreman-mcp/ moved and the installer recorded nothing: no news
      r = { result: 'failed', reason: 'the installer left no result for this commit' };
    }
    if (r.result === 'skipped' && !changed) return;   // not configured (a configured but missing copy is "failed", which alerts)
    this.s.mcp = { sha: target, result: r.result, reason: String(r.reason || '').slice(0, 200), at: this.clock.now() };
    this.save();
    this.record({ from, to: target, result: r.result === 'failed' ? 'mcp_install_failed' : 'mcp_install', reason: this.s.mcp.reason, mcpChanged: changed });
    if (r.result === 'failed') await this.alert(`${target}:mcp`, `Foreman MCP server not updated to ${short(target)}: ${this.s.mcp.reason}. The previous copy was kept and still works; Foreman itself installed. Check docs/foreman-mcp.md.`);
  }

  // The delayed retry is spent once used or already recorded for this commit; only a different target clears it.
  retriedFor(target, retryDue) { return retryDue || this.s.precheckRetried?.[target] ? { [target]: true } : {}; }

  // `ok` is false when the live tick threw or reported skipped items; `running` is the sha this process runs from.
  async verifyPending({ running, ok, reason, reasons }) {
    const p = this.s.pending;
    if (!p) return null;
    const now = this.clock.now();
    if (running !== p.to) {
      if (now - p.at < VERIFY_MAX_WAIT_MS) return 'awaiting-verification';
      return this.rollback(p.from, p.to, 'no live tick ran under the new version within an hour', p.prs, { ...p.checks, liveTick: 'missing' });
    }
    const all = Array.isArray(reasons) && reasons.length ? reasons : [reason];   // every fault of the tick must be a GitHub connection error
    const githubOnly = !ok && all.every(isGithubConnectionError);
    if (githubOnly && p.liveRetry && now - (p.liveRetry.since ?? p.liveRetry.at) >= LIVE_RETRY_MAX_MS)
      return this.rollback(p.from, p.to, `live tick still failing on GitHub connection errors after ${Math.round(LIVE_RETRY_MAX_MS / 3600000)} h: ${String(reason).slice(0, 120)}`, p.prs, { ...p.checks, liveTick: 'failed' });
    if (githubOnly) {
      // Back off like clone and fetch failures: ticks inside the window are not judged; the first passing tick verifies at once.
      const r = p.liveRetry;
      if (r && now < r.retryAt) return 'awaiting-verification';
      const attempts = (r?.attempts || 0) + 1, retryAt = now + envBackoffMs(attempts), why = `GitHub unreachable during the live tick: ${String(reason).slice(0, 120)}`;
      this.s.pending = { ...p, liveRetry: { attempts, at: now, since: r?.since ?? now, retryAt, reason: why } };
      this.noteInstall({ result: 'transient', sha: p.to, attempts, reason: why, nextAttemptAt: retryAt }); this.save();
      this.record({ from: p.from, to: p.to, prs: p.prs, checks: { ...p.checks, liveTick: 'retry' }, result: 'live_tick_retry', reason: why, attempts });
      return 'awaiting-verification';
    }
    const real = all.find(r => !isGithubConnectionError(r)) ?? reason;   // name the first fault that is not a connection error
    if (!ok) return this.rollback(p.from, p.to, `live tick failed: ${String(real || 'error').slice(0, 160)}`, p.prs, { ...p.checks, liveTick: 'failed' });
    delete this.s.pending; this.s.lastFinishedAt = now; this.noteInstall({ result: 'verified', sha: p.to, reason: null }); this.save();
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
    this.record({ from: p.from, to: p.to, result: r.ok ? 'dashboard_restarted' : 'dashboard_restart_failed', reason: r.ok ? (r.restarted ? null : r.reason) : r.reason, ...(r.ok && r.restarted ? { restarted: true } : {}), ...failDetail(r) });
    delete this.s.dashboardPending;
    // Issue #209: a failed restart (or a fall back to the last good version) is a Needs you item; a later good restart clears it.
    if (!r.ok) this.s.dashboardFailure = { at: this.clock.now(), kind: rollingBack ? 'rollback' : 'upgrade', target: target, reason: String(r.reason || 'unknown').slice(0, 300), recovered: r.recovered === true, ...failDetail(r) };
    else if (r.restarted) delete this.s.dashboardFailure;
    this.save();
    if (!r.ok) await this.alert(`${p.to}:dashboard${rollingBack ? ':rollback' : ''}`, `Dashboard server was not restarted on ${short(target)} after the ${rollingBack ? 'rollback' : 'upgrade'}: ${r.reason}. Check the dashboard and restart it by hand if needed (the page shows "restart pending" until then).`);
  }

  // Issue #209: every tick checks that the dashboard server answers and starts it again if it does not, whatever the cause (a crash,
  // a failed upgrade restart, a killed process). It runs from the tick, which does not depend on the dashboard. Restarts are
  // throttled with a growing delay so a crash loop is not restarted on every tick; the delay resets after a quiet half hour.
  // A server that was never seen answering is not started (the host and port are unknown), and nothing runs while an upgrade
  // is waiting for its verification (the restart after that does the job).
  async watchdog() {
    if (typeof this.d.dashboardStatus !== 'function' || typeof this.d.restartDashboard !== 'function') return null;
    if (this.s.pending || this.s.dashboardPending) return 'skipped';
    const now = this.clock.now();
    let st; try { st = await this.d.dashboardStatus(); } catch { return 'error'; }
    const w = this.s.dashboardWatch || {};
    if (st.running && st.healthy) {
      let changed = false;
      const g = st.good, o = this.s.dashboardGood;
      if (g && (!o || o.version !== g.version || o.host !== g.host || o.port !== g.port || (o.argv || []).join('\0') !== g.argv.join('\0'))) { this.s.dashboardGood = { host: g.host, port: g.port, version: g.version, argv: g.argv, at: now }; changed = true; }
      if (this.s.dashboardWatch && (!w.lastAt || now - w.lastAt >= WATCHDOG_RESET_MS)) { delete this.s.dashboardWatch; changed = true; }
      else if (w.unhealthySince || w.episodeAt) { this.s.dashboardWatch = { ...w, unhealthySince: undefined, episodeAt: undefined }; changed = true; } // an answering server ends the outage episode
      if (this.s.dashboardFailure?.kind === 'watchdog') { delete this.s.dashboardFailure; changed = true; }
      if (changed) this.save();
      return 'ok';
    }
    // A running process that does not answer may still be starting; it must be seen unhealthy on two ticks before it is restarted.
    if (st.running && !w.unhealthySince) { this.s.dashboardWatch = { ...w, unhealthySince: now }; this.save(); return 'unhealthy-wait'; }
    const revive = this.s.dashboardGood || st.good;
    if (!revive || !IPV4.test(revive.host || '') || !Array.isArray(revive.argv)) return 'unknown';
    const attempts = w.attempts || 0;
    if (w.lastAt && now - w.lastAt < Math.min(WATCHDOG_BASE_MS * 2 ** Math.max(0, attempts - 1), WATCHDOG_MAX_MS)) return 'throttled';
    let sha = null; try { sha = this.d.installed(); } catch { sha = null; }
    if (!SHA.test(sha || '')) return 'not-versioned';
    const episodeAt = w.episodeAt || now;
    this.s.dashboardWatch = { attempts: attempts + 1, lastAt: now, episodeAt };
    this.save();
    let r;
    try { r = await this.d.restartDashboard(sha, { revive, force: true }); } catch (error) { r = { ok: false, reason: String(error?.message || error).slice(0, 160) }; }
    this.record({ from: sha, to: sha, result: r.ok ? 'dashboard_revived' : 'dashboard_revive_failed', reason: r.ok ? null : r.reason, attempt: attempts + 1, ...failDetail(r) });
    // A successful revive ends the outage episode: the next failure is a new outage with its own alert key (throttle counters stay).
    if (r.ok) this.s.dashboardWatch = { ...this.s.dashboardWatch, episodeAt: undefined };
    if (r.ok && r.restarted) { if (this.s.dashboardFailure?.kind === 'watchdog') delete this.s.dashboardFailure; this.save(); return 'revived'; }
    if (r.ok) { this.save(); return 'ok'; }
    this.s.dashboardFailure = { at: now, kind: 'watchdog', target: sha, reason: String(r.reason || 'unknown').slice(0, 300), recovered: r.recovered === true, ...failDetail(r) };
    this.save();
    await this.alert(`dashboard-down:${episodeAt}`, `Dashboard server was not answering and could not be restarted on ${short(sha)}: ${r.reason}. Foreman retries on later ticks with a growing delay; check the dashboard if it stays down.`);
    return 'revive-failed';
  }

  async rollback(from, to, reason, prs, checks) {
    let result = { ok: false, reason: 'rollback not attempted' };
    try { result = await this.d.rollback(from, to); } catch (error) { result = { ok: false, reason: String(error?.message || error).slice(0, 160) }; }
    delete this.s.pending; this.s.lastFinishedAt = this.clock.now(); this.s.urgent = { reason: 'the previous install rolled back', at: this.clock.now() };
    const note = result.ok ? reason : `${reason}; ROLLBACK FAILED (${result.reason}), manual repair needed`;
    this.noteInstall({ result: result.ok ? 'rolled_back' : 'rollback_failed', sha: to, reason: note.slice(0, 200) }); this.save();
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.latchFile, JSON.stringify({ at: this.clock.now(), from, to, reason: note }), { mode: 0o600 });
    this.record({ from, to, prs, checks, result: result.ok ? 'rolled_back' : 'rollback_failed', reason: note });
    // A rollback also restarts the dashboard so the badge and the running commit agree (issue #135); jobs are never touched.
    if (result.ok) await this.restartDashboard({ from: to, to: from }, true);
    await this.alert(`${to}:rolledback`, `Upgrade to ${short(to)} rolled back: ${note}. Automatic upgrades are paused until the homeowner presses Clear latch on the dashboard.`);
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
const defaultRun = (cmd, args, { cwd, timeoutMs = 120000, input, env } = {}) => {
  const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', ...(env?.TMPDIR ? { TMPDIR: env.TMPDIR } : {}) } });
  return { status: r.status ?? (r.error ? 127 : 1), stdout: r.stdout || '', stderr: r.stderr || '' };
};
const tail = r => String(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ').slice(0, 200);

const DRY_RUN_TRIES = 3, DRY_RUN_RETRY_MS = 15000;
function checkDryRun(r) {
  if (r.status !== 0) return { ok: false, reason: tail(r), registerRead: /cannot read docs\/DECISIONS\.md/.test(tail(r)) };
  try {
    const out = JSON.parse(r.stdout);
    if (typeof out?.skipped === 'string' || !Array.isArray(out?.actions)) return { ok: false, reason: 'dry-run did not run a plan' };
  } catch { return { ok: false, reason: 'dry-run output is not JSON' }; }
  return { ok: true };
}
export function realDeps({ root, config, gh, listActive, verdictFor, independenceApproved = () => false, wrapper = '/root/bin/ai-supervisor', run = defaultRun, sendAlert, sleep = ms => new Promise(r => setTimeout(r, ms)), slotOptions = {} }) {
  const repo = config.repo_path;
  const git = (...a) => { const r = run('git', ['-C', repo, ...a]); if (r.status !== 0) throw new Error(`git ${a[0]} failed`); return r.stdout.trim(); };
  const remoteUrl = () => git('remote', 'get-url', 'origin');
  // The bootstrap installer is taken from the installed commit, not the target: it is the one file a range may not change.
  const bootstrap = (mode, sha, timeoutMs, scriptFrom = null) => {
    // Issue #1007: the run's scratch space is a folder on the cache drive (TMPDIR), removed afterwards; with no space the reason says so,
    // and a passing test run that left files in that TMPDIR fails the check.
    const tmp = makeJobTmp(root, `install-${short(sha)}-${process.pid}-${Date.now()}`);
    const pressure = hostPressure({ dirs: [os.tmpdir(), jobTmpRoot(root)] });
    if (pressure.hold && !tmp) return { ok: false, environmental: true, reason: `no space: ${pressureText(pressure)}`.slice(0, 400) };
    const dir = tmp ? fs.mkdtempSync(path.join(tmp, 'self-upgrade-')) : scratch();
    const runEnv = tmp ? { TMPDIR: tmp } : undefined;
    try {
      const from = installedSha(root);
      if (!from) return { ok: false, reason: 'no installed version to take the bootstrap installer from' };
      const script = path.join(dir, 'bootstrap-install.sh');
      // Issue #446: the hand route takes the installer from the target itself (the reviewed commit that changed it).
      if (scriptFrom) git('fetch', '--quiet', 'origin');
      fs.writeFileSync(script, git('show', `${scriptFrom || from}:tools/bootstrap-install.sh`), { mode: 0o700 });
      const r = run('bash', [script, mode, remoteUrl(), sha], { timeoutMs, ...(runEnv ? { env: runEnv } : {}) });
      if (r.status === 0) {
        // Only the pre-swap check judges leftovers: in install mode exit 0 means the new version is already swapped in, so the install stands.
        const left = tmp && mode === 'check' ? fs.readdirSync(tmp).filter(n => path.join(tmp, n) !== dir) : [];
        return left.length ? { ok: false, blocked: true, reason: leakText(left).replace('test run', 'install check') } : { ok: true };
      }
      if (/ENOSPC|No space left/i.test(`${r.stderr || ''}${r.stdout || ''}`)) return { ok: false, environmental: true, reason: `no space left on the device: ${pressureText(pressure)}`.slice(0, 400) };
      const failure = r.status === BOOTSTRAP_EXIT.checks ? parseTestFailure(r.stderr) : null;
      const reason = failure?.tests.length ? `tests failed: ${testsOf(failure)}`.slice(0, 400) : tail(r);
      if (r.status === BOOTSTRAP_EXIT.transient) return { ok: false, environmental: true, reason };
      // Exit 11 (validator/tests) and 12 (payload re-verify) happen before the swap: block the commit, never roll back.
      const blocked = r.status === BOOTSTRAP_EXIT.checks || r.status === BOOTSTRAP_EXIT.payload;
      return { ok: false, ...(blocked ? { blocked: true } : {}), ...(failure ? failure : {}), reason: r.status === BOOTSTRAP_EXIT.payload ? `refused: ${reason}` : reason };
    } catch (error) { return { ok: false, environmental: true, reason: String(error?.message || error).slice(0, 160) }; }
    finally { if (tmp) removeJobTmp(tmp); else fs.rmSync(dir, { recursive: true, force: true }); }
  };
  const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'self-upgrade-'));
  // A slot directory that cannot be made (unwritable state root) is an environmental failure, never a thrown error or a bypass of the limit.
  const slotted = async (label, fn) => {
    try { return await withTestSlot(root, { limit: config.limits?.test_slots ?? DEFAULT_TEST_SLOTS, label, ...slotOptions }, fn); }
    catch (error) { return { ok: false, environmental: true, reason: `test slot unavailable: ${String(error?.message || error).slice(0, 160)}` }; }
  };
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
    // Issue #380: a job paused on a usage limit runs no process, so it does not hold an upgrade in drain; its record survives and its worker (or reconcile) resumes it.
    activeJobs: async () => (await listActive()).filter(j => j.status !== 'paused_limit').length,
    handInstall: async sha => slotted(`install ${short(sha)}`, () => bootstrap('install', sha, 3000000, sha)),
    dueHeld: async () => (await listActive()).filter(j => ['paused_limit', 'queued'].includes(j.status) && j.nextAttemptAt != null && j.nextAttemptAt <= Date.now()).length,
    runningJobs: async () => (await listActive()).filter(j => j.status === 'running').length,
    liveTick: async () => { const r = run(wrapper, ['team', 'tick'], { timeoutMs: 600000 }); if (r.status !== 0) return { error: tail(r) }; try { return JSON.parse(r.stdout); } catch { return { error: 'live tick output is not JSON' }; } },
    // Issue #448: install-time tests take a test slot like every other full suite, so they queue behind the limit instead of piling on.
    preChecks: async sha => slotted(`install check ${short(sha)}`, () => bootstrap('check', sha, 2400000)),
    upgrade: async sha => slotted(`install ${short(sha)}`, () => bootstrap('install', sha, 3000000)),
    // A register read that fails right after an upgrade is usually transient, so it is retried (three tries, backoff) before it can roll back.
    dryRunTick: async () => {
      let result;
      for (let attempt = 0; attempt < DRY_RUN_TRIES; attempt++) {
        if (attempt) await sleep(DRY_RUN_RETRY_MS * attempt);
        result = checkDryRun(run(wrapper, ['team', 'tick', '--dry-run'], { timeoutMs: 180000 }));
        if (result.ok || !result.registerRead) return { ok: result.ok, ...(result.ok ? {} : { reason: result.reason }) };
      }
      return { ok: false, reason: result.reason };
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
    restartDashboard: async (sha, opts = {}) => restartDashboardServer(sha, { wrapper, health: httpHealth, ...opts }),
    dashboardStatus: async () => {
      const found = findDashboards();
      const d = found.find(x => IPV4.test(x.host || '')) || null;
      if (!found.length) return { running: false, healthy: false };
      const healthy = d ? await httpHealth(d.host, d.port || process.env.DASHBOARD_PORT || '8731') : false;
      return { running: true, healthy, good: d ? { host: d.host, port: d.port, version: d.version, argv: d.argv } : null };
    },
    // Issue #946: what tools/install-foreman-mcp.sh recorded for this commit (null when it recorded nothing).
    mcpResult: async sha => { try { const r = JSON.parse(fs.readFileSync(path.join(root, 'team', 'mcp-install.json'), 'utf8')); return r && r.sha === sha ? r : null; } catch { return null; } },
    alert: sendAlert
  };
}
