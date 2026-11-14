// Issue #625: install history and breaker history as bounded, redacted, read-only records for the Foreman MCP tools (D-030).
// The MCP account cannot read the state root, so the dashboard serves these from its existing GET handler (two narrow routes,
// /api/installs.json and /api/breaker.json). They only read: the upgrade records, the self-upgrade state, the `current` link,
// /proc command lines (never the environment, never printed) and the breaker state. No model call, no lock, no write.
import { gbpAmount } from './money.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { readUpgrades, readSelfUpgrade, readInstalled, scrub } from './suphealth.mjs';
import { readVersion, readTeamState } from './dashdata.mjs';
import { redact } from './redact.mjs';

export const INSTALLS_KEPT = 40;
export const BREAKER_KEPT = 100;
const SHA = /^[0-9a-f]{40}$/;
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const FAILED = new Set(['precheck_failed', 'flaky_test', 'rolled_back', 'rollback_failed', 'dashboard_restart_failed', 'dashboard_revive_failed', 'refused']);

// The role is the subcommand (first argument after cli.mjs), not a later argument that happens to share a word.
const cliRole = sub => sub === 'dashboard' ? 'dashboard' : sub === 'worker' ? 'worker' : sub === 'team' || sub === 'reconcile' ? 'foreman' : 'supervisor-cli';
// The version each Foreman process was started from, read from its command line only: a path under `versions/<40 hex>/`.
// The command line itself is never returned (it can hold anything); only the role, pid, version and start tick are.
export function processVersions(procRoot = '/proc', { currentSha = null } = {}) {
  let names; try { names = fs.readdirSync(procRoot).filter(n => /^[1-9]\d*$/.test(n)); } catch { return []; }
  const out = [];
  for (const n of names) {
    let raw; try { raw = fs.readFileSync(path.join(procRoot, n, 'cmdline'), 'latin1'); } catch { continue; }
    const args = raw.split('\0').filter(Boolean).slice(0, 12);
    let script = args.find(a => /\/versions\/[0-9a-f]{40}\/.*\.mjs$/.test(a)), version = null;
    if (!script) {
      // The Foreman tick runs from the current symlink: resolve it to the version it points at, else the installed version.
      script = args.find(a => /\/current\/.*\.mjs$/.test(a));
      if (!script) continue;
      try { version = /\/versions\/([0-9a-f]{40})(?:\/|$)/.exec(fs.realpathSync(script))?.[1] || null; } catch { /* not on this host */ }
      version ||= currentSha;
      if (!version) continue;
    }
    const m = /\/(?:versions\/[0-9a-f]{40}|current)\/(?:.*\/)?([\w.-]+)\.mjs$/.exec(script);
    if (!m) continue;
    version ||= /\/versions\/([0-9a-f]{40})\//.exec(script)[1];
    const base = m[1], rest = args.slice(args.indexOf(script) + 1);
    const role = /^dash(server|board)$/.test(base) ? 'dashboard' : /worker/.test(base) ? 'worker'
      : base === 'cli' ? cliRole(rest[0])
      : scrub(base, 32);
    out.push({ role, pid: Number(n), version });
  }
  return out.sort((a, b) => a.role.localeCompare(b.role) || a.pid - b.pid).slice(0, 60);
}

export function installs(root, { now = Date.now(), procRoot = '/proc', running } = {}) {
  const ver = readVersion(root, running === undefined ? { now } : { running, now });
  const su = readSelfUpgrade(root), inst = readInstalled(root);
  let state = {}; try { state = JSON.parse(fs.readFileSync(path.join(root, 'team', 'self-upgrade.json'), 'utf8')) || {}; } catch { /* none */ }
  const records = readUpgrades(root).slice(-INSTALLS_KEPT).reverse().map(r => ({ at: iso(r.at), from: r.from, to: r.to, prs: r.prs, result: r.result, failed: FAILED.has(r.result), reason: r.reason, checks: r.checks, files: r.files }));
  readUpgrades(root).slice(-INSTALLS_KEPT).reverse().forEach((r, n) => { records[n].attempt = r.attempt ?? null; });   // issue #1368
  const f = state.refusal, i = su.install;
  return {
    note: 'Install records come from team/upgrades.jsonl and self-upgrade.json. Process versions are read from each process command line under versions/<sha>/ (the command line itself is not returned). Evidence, not a remote check.',
    installed: inst.sha, main: ver?.main && SHA.test(ver.main) ? ver.main : null, behind: ver?.behind ?? null, drift: !!ver?.drift, nextInstall: ver?.nextInstall ? { at: iso(ver.nextInstall.at), why: scrub(ver.nextInstall.why, 200), state: ver.nextInstall.state } : null,
    latch: su.latch ? { at: iso(su.latch.at), from: su.latch.from, to: su.latch.to, reason: su.latch.reason } : null,
    lastInstall: i ? {
      result: i.result, sha: i.sha, at: iso(i.at), nextAttemptAt: iso(i.nextAttemptAt), reason: i.reason,
      cleanup: i.cleanup || null, attempt: i.attempt ?? null, failingTests: i.tests, retried: i.retried, excerpt: i.excerpt
    } : null,
    refusal: f && SHA.test(f.to || '') ? { kind: scrub(f.kind || '', 24), from: SHA.test(f.from || '') ? f.from : null, to: f.to, at: iso(f.at), reason: scrub(f.reason || '', 300) } : null,
    processes: processVersions(procRoot, { currentSha: inst.sha }).map(p => ({ ...p, matchesInstalled: inst.sha ? p.version === inst.sha : null })),
    recent: records,
  };
}

// Every circuit-breaker trip: cause, jobs, cost and when it happened and cleared. Trips are recorded in breaker.history by the
// breaker itself; a trip that predates that record is shown from the halt still in force (no cleared time), never invented.
export function breakerHistory(state, limit = 50) {
  const b = state?.breaker || {}, rows = [];
  const seen = new Set();
  for (const t of Array.isArray(b.history) ? b.history : []) {
    if (!t || typeof t !== 'object') continue;
    seen.add(`${t.scope}@${t.since}`);
    rows.push({ scope: redact(String(t.scope || ''), 120), trippedBy: redact(String(t.trippedBy || ''), 24), trippedAt: iso(t.since), clearedAt: iso(t.clearedAt), stillHalted: !Number.isFinite(t.clearedAt),
      jobs: t.jobs ?? 0, tokens: t.tokens ?? 0, costGbpEquivalent: gbpAmount(t.cost) ?? 0, prs: (t.prs || []).slice(0, 20), issues: (t.issues || []).slice(0, 20), types: (t.types || []).slice(0, 8).map(x => redact(String(x), 24)), jobIds: (t.jobIds || []).slice(0, 10).map(x => String(x).slice(0, 32)) });
  }
  const live = [...(b.global ? [{ ...b.global, cause: '@global' }] : []), ...Object.values(b.halts || {})];
  for (const h of live) if (h && !seen.has(`${h.cause}@${h.since}`)) rows.push({ scope: redact(String(h.cause || ''), 120), trippedBy: redact(String(h.trippedBy || ''), 24), trippedAt: iso(h.since), clearedAt: null, stillHalted: true,
    jobs: h.jobs ?? 0, tokens: h.tokens ?? 0, costGbpEquivalent: gbpAmount(h.cost) ?? 0, prs: (h.prs || []).slice(0, 20), issues: (h.issues || []).slice(0, 20), types: (h.types || []).slice(0, 8).map(x => redact(String(x), 24)), jobIds: (h.jobIds || []).slice(0, 10).map(x => String(x).slice(0, 32)) });
  rows.sort((a, c) => (Date.parse(c.trippedAt) || 0) - (Date.parse(a.trippedAt) || 0));
  return { count: rows.length, shown: Math.min(rows.length, limit), halted: rows.some(r => r.stillHalted), note: 'Cost is the provider CLI usage estimate, not a charge. Figures are those at the last update before the halt was cleared.', trips: rows.slice(0, limit) };
}
export const breakerHistoryOf = (root, limit) => breakerHistory(readTeamState(root), limit);
