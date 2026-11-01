// Supervisor health for the dashboard (issue #72): what the overseer used to check by hand on Tower. Read-only and local:
// it reads the reconcile log, the self-upgrade records and state, the lease files, the `current` symlink and the Git ref
// files of config.repo_path. It starts no process (no git, no gh, no model) and writes nothing.
// Everything that came from a log line or an error message passes through scrub(): no secrets, e-mail addresses or IPs.
import fs from 'node:fs';
import path from 'node:path';
import { readLeases, redact } from './dashdata.mjs';
import { worst } from './dashui/logic.mjs';

export const TICK_INTERVAL_MS = 5 * 60000;          // the reconcile cron runs every five minutes
export const TICK_RED_MS = 2 * TICK_INTERVAL_MS;     // "red if more than 2 intervals old"
export const LOG_TAIL_BYTES = 2 * 1024 * 1024;        // the reconcile script trims its log above 1 MiB
const MAX_LINES_PER_TICK = 20;
const SHA = /^[0-9a-f]{40}$/;
const ACTIVE = ['queued', 'running', 'paused_limit', 'paused_manual'];
const short = s => String(s || '').slice(0, 7);
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'unknown');
const mins = ms => (Number.isFinite(ms) ? (ms < 3600000 ? `${Math.round(ms / 60000)}m` : `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`) : 'unknown');

// Log text can carry host addresses; the page must not. redact() handles e-mail addresses and tokens.
export const scrub = (value, max = 300) => redact(String(value ?? '').replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g, '[ip]'), max);

// ---- reconcile.log
// Two line formats exist on Tower: the hot-fixed script writes "<ISO time> tick" followed by the reconcile JSON on its own
// line; tools/install-reconcile-user-script.sh writes "<ISO time> rc=<n> <output tail>" on one line. Anything else
// (stderr of a helper, a stack trace, a bare timestamp) belongs to the tick above it and is a non-JSON line.
const TS = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d))(?:\s+(.*))?$/;
function parseJson(text) { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } }

export function parseReconcileLog(text) {
  const ticks = [];
  let cur = null;
  const open = (at, rc = null) => { cur = { at, rc, result: null, stray: [] }; ticks.push(cur); return cur; };
  const stray = line => { (cur || open(null)).stray.length < MAX_LINES_PER_TICK && cur.stray.push(scrub(line)); };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = TS.exec(line);
    if (m) {
      const at = Date.parse(m[1]), rest = (m[2] || '').trim();
      const rc = /^rc=(\d{1,3})(?:\s+([\s\S]*))?$/.exec(rest);
      if (rc) {
        const t = open(at, Number(rc[1])), out = (rc[2] || '').trim();
        const i = out.indexOf('{"resumed"');
        const obj = i >= 0 ? parseJson(out.slice(i).trim()) : null;
        if (obj) t.result = obj;
        const before = (obj ? out.slice(0, i) : out).trim();
        if (before) t.stray.push(scrub(before));
      } else {
        open(at);
        if (rest && rest !== 'tick') cur.stray.push(scrub(rest));
      }
      continue;
    }
    if (line.startsWith('{')) {
      const obj = parseJson(line);
      if (obj && cur && !cur.result) { cur.result = obj; continue; }
      if (obj) { open(cur?.at ?? null).result = obj; continue; }
    }
    stray(line);
  }
  return ticks.map(summariseTick);
}

const refOf = a => (Number.isSafeInteger(a?.pr) ? a.pr : Number.isSafeInteger(a?.issue) ? a.issue : null);
function summariseTick(t) {
  const r = t.result || {}, team = r.team && typeof r.team === 'object' ? r.team : {};
  const list = v => (Array.isArray(v) ? v : []);
  const actions = list(team.actions).slice(0, 40).map(a => ({ agent: scrub(a.agent || '', 20), type: scrub(a.type || '', 20), ref: refOf(a), pr: Number.isSafeInteger(a.pr) ? a.pr : null, issue: Number.isSafeInteger(a.issue) ? a.issue : null }));
  const skipped = list(team.skipped).slice(0, 40).map(s => ({ what: scrub(s?.what ?? s, 120), reason: scrub(s?.reason ?? '', 240) }));
  const ingested = list(team.ingested).slice(0, 40).map(i => ({ job: /^[a-f0-9]{32}$/.test(i?.job || '') ? i.job : null, pr: Number.isSafeInteger(i?.pr) ? i.pr : null, verdict: scrub(i?.verdict || '', 20) }));
  const released = list(team.released).filter(id => /^[a-f0-9]{32}$/.test(id));
  const selfUpgrade = typeof r.selfUpgrade === 'string' ? scrub(r.selfUpgrade, 40) : r.selfUpgrade?.error ? 'error' : null;
  const errors = [...t.stray];
  if (team.error) errors.push(scrub(`team tick: ${team.error}`));
  if (r.selfUpgrade?.error) errors.push(scrub(`self-upgrade: ${r.selfUpgrade.error}`));
  for (const s of skipped) errors.push(scrub(`skipped ${s.what}: ${s.reason}`));
  if (t.rc && !errors.length) errors.push(`reconcile exited rc=${t.rc}`);
  const note = typeof team.skipped === 'string' ? scrub(team.skipped, 120) : null;      // "another tick is running", "team loop disabled"
  let status;
  if (team.error || t.stray.length || r.selfUpgrade?.error || (t.rc && t.rc !== 1)) status = 'error';
  else if (skipped.length || t.rc) status = 'partial';
  else if (note) status = 'skipped';
  else if (!t.result) status = 'empty';
  else status = 'ok';
  return { at: Number.isFinite(t.at) ? t.at : null, rc: t.rc, status, note, actions, skipped, ingested, released: released.length, releasedIds: released,
    resumed: Number(r.resumed) || 0, blocked: Number(r.blocked) || 0, selfUpgrade, errors: errors.slice(0, MAX_LINES_PER_TICK) };
}

// One plain line per tick, for the copy-for-overseer text and the tick history.
export function tickLine(t) {
  const parts = [`${iso(t.at)} tick ${t.status}`];
  if (t.note) parts.push(t.note);
  if (t.ingested.length) parts.push(`ingested ${t.ingested.map(i => `${i.verdict} on PR #${i.pr}`).join(', ')}`);
  if (t.actions.length) parts.push(`actions ${t.actions.map(a => `${a.agent} ${a.type} #${a.ref}`).join(', ')}`);
  if (t.released) parts.push(`released ${t.released} lease(s)`);
  if (t.selfUpgrade) parts.push(`self-upgrade ${t.selfUpgrade}`);
  if (t.errors.length) parts.push(`errors: ${t.errors.join(' | ')}`);
  return scrub(parts.join('; '), 600);
}

export function readReconcileLog(root) {
  const file = path.join(root, 'reconcile.log');
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1);          // drop the partial first line
    return parseReconcileLog(text);
  } finally { fs.closeSync(fd); }
}

// ---- self-upgrade records and state
export function readUpgrades(root) {
  let text; try { text = fs.readFileSync(path.join(root, 'team', 'upgrades.jsonl'), 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const out = [];
  for (const line of text.split('\n')) {
    const r = parseJson(line);
    if (!r || typeof r.result !== 'string') continue;
    out.push({ at: Number.isFinite(r.at) ? r.at : null, from: SHA.test(r.from || '') ? r.from : null, to: SHA.test(r.to || '') ? r.to : null,
      prs: (Array.isArray(r.prs) ? r.prs : []).filter(Number.isSafeInteger).slice(0, 30), result: scrub(r.result, 24), reason: r.reason ? scrub(r.reason, 300) : null,
      checks: r.checks && typeof r.checks === 'object' ? Object.fromEntries(Object.entries(r.checks).slice(0, 10).map(([k, v]) => [scrub(k, 20), scrub(v, 24)])) : {},
      files: (Array.isArray(r.files) ? r.files : []).slice(0, 10).map(f => scrub(f, 100)) });
  }
  return out.slice(-500);
}
function readJsonFile(file) {
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof SyntaxError) return { value: null, unreadable: true }; throw error; }
}
export function readSelfUpgrade(root) {
  const st = readJsonFile(path.join(root, 'team', 'self-upgrade.json'))?.value || {};
  const latchFile = readJsonFile(path.join(root, 'team', 'self-upgrade.latch'));
  const prechecked = Object.entries(st.prechecked && typeof st.prechecked === 'object' ? st.prechecked : {}).filter(([sha, at]) => SHA.test(sha) && Number.isFinite(at)).map(([sha, at]) => ({ sha, at })).sort((a, b) => b.at - a.at);
  const latch = latchFile ? { at: Number.isFinite(latchFile.value?.at) ? latchFile.value.at : null, from: SHA.test(latchFile.value?.from || '') ? latchFile.value.from : null, to: SHA.test(latchFile.value?.to || '') ? latchFile.value.to : null, reason: scrub(latchFile.value?.reason || (latchFile.unreadable ? 'unreadable latch file' : 'no reason recorded'), 300) } : null;
  const p = st.pending;
  return { prechecked, latch, lastUpgradeAt: Number.isFinite(st.lastUpgradeAt) ? st.lastUpgradeAt : null, waitingSince: Number.isFinite(st.waitingSince) ? st.waitingSince : null,
    pending: p && SHA.test(p.to || '') ? { from: SHA.test(p.from || '') ? p.from : null, to: p.to, at: Number.isFinite(p.at) ? p.at : null } : null };
}
export function readInstalled(root) {
  try {
    const link = fs.readlinkSync(path.join(root, 'current'));
    const m = /^versions\/([0-9a-f]{40})$/.exec(link);
    return { sha: m ? m[1] : null, at: fs.lstatSync(path.join(root, 'current')).mtimeMs };
  } catch (error) { if (['ENOENT', 'EINVAL'].includes(error.code)) return { sha: null, at: null }; throw error; }
}

// ---- Git refs by reading files only (loose ref, then packed-refs), so the page never starts git.
function gitDirs(repo) {
  const dotGit = path.join(repo, '.git');
  let st; try { st = fs.statSync(dotGit); } catch { return null; }
  let gitDir = dotGit;
  if (st.isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8')); if (!m) return null;
    gitDir = path.resolve(repo, m[1].trim());
  }
  let common = gitDir;
  try { common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()); } catch { /* not a linked worktree */ }
  return { gitDir, common };
}
export function readGitRef(repo, ref, depth = 0) {
  if (!path.isAbsolute(repo || '') || !/^(HEAD|refs\/(heads|remotes)\/[\w.\/-]{1,100})$/.test(ref) || ref.includes('..') || depth > 3) return null;
  const dirs = gitDirs(repo); if (!dirs) return null;
  const base = ref === 'HEAD' ? dirs.gitDir : dirs.common;
  let text = null; try { text = fs.readFileSync(path.join(base, ref), 'utf8').trim(); } catch { /* maybe packed */ }
  if (text?.startsWith('ref: ')) return readGitRef(repo, text.slice(5).trim(), depth + 1);
  if (text && SHA.test(text)) return text;
  try {
    for (const line of fs.readFileSync(path.join(dirs.common, 'packed-refs'), 'utf8').split('\n')) { const [sha, name] = line.trim().split(' '); if (name === ref && SHA.test(sha)) return sha; }
  } catch { /* no packed refs */ }
  return null;
}
export function readHeadBranch(repo) {
  const dirs = path.isAbsolute(repo || '') ? gitDirs(repo) : null; if (!dirs) return null;
  try { const t = fs.readFileSync(path.join(dirs.gitDir, 'HEAD'), 'utf8').trim(); return t.startsWith('ref: refs/heads/') ? scrub(t.slice(16), 100) : SHA.test(t) ? `detached at ${short(t)}` : null; } catch { return null; }
}
function fetchedAt(repo) {
  const dirs = path.isAbsolute(repo || '') ? gitDirs(repo) : null; if (!dirs) return null;
  try { return fs.statSync(path.join(dirs.gitDir, 'FETCH_HEAD')).mtimeMs; } catch { return null; }
}

// ---- the five cards
// Self-upgrade step result (the `selfUpgrade` field of the last tick) -> severity and a plain explanation.
const UPGRADE_STEP = {
  current: ['ok', 'installed version is origin/main'], 'no-supervisor-change': ['ok', 'main is ahead with no supervisor change'], verified: ['ok', 'upgrade verified by a live tick'],
  upgraded: ['ok', 'upgraded; waiting for a live tick to verify it'], 'awaiting-verification': ['info', 'upgraded; waiting for a live tick to verify it'],
  busy: ['info', 'upgrade waits for running jobs (at most 30 minutes)'], 'rate-limited': ['info', 'at most one upgrade per hour; waiting'],
  'precheck-failed': ['warning', 'pre-checks failed for this main; waits for a newer main'], 'not-eligible': ['warning', 'main has a change without a recorded PASS and green CI'],
  'upgrader-changed': ['warning', 'main changes the upgrader itself: deploy by hand'], diverged: ['warning', 'installed version is not an ancestor of main'],
  'not-versioned': ['warning', 'the installed supervisor is not a versioned install'], latched: ['action', 'automatic upgrades are paused by the rollback latch'],
  'rolled-back': ['action', 'the last upgrade was rolled back'], 'rollback-failed': ['action', 'a rollback failed: manual repair needed'], error: ['warning', 'the self-upgrade step raised an error']
};
const RESULT_SEV = { upgraded: 'ok', verified: 'ok', refused: 'warning', precheck_failed: 'warning', rolled_back: 'action', rollback_failed: 'action' };
export const resultSeverity = r => RESULT_SEV[r] || 'info';

function versionCard({ installed, origin, upgrades, su, lastTick, now }) {
  const last = upgrades.at(-1) || null;
  const step = lastTick?.selfUpgrade || null;
  const levels = [];
  const notes = [];
  if (su.latch) { levels.push('action'); notes.push(`rollback latch set${su.latch.at ? ` ${iso(su.latch.at)}` : ''}: ${su.latch.reason}`); }
  if (step) { const [lv, text] = UPGRADE_STEP[step] || ['info', `self-upgrade step: ${step}`]; levels.push(lv); notes.push(text); }
  if (last && ['rolled_back', 'rollback_failed'].includes(last.result)) levels.push(resultSeverity(last.result));
  const latchedMain = origin && su.prechecked.find(p => p.sha === origin);
  if (latchedMain) { levels.push('warning'); notes.push(`origin/main ${short(origin)} failed its pre-check ${iso(latchedMain.at)}; it is not retried`); }
  if (!installed.sha) { levels.push('warning'); notes.push('no versioned install found (the current symlink is missing)'); }
  const behind = installed.sha && origin && installed.sha !== origin;
  if (behind && !step) { levels.push('info'); notes.push('installed differs from origin/main; no tick has reported the upgrade step yet'); }
  return { id: 'version', title: 'Version', severity: worst(levels.length ? levels : ['info']),
    summary: !installed.sha ? 'Installed version unknown' : !origin ? `Installed ${short(installed.sha)}; origin/main unknown` : behind ? `Installed ${short(installed.sha)}, origin/main ${short(origin)}` : `Installed ${short(installed.sha)} = origin/main`,
    installed: installed.sha, installedAt: installed.at, origin, behind: !!behind, step, notes,
    lastUpgrade: last, latch: su.latch, prechecked: su.prechecked.slice(0, 5).map(p => ({ ...p, isMain: p.sha === origin })), pending: su.pending, lastUpgradeAt: su.lastUpgradeAt };
}

function lastTickCard({ ticks, now }) {
  const t = ticks.filter(x => Number.isFinite(x.at)).at(-1) || null;
  if (!t) return { id: 'tick', title: 'Last tick', severity: 'action', summary: 'No tick in the reconcile log', tick: null, ageMs: null, stale: true, notes: ['the reconcile log is missing or holds no tick'] };
  const ageMs = Math.max(0, now - t.at), stale = ageMs > TICK_RED_MS;
  const sev = stale || t.status === 'error' ? 'action' : t.status === 'partial' ? 'warning' : t.status === 'empty' ? 'warning' : 'ok';
  const notes = [];
  if (stale) notes.push(`no tick for ${mins(ageMs)}: more than two five-minute intervals; the reconcile cron may have stopped`);
  if (t.status === 'empty') notes.push('the last tick wrote no result line');
  return { id: 'tick', title: 'Last tick', severity: sev, summary: `${t.status} ${mins(ageMs)} ago`, tick: t, ageMs, stale, notes };
}

function leasesCard({ leases, jobs, config, now }) {
  const byId = new Map(jobs.map(j => [j.id, j]));
  const agentOf = j => Object.entries(config.agents || {}).find(([, a]) => a.provider === j?.provider)?.[0] || j?.provider || null;
  const groups = new Map();
  for (const l of leases) { const g = groups.get(l.job) || { job: l.job, count: 0, at: null }; g.count++; if (Number.isFinite(l.at)) g.at = Math.min(g.at ?? l.at, l.at); groups.set(l.job, g); }
  const rows = [...groups.values()].map(g => {
    const j = byId.get(g.job);
    let state = 'active', reason = 'held by an active job';
    if (!j) { state = 'stale'; reason = 'no job record exists for this lease'; }
    else if (['completed', 'stopped'].includes(j.status)) { state = 'stale'; reason = `job is ${j.status} but its lease was not released`; }
    else if (['blocked', 'failed'].includes(j.status)) { state = 'held'; reason = `job is ${j.status}; the lease is kept until the homeowner decides`; }
    else if (!ACTIVE.includes(j.status)) { state = 'stale'; reason = `job status ${scrub(j.status, 20)}`; }
    return { job: /^[a-f0-9]{32}$/.test(g.job) ? g.job : scrub(g.job, 40), files: g.count, at: g.at, ageMs: Number.isFinite(g.at) ? now - g.at : null, agent: agentOf(j), kind: j?.kind || null, ref: j?.issue ?? null, status: j?.status || 'missing', state, reason,
      command: j && ['completed', 'stopped', 'blocked', 'failed'].includes(j.status) ? `ai-supervisor release ${g.job}` : null };
  }).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
  const stale = rows.filter(r => r.state === 'stale'), held = rows.filter(r => r.state === 'held');
  return { id: 'leases', title: 'Leases', severity: stale.length ? 'action' : held.length ? 'warning' : 'ok',
    summary: rows.length ? [`${rows.length} job${rows.length === 1 ? ' holds' : 's hold'} leases`, stale.length ? `${stale.length} stale` : null, held.length ? `${held.length} held by a stopped job` : null].filter(Boolean).join(', ') : 'No lease held', leases: rows, stale: stale.length, held: held.length,
    notes: stale.length ? ['a stale lease blocks new jobs for that issue or worktree ("already leased; stale lease requires explicit recovery")'] : [] };
}

function errorsCard({ ticks, upgrades, installed, now }) {
  const lastUp = upgrades.filter(u => ['upgraded', 'rolled_back', 'rollback_failed'].includes(u.result) && Number.isFinite(u.at)).at(-1)?.at ?? null;
  const since = Math.max(Number.isFinite(installed.at) ? installed.at : -Infinity, Number.isFinite(lastUp) ? lastUp : -Infinity);
  const from = Number.isFinite(since) ? since : null;
  const lines = [];
  for (const t of ticks) if (from === null || (Number.isFinite(t.at) && t.at >= from)) for (const e of t.errors) lines.push({ at: t.at, text: e });
  const latest = lines.at(-1) || null;
  const lastTick = ticks.filter(x => Number.isFinite(x.at)).at(-1);
  const current = !!latest && !!lastTick && latest.at === lastTick.at;
  return { id: 'errors', title: 'Errors', severity: !lines.length ? 'ok' : current ? 'action' : 'warning',
    summary: lines.length ? `${lines.length} error line${lines.length === 1 ? '' : 's'} since ${from === null ? 'the log began' : 'the last upgrade'}` : `No error since ${from === null ? 'the log began' : 'the last upgrade'}`,
    since: from, count: lines.length, latest, recent: lines.slice(-10).reverse(), current, notes: current ? ['the latest tick still reports this error'] : [] };
}

function driftCard({ repo, now }) {
  const local = readGitRef(repo, 'refs/heads/main'), origin = readGitRef(repo, 'refs/remotes/origin/main'), head = readHeadBranch(repo), fetched = fetchedAt(repo);
  const notes = [];
  let severity = 'ok';
  if (!local || !origin) { severity = 'info'; notes.push('the refs of the local repository could not be read'); }
  else if (local !== origin) { severity = 'warning'; notes.push('local main differs from origin/main: the dispatcher plans from this checkout (relevant until issue #69 is fixed)'); }
  if (head && head !== 'main') { severity = worst([severity, 'warning']); notes.push(`the local repository has ${head} checked out, not main`); }
  return { id: 'drift', title: 'Local repo drift', severity, summary: !local || !origin ? 'Local refs unknown' : local === origin ? `main = origin/main (${short(local)})` : `main ${short(local)} differs from origin/main ${short(origin)}`,
    local, origin, head, fetchedAt: fetched, notes };
}

export function supervisorHealth({ root, config, jobs, now }) {
  const ticks = readReconcileLog(root) || [];
  const upgrades = readUpgrades(root), su = readSelfUpgrade(root), installed = readInstalled(root);
  const origin = readGitRef(config.repo_path, 'refs/remotes/origin/main');
  const tick = lastTickCard({ ticks, now });
  const cards = [
    versionCard({ installed, origin, upgrades, su, lastTick: tick.tick, now }),
    tick,
    leasesCard({ leases: readLeases(root), jobs, config, now }),
    errorsCard({ ticks, upgrades, installed, now }),
    driftCard({ repo: config.repo_path, now })
  ];
  return { cards, severity: worst(cards.map(c => c.severity)), ticks: ticks.slice(-1000), upgrades, logFound: ticks.length > 0 };
}

// ---- "Copy for overseer": a compact plain-text block. Built only from scrubbed, bounded fields; no worktree path,
// prompt, session id, ticket or provider output is included.
const LEVEL = { action: 'Action needed', warning: 'Warning', info: 'Info', ok: 'OK' };
export function jobSummary(j) {
  if (!j) return null;
  const p = j.postcondition || null;
  const pc = p ? [p.kind, Number.isSafeInteger(p.pr) ? `PR #${p.pr}` : null, SHA.test(p.head || '') ? `head ${short(p.head)}` : null, SHA.test(p.baseHead || '') ? `from ${short(p.baseHead)}` : null, p.branch ? `branch ${scrub(p.branch, 100)}` : null].filter(Boolean).join(' ') : 'none';
  return scrub(`Job ${j.id}: status ${j.status}, kind ${j.kind || 'job'}, provider ${j.provider}, ref #${j.issue ?? '?'}, attempts ${j.attempts || 0}, last event ${j.lastEvent || 'none'}, postcondition ${pc}, updated ${iso(j.updatedAt)}`, 500);
}
export const jobPr = j => (j ? (Number.isSafeInteger(j.postcondition?.pr) ? j.postcondition.pr : ['implement', 'continue'].includes(j.kind) ? null : (Number.isSafeInteger(j.issue) ? j.issue : null)) : null);
export function latestVerdict(state, pr, cache) {
  if (!Number.isSafeInteger(pr)) return null;
  const entries = Object.entries(state?.verdicts || {}).filter(([k]) => k.split(':')[0] === String(pr)).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  if (!entries.length) return `PR #${pr} latest review: none recorded`;
  const [key, v] = entries[0], head = key.split(':')[1] || '';
  const cur = (cache?.pulls || []).find(p => p.number === pr)?.headRefOid;
  const blocking = (Array.isArray(v.findings) ? v.findings : []).filter(f => f?.kind === 'blocking').length;
  return scrub(`PR #${pr} latest review: ${v.verdict || '?'} by ${v.reviewer || '?'} at ${short(head)}${cur ? (cur === head ? ' (current head)' : ` (head is now ${short(cur)})`) : ''}, ${iso(v.at)}${blocking ? `, ${blocking} blocking finding(s)` : ''}`, 300);
}
// Log ticks that mention a job id or a PR/issue number.
export function relevantTicks(ticks, { job = null, ref = null } = {}, max = 5) {
  const hit = t => (job && (t.releasedIds.includes(job) || t.ingested.some(i => i.job === job) || t.errors.some(e => e.includes(job))))
    || (Number.isSafeInteger(ref) && (t.actions.some(a => a.ref === ref || a.pr === ref || a.issue === ref) || t.ingested.some(i => i.pr === ref) || t.skipped.some(s => new RegExp(`(^|\\D)${ref}(\\D|$)`).test(s.what))));
  return ticks.filter(hit).slice(-max).map(tickLine);
}
export function overseerText({ title, severity, problem, facts = [], job = null, verdict = null, log = [], command = null, now }) {
  const out = [`DevTest overseer note, ${iso(now)}`, `${title}: ${LEVEL[severity] || severity}`, `What is wrong: ${problem}`];
  for (const f of facts) if (f) out.push(`- ${f}`);
  if (job) out.push(job);
  if (verdict) out.push(verdict);
  if (command) out.push(`Command: ${command}`);
  out.push(log.length ? 'Log (reconcile.log):' : 'Log (reconcile.log): no related line');
  for (const l of log) out.push(`  ${l}`);
  return out.map(l => scrub(l, 700)).join('\n').slice(0, 4000);
}

const factsOf = c => {
  switch (c.id) {
    case 'version': return [`installed ${c.installed ? short(c.installed) : 'unknown'}${c.installedAt ? ` since ${iso(c.installedAt)}` : ''}`, `origin/main ${c.origin ? short(c.origin) : 'unknown'}`,
      c.lastUpgrade ? `last self-upgrade record: ${c.lastUpgrade.result} ${short(c.lastUpgrade.from)} -> ${short(c.lastUpgrade.to)} ${iso(c.lastUpgrade.at)}${c.lastUpgrade.reason ? ` (${c.lastUpgrade.reason})` : ''}` : 'no self-upgrade record',
      ...c.prechecked.map(p => `pre-check latched for ${short(p.sha)} at ${iso(p.at)}${p.isMain ? ' (this is origin/main)' : ''}`), ...(c.latch ? [`latch: ${c.latch.reason}`] : [])];
    case 'tick': return c.tick ? [`last tick ${iso(c.tick.at)} (${mins(c.ageMs)} ago), status ${c.tick.status}`, `${c.tick.ingested.length} verdict(s) ingested, ${c.tick.actions.length} action(s), ${c.tick.skipped.length} skipped`,
      ...c.tick.skipped.map(s => `skipped ${s.what}: ${s.reason}`)] : [];
    case 'leases': return c.leases.filter(l => l.state !== 'active').map(l => `lease of job ${l.job} (${[l.agent || 'unknown agent', l.kind, l.ref !== null ? `#${l.ref}` : null].filter(Boolean).join(' ')}), age ${mins(l.ageMs)}: ${l.reason}`);
    case 'errors': return c.recent.slice(0, 5).map(e => `${iso(e.at)}: ${e.text}`);
    case 'drift': return [`local main ${c.local ? short(c.local) : 'unknown'}`, `origin/main ${c.origin ? short(c.origin) : 'unknown'}${c.fetchedAt ? ` (last fetch ${iso(c.fetchedAt)})` : ''}`, c.head ? `checked out: ${c.head}` : null];
    default: return [];
  }
};
export function cardOverseer(c, { ticks, jobs, state, cache, now }) {
  const byId = new Map(jobs.map(j => [j.id, j]));
  let log = [], job = null, verdict = null, command = null;
  if (c.id === 'tick' || c.id === 'version') log = ticks.slice(-3).map(tickLine);
  if (c.id === 'errors') log = ticks.filter(t => t.errors.length && (c.since === null || (Number.isFinite(t.at) && t.at >= c.since))).slice(-5).map(tickLine);   // the card's own window
  if (c.id === 'leases') {
    const bad = c.leases.find(l => l.state !== 'active');
    if (bad) { const j = byId.get(bad.job); job = jobSummary(j); verdict = latestVerdict(state, jobPr(j), cache); command = bad.command; log = relevantTicks(ticks, { job: bad.job, ref: j?.issue }); }
  }
  if (c.id === 'version') command = 'ai-supervisor self-upgrade status';
  const problem = c.severity === 'ok' ? `nothing; ${c.summary}` : [c.summary, ...c.notes].join('; ');
  return overseerText({ title: `Supervisor ${c.title}`, severity: c.severity, problem, facts: factsOf(c), job, verdict, log, command, now });
}
// For an Action needed item (attention id job-<id>, homeowner-<n>, tick-failed, …).
export function attentionOverseer(a, { ticks, jobs, state, cache, now, command }) {
  let job = null, verdict = null, log = [];
  const m = /^job-([a-f0-9]{32})$/.exec(a.id || '');
  if (m) { const j = jobs.find(x => x.id === m[1]); job = jobSummary(j) || `Job ${m[1]}: no record`; verdict = latestVerdict(state, jobPr(j), cache); log = relevantTicks(ticks, { job: m[1], ref: j?.issue }); }
  else if (a.ref) { verdict = a.ref.kind === 'pull' ? latestVerdict(state, a.ref.n, cache) : null; log = relevantTicks(ticks, { ref: a.ref.n }); }
  else if (/^tick/.test(a.id || '')) log = ticks.slice(-3).map(tickLine);
  return overseerText({ title: 'Action needed', severity: a.severity || 'action', problem: a.text, job, verdict, log, command, now });
}
