// Issue #755: the cheap GitHub change check (ETag / If-None-Match) and the replay pass. Unit tests for the check and the client wrapper, in-process
// Team tests for what a replay pass must still do, and real-process tests of `reconcile` against a fake gh that speaks ETags.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseProbe, checkForChanges, cachedGithub, buildCache, loadCache, saveCache, validateChangeCheck, CHANGE_CHECK_DEFAULTS, cacheFile } from '../supervisor/ghchange.mjs';
import { Team, unfinishedChecks } from '../supervisor/team.mjs';
import { stateRoot, createJob, processStart } from '../supervisor/core.mjs';
import { readSnapshots, readCache } from '../supervisor/dashdata.mjs';
import { passStats, renderPassStats } from '../supervisor/idlecause.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = 'o/r', SHA1 = 'a'.repeat(40), SHA2 = 'b'.repeat(40);

// ---- unit: the check ---------------------------------------------------------------------------------------------------------------
const pr = (n, head, extra = {}) => ({ number: n, headRefName: `x/${n}`, headRefOid: head, baseRefName: 'main', mergeable: 'MERGEABLE', ...extra });
const storedFor = (heads, over = {}) => {
  const etags = { issues: '"i1"', pulls: '"p1"', labels: '"l1"', 'issue-comments': '"c1"', 'review-comments': '"r1"', 'ref:main': '"m1"' };
  for (const h of heads) { etags[`runs:${h}`] = `"r-${h.slice(0, 2)}"`; etags[`status:${h}`] = `"s-${h.slice(0, 2)}"`; }
  return { v: 1, repository: REPO, fullAt: 1_000_000, etags, heads, reads: { 'listPulls|[]': heads.map((h, i) => pr(i + 1, h)), 'listIssues|[]': [] }, memo: { files: {}, merged: {} }, ...over };
};
// A fake probe runner over a table key -> etag; a requested ETag equal to the table's gives 304.
function fakeRun(table, { fail = {}, calls = [], pullsBody = '[]' } = {}) {
  const keyOf = url => /issues\?state/.test(url) ? 'issues' : /pulls\?state/.test(url) ? 'pulls' : /\/labels/.test(url) ? 'labels' : /issues\/comments/.test(url) ? 'issue-comments' : /pulls\/comments/.test(url) ? 'review-comments'
    : /git\/ref\/heads\/(.+)$/.test(url) ? `ref:${/git\/ref\/heads\/(.+)$/.exec(url)[1]}` : /commits\/([0-9a-f]{40})\/check-runs/.test(url) ? `runs:${/commits\/([0-9a-f]{40})\//.exec(url)[1]}` : `status:${/commits\/([0-9a-f]{40})\//.exec(url)[1]}`;
  return async (url, etag) => {
    const k = keyOf(url); calls.push({ k, etag });
    if (k in fail) return fail[k];
    const e = table[k]; if (!e) return { status: 404 };
    return etag === e ? { status: 304, etag: e } : { status: 200, etag: e, body: k === 'pulls' ? pullsBody : '[]' };
  };
}
const NOW = 1_000_000 + 5 * 60000, CFG = { ...CHANGE_CHECK_DEFAULTS };

test('parseProbe: status, ETag (weak prefix dropped) and body; no status line is status 0', () => {
  assert.deepEqual(parseProbe('HTTP/2.0 304 Not Modified\r\nEtag: "abc"\r\n\r\n'), { status: 304, etag: '"abc"', body: '' });
  const r = parseProbe('HTTP/2.0 200 OK\netag: W/"xyz"\ncontent-type: application/json\n\n[1,2]');
  assert.equal(r.status, 200); assert.equal(r.etag, '"xyz"'); assert.equal(r.body, '[1,2]');
  assert.equal(parseProbe('[]').status, 0); assert.equal(parseProbe('').status, 0); assert.equal(parseProbe(undefined).status, 0);
});

test('check: every endpoint 304 against a fresh stored state is a replay; every request carries a stored ETag', async () => {
  const calls = [], table = { ...storedFor([SHA1]).etags };
  const r = await checkForChanges({ repository: REPO, prev: storedFor([SHA1]), config: CFG, run: fakeRun(table, { calls }), now: NOW });
  assert.equal(r.replay, true, r.reason); assert.match(r.reason, /unchanged/);
  assert.equal(calls.length, 6 + 2); assert.ok(calls.every(c => c.etag), 'every request is conditional');
  assert.deepEqual(r.baseline.heads, [SHA1]);
});

test('check: each covered input that changes gives a full pass and names it', async () => {
  for (const key of ['issues', 'pulls', 'labels', 'issue-comments', 'review-comments', 'ref:main', `runs:${SHA1}`, `status:${SHA1}`]) {
    const prev = storedFor([SHA1]), table = { ...prev.etags, [key]: '"changed"' };
    const r = await checkForChanges({ repository: REPO, prev, config: CFG, run: fakeRun(table, { pullsBody: JSON.stringify([{ head: { sha: SHA1 } }]) }), now: NOW });
    assert.equal(r.replay, false, key); assert.match(r.reason, /changed/); assert.equal(r.baseline.etags[key], '"changed"', 'the new ETag is the next baseline');
  }
});

test('check: a new head in the PR list is fetched unconditionally and the baseline covers it', async () => {
  const prev = storedFor([SHA1]), table = { ...prev.etags, pulls: '"p2"', [`runs:${SHA2}`]: '"n1"', [`status:${SHA2}`]: '"n2"' };
  const r = await checkForChanges({ repository: REPO, prev, config: CFG, run: fakeRun(table, { pullsBody: JSON.stringify([{ head: { sha: SHA2 } }]) }), now: NOW });
  assert.equal(r.replay, false); assert.deepEqual(r.baseline.heads, [SHA2]); assert.equal(r.baseline.etags[`runs:${SHA2}`], '"n1"');
});

test('check fail-safe: errors, odd statuses, missing state, interval and unknown mergeability all give a full pass, never a replay', async () => {
  const good = () => storedFor([SHA1]), table = good().etags, run = (fail = {}) => fakeRun(table, { fail });
  const full = async (prev, run2, expect, config = CFG, now = NOW) => { const r = await checkForChanges({ repository: REPO, prev, config, run: run2, now }); assert.equal(r.replay, false, r.reason); assert.match(r.reason, expect); return r; };
  await full(null, run(), /no usable stored state/);
  await full(good(), run({ issues: { status: 0, error: 'timeout' } }), /issues: timeout/);
  await full(good(), run({ labels: { status: 500 } }), /labels: HTTP 500/);
  await full(good(), run({ pulls: { status: 403 } }), /HTTP 403/);
  await full(good(), run({ [`runs:${SHA1}`]: { status: 404 } }), /HTTP 404/);
  await full(good(), run({ issues: { status: 200 } }), /no ETag/);
  await full(good(), async () => { throw new Error('boom'); }, /check could not be completed/);
  await full({ ...good(), repository: 'other/repo' }, run(), /another repository/);
  await full(good(), run(), /forced full pass/, CFG, 1_000_000 + 31 * 60000);
  await full(good(), run(), /forced full pass/, { ...CFG, force_full_minutes: 1 }, 1_000_000 + 61000);
  await full(good(), run(), /future/, CFG, 500_000);
  await full(good(), run(), /off/, { ...CFG, enabled: false });
  const unknown = good(); unknown.reads['listPulls|[]'][0].mergeable = 'UNKNOWN'; await full(unknown, run(), /unknown mergeability/);
  const unknown2 = good(); unknown2.reads['listPulls|[]'][0].mergeStateStatus = 'unknown'; await full(unknown2, run(), /unknown mergeability/);
  const incomplete = good(); delete incomplete.reads['listIssues|[]']; await full(incomplete, run(), /incomplete/);
  const many = Array.from({ length: 41 }, (_, i) => i.toString(16).padStart(2, '0').repeat(20));
  await full(storedFor(many), run(), /more than 40 open PRs/);
  const unreadable = await checkForChanges({ repository: REPO, prev: good(), config: CFG, run: fakeRun({ ...table, pulls: '"p2"' }, { pullsBody: 'not json' }), now: NOW });
  assert.equal(unreadable.replay, false); assert.match(unreadable.reason, /unreadable/);
});

test('check: a 304 for a key with no stored ETag is not trusted', async () => {
  const prev = storedFor([SHA1]); delete prev.etags.labels;
  const r = await checkForChanges({ repository: REPO, prev, config: CFG, run: async () => ({ status: 304, etag: '"x"' }), now: NOW });
  assert.equal(r.replay, false); assert.match(r.reason, /304 without a stored ETag/);
});

test('state file: a corrupt, truncated, wrong-version or malformed file reads as no state; a good one round-trips', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(loadCache(root, REPO), null);
  assert.ok(saveCache(root, storedFor([SHA1]))); assert.deepEqual(loadCache(root, REPO).heads, [SHA1]);
  assert.equal(loadCache(root, 'x/y'), null);
  for (const text of ['{', '[]', 'null', JSON.stringify({ ...storedFor([SHA1]), v: 2 }), JSON.stringify({ ...storedFor([SHA1]), etags: { issues: 5 } }), JSON.stringify({ ...storedFor([SHA1]), heads: ['nope'] }), JSON.stringify({ ...storedFor([SHA1]), fullAt: 'x' }), JSON.stringify({ ...storedFor([SHA1]), memo: null })]) {
    fs.writeFileSync(cacheFile(root), text); assert.equal(loadCache(root, REPO), null, text.slice(0, 40));
  }
});

test('config: change_check validates; the defaults are on, 30 minutes, 40 PRs', () => {
  assert.deepEqual({ ...CHANGE_CHECK_DEFAULTS }, { enabled: true, force_full_minutes: 30, max_open_prs: 40, timeout_seconds: 30 });
  validateChangeCheck(undefined); validateChangeCheck({ enabled: false, force_full_minutes: 10 });
  for (const bad of [null, [], { x: 1 }, { enabled: 'yes' }, { force_full_minutes: 0 }, { force_full_minutes: 5000 }, { max_open_prs: 100 }, { max_open_prs: 1.5 }, { timeout_seconds: 0 }]) assert.throws(() => validateChangeCheck(bad), /change_check/, JSON.stringify(bad));
});

// ---- unit: the client wrapper ------------------------------------------------------------------------------------------------------
function countingGh() {
  const n = {}, hit = k => { n[k] = (n[k] || 0) + 1; };
  return {
    n,
    listPulls: async () => { hit('listPulls'); return [pr(1, SHA1)]; }, listIssues: async () => { hit('listIssues'); return [{ number: 5, state: 'OPEN' }]; }, listMergedPulls: async () => { hit('listMergedPulls'); return []; },
    listPullFiles: async () => { hit('listPullFiles'); return ['a.txt']; }, getMergedPull: async p => { hit('getMergedPull'); return { number: p, state: p === 9 ? 'MERGED' : 'OPEN' }; },
    prComments: async () => { hit('prComments'); return [{ body: 'x' }]; }, comment: async () => { hit('comment'); },
    getPull: async () => { hit('getPull'); return pr(1, SHA1); }, hasComment: async () => { hit('hasComment'); return false; }
  };
}
test('wrapper: record stores the first answer of each read; replay serves them with no GitHub call and a copy each time', async () => {
  const raw = countingGh(), rec = cachedGithub(raw, { mode: 'record', cache: null });
  await rec.gh.listPulls(); await rec.gh.listIssues(); await rec.gh.listMergedPulls(); await rec.gh.prComments(1); await rec.gh.listPullFiles(1); await rec.gh.getMergedPull(9); await rec.gh.getMergedPull(10);
  const cache = buildCache({ repository: REPO, baseline: { etags: { issues: '"i"' }, heads: [SHA1] }, wrapper: rec, now: 7 });
  assert.ok(cache); assert.equal(cache.fullAt, 7); assert.deepEqual(cache.memo.files, { [`1:${SHA1}`]: ['a.txt'] }); assert.deepEqual(Object.keys(cache.memo.merged), ['9'], 'only a merged PR is remembered');
  const before = { ...raw.n }, rep = cachedGithub(raw, { mode: 'replay', cache });
  const a = await rep.gh.listPulls(); a[0].number = 99; assert.equal((await rep.gh.listPulls())[0].number, 1, 'a caller cannot change the stored data');
  await rep.gh.listIssues(); await rep.gh.listMergedPulls(); await rep.gh.prComments(1); await rep.gh.listPullFiles(1); await rep.gh.getMergedPull(9);
  assert.deepEqual(raw.n, before, 'nothing reached GitHub'); assert.ok(rep.stats.served >= 5);
  await rep.gh.getMergedPull(10); await rep.gh.prComments(2);
  assert.equal(raw.n.getMergedPull, before.getMergedPull + 1, 'a read that was not stored goes to GitHub'); assert.equal(raw.n.prComments, before.prComments + 1);
});
test('wrapper: reads that are not on the list (getPull, hasComment) always reach GitHub; a write turns the cache off for the rest of the pass', async () => {
  const raw = countingGh(), rec = cachedGithub(raw, { mode: 'record' }); await rec.gh.listPulls(); await rec.gh.listIssues();
  const cache = buildCache({ repository: REPO, baseline: { etags: {}, heads: [SHA1] }, wrapper: rec, now: 1 }), rep = cachedGithub(raw, { mode: 'replay', cache });
  await rep.gh.getPull(1); await rep.gh.hasComment(1, 'm'); assert.equal(raw.n.getPull, 1); assert.equal(raw.n.hasComment, 1);
  const n0 = raw.n.listPulls; await rep.gh.listPulls(); assert.equal(raw.n.listPulls, n0);
  await rep.gh.comment(1, 'x'); await rep.gh.listPulls(); assert.equal(raw.n.listPulls, n0 + 1, 'after a write the next read is fresh');
});
test('wrapper: a failed read, a missing list or a head mismatch stores nothing', async () => {
  const raw = countingGh(); raw.listIssues = async () => { throw new Error('gh failed'); };
  const rec = cachedGithub(raw, { mode: 'record' }); await rec.gh.listPulls(); await assert.rejects(rec.gh.listIssues(), /gh failed/);
  assert.equal(buildCache({ repository: REPO, baseline: { etags: {}, heads: [SHA1] }, wrapper: rec, now: 1 }), null);
  const ok = countingGh(), r2 = cachedGithub(ok, { mode: 'record' }); await r2.gh.listPulls(); assert.equal(buildCache({ repository: REPO, baseline: { etags: {}, heads: [SHA1] }, wrapper: r2, now: 1 }), null, 'no issue list read');
  await r2.gh.listIssues(); assert.equal(buildCache({ repository: REPO, baseline: { etags: {}, heads: [SHA2] }, wrapper: r2, now: 1 }), null, 'the baseline heads are not the heads that were read');
  assert.ok(buildCache({ repository: REPO, baseline: { etags: {}, heads: [SHA1] }, wrapper: r2, now: 1 }));
});
test('memo mode: file lists and merged PRs are remembered across passes without any replay', async () => {
  const raw = countingGh(), rec = cachedGithub(raw, { mode: 'record' }); await rec.gh.listPulls(); await rec.gh.listIssues(); await rec.gh.listPullFiles(1); await rec.gh.getMergedPull(9);
  const cache = buildCache({ repository: REPO, baseline: { etags: {}, heads: [SHA1] }, wrapper: rec, now: 1 });
  const m = cachedGithub(raw, { mode: 'memo', cache }); await m.gh.listPulls(); await m.gh.listPullFiles(1); await m.gh.getMergedPull(9);
  assert.equal(raw.n.listPullFiles, 1); assert.equal(raw.n.getMergedPull, 1); assert.equal(raw.n.listPulls, 2, 'the lists themselves are read in memo mode');
});

// ---- in-process: what a replay pass still does -------------------------------------------------------------------------------------
const H = n => String(n).repeat(40).slice(0, 40);
const teamConfig = () => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2, chain_seconds: 240 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } } });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
function teamWorld(t, { pulls, issues = [], active = [], clock = { now: () => 1000 } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-team-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], reads: 0 }, jobs = { active, states: {}, seq: 0, listActive: async () => jobs.active, get: async id => jobs.states[id] || null, create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const base = { listPulls: async () => { calls.reads++; return pulls; }, listIssues: async () => { calls.reads++; return issues; }, listMergedPulls: async () => { calls.reads++; return []; },
    getPull: async n => pulls.find(p => p.number === n) || null, comment: async (n, b) => { calls.comments.push([n, b]); }, hasComment: async () => false, findIssueByMarker: async () => null, createIssue: async () => 1, board: async () => {} };
  const make = gh => new Team({ config: teamConfig(), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock });
  return { dir, calls, base, jobs, make };
}
test('replay pass: the planner reads nothing from GitHub, and a pass that plans nothing ends at once, flagged no-op, without the chain window', async t => {
  const w = teamWorld(t, { pulls: [{ number: 10, title: 't', headRefName: 'feature/x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [] }], active: [{ id: 'j1', provider: 'claude', status: 'running' }] });
  const rec = cachedGithub(w.base, { mode: 'record' }), t1 = w.make(rec.gh); t1.sleep = async () => { throw new Error('chain entered'); };
  const cache0 = (() => t1)();   // eslint-disable-line no-unused-vars
  await t1.tickPass({ dryRun: false });
  const cache = buildCache({ repository: 'o/r', baseline: { etags: {}, heads: [H(1)] }, wrapper: rec, now: 1 }); assert.ok(cache);
  const reads = w.calls.reads, rep = cachedGithub(w.base, { mode: 'replay', cache }), t2 = w.make(rep.gh);
  let slept = 0; t2.sleep = async () => { slept++; };
  const report = await t2.tick({ dryRun: false, replay: true });
  assert.equal(w.calls.reads, reads, 'no list read'); assert.equal(report.noop, true); assert.equal(slept, 0, 'the chain window is not entered although a job is running');
  assert.deepEqual(report.actions, []);
  // a full pass with the same running job still enters the chain window
  const t3 = w.make(rec.gh); let slept3 = 0; t3.sleep = async () => { slept3++; throw new Error('stop'); };
  await assert.rejects(t3.tick({ dryRun: false }), /stop/); assert.equal(slept3, 1);
});
test('replay pass: a finished job is still ingested (verdict recorded, comment written), and a replay that did something is not a no-op', async t => {
  const pulls = [{ number: 10, title: 't', headRefName: 'codex/issue-2-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }];
  const w = teamWorld(t, { pulls, issues: [{ number: 23, title: 'a', state: 'CLOSED', body: '', labels: [] }, { number: 5, title: 'b', state: 'CLOSED', body: '', labels: [] }, { number: 2, title: 'c', state: 'OPEN', body: '', labels: [] }] });
  const t0 = w.make(w.base); const [act] = await t0.plan(); await t0.execute(act); t0.save();
  const [id, rec0] = Object.entries(t0.s.jobs)[0];
  const rec = cachedGithub(w.base, { mode: 'record' }); await w.make(rec.gh).plan();
  const cache = buildCache({ repository: 'o/r', baseline: { etags: {}, heads: [H(1)] }, wrapper: rec, now: 1 });
  const d = path.join(t0.dir, 'inbox', rec0.ticket); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'verdict.json'), JSON.stringify({ pr: 10, headSha: H(1), verdict: 'PASS', findings: [], commandsRun: ['node --test'] }));
  w.jobs.states[id] = { id, status: 'completed', provider: rec0.provider };
  const rep = cachedGithub(w.base, { mode: 'replay', cache }), t2 = w.make(rep.gh), report = await t2.tick({ dryRun: false, replay: true });
  assert.equal(t2.s.verdicts[`10:${H(1)}`]?.verdict, 'PASS', 'finished job result ingested during the replay'); assert.equal(report.ingested.length, 1);
  assert.equal(w.calls.comments.length >= 1, true, 'its comment is a real write'); assert.notEqual(report.noop, true);
});
test('replay pass: time-based work runs on the cached data against the current time (a check pending for hours is stuck now, not then)', async t => {
  const started = Date.parse('2026-11-01T00:00:00Z'), clock = { v: started + 60000 };
  const pulls = [{ number: 10, title: 't', headRefName: 'feature/x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS', startedAt: new Date(started).toISOString() }] }];
  const w = teamWorld(t, { pulls, clock: { now: () => clock.v } });
  const rec = cachedGithub(w.base, { mode: 'record' }); await w.make(rec.gh).tickPass({ dryRun: false });
  const cache = buildCache({ repository: 'o/r', baseline: { etags: {}, heads: [H(1)] }, wrapper: rec, now: 1 });
  const early = w.make(cachedGithub(w.base, { mode: 'replay', cache }).gh); await early.tickPass({ dryRun: false });
  assert.ok(unfinishedChecks(early.view.prs[0].statusCheckRollup, clock.v)[0].ageMs < 120000, 'a minute in');
  clock.v = started + 3 * 3600000;   // hours later, nothing changed on GitHub
  const late = w.make(cachedGithub(w.base, { mode: 'replay', cache }).gh); await late.tickPass({ dryRun: false });
  assert.ok(unfinishedChecks(late.view.prs[0].statusCheckRollup, clock.v)[0].ageMs >= 3 * 3600000 - 1000, 'hours later the same cached rollup is judged by the current time');
});

// ---- real processes -----------------------------------------------------------------------------------------------------------------
const FAKE_GH = `#!NODE
const fs = require('fs'), path = require('path'), d = process.env.FAKE_GH_DIR, a = process.argv.slice(2);
fs.appendFileSync(path.join(d, 'calls'), a.join(' ') + '\\n');
const read = (f, dflt) => { try { return fs.readFileSync(path.join(d, f), 'utf8').trim(); } catch { return dflt; } };
if (a[0] === 'api') {
  const url = a[a.length - 1], at = a.indexOf('-H'), inm = (at >= 0 ? a[at + 1] : '').replace(/^If-None-Match: /, '');
  const key = /issues\\?state/.test(url) ? 'issues' : /pulls\\?state/.test(url) ? 'pulls' : /\\/labels/.test(url) ? 'labels' : /issues\\/comments/.test(url) ? 'issue-comments' : /pulls\\/comments/.test(url) ? 'review-comments' : /git\\/ref/.test(url) ? 'ref' : /check-runs/.test(url) ? 'runs' : /\\/status/.test(url) ? 'status' : 'other';
  const mode = read('mode-' + key, read('mode-all', ''));
  if (mode === 'connect') { process.stderr.write('error connecting to api.github.com\\n'); process.exit(1); }
  if (mode === 'garbage') { process.stdout.write('[]\\n'); process.exit(0); }
  if (/^http\\d+$/.test(mode)) { process.stdout.write('HTTP/2.0 ' + mode.slice(4) + ' Err\\n\\n{}'); process.exit(1); }
  const etag = '"' + read('etag-' + key, 'v1') + '"';
  if (mode === 'noetag') { process.stdout.write('HTTP/2.0 200 OK\\n\\n[]'); process.exit(0); }
  if (inm.replace(/^W\\//, '') === etag) { process.stdout.write('HTTP/2.0 304 Not Modified\\netag: ' + etag + '\\n\\n'); process.exit(1); }
  const sha = read('head-sha', '');
  process.stdout.write('HTTP/2.0 200 OK\\nEtag: W/' + etag + '\\n\\n' + (key === 'pulls' ? JSON.stringify(sha ? [{ head: { sha } }] : []) : '[]')); process.exit(0);
}
if (a[0] === 'issue' && a[1] === 'list') { process.stdout.write(read('issues.json', '[]')); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list' && a.includes('open')) { process.stdout.write(read('prs.json', '[]')); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write(a.includes('files') ? '{"files":[]}' : '{}'); process.exit(0); }
process.stdout.write('[]');
`;
function world(t, { prs = [], issues = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-real-')), realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const git = (cwd, ...a) => execFileSync(realGit, ['-C', cwd, ...a], { encoding: 'utf8' });
  const origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo');
  execFileSync(realGit, ['init', '-q', '--bare', '-b', 'main', origin]);
  fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main'); git(repo, 'config', 'user.email', 't@example.invalid'); git(repo, 'config', 'user.name', 'T');
  fs.writeFileSync(path.join(repo, 'R'), 'x\n'); git(repo, 'add', 'R'); git(repo, 'commit', '-qm', 'init'); git(repo, 'remote', 'add', 'origin', origin); git(repo, 'push', '-q', 'origin', 'main'); git(repo, 'fetch', '-q', 'origin');
  const code = path.join(dir, 'code');
  fs.cpSync(path.join(here, '..', 'supervisor'), path.join(code, 'supervisor'), { recursive: true });
  fs.cpSync(path.join(here, '..', 'foreman-mcp', 'gbp.mjs'), path.join(code, 'foreman-mcp', 'gbp.mjs'));
  fs.cpSync(path.join(here, '..', 'foreman-mcp', 'actions.mjs'), path.join(code, 'foreman-mcp', 'actions.mjs'));
  const teamFile = path.join(code, 'supervisor', 'team.json'), team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  team.enabled = true; team.repo_path = repo; team.worktree_base = dir; team.agents.claude.issues = [901]; team.agents.codex.issues = []; team.limits.chain_seconds = 0;
  fs.writeFileSync(teamFile, JSON.stringify(team));
  const root = path.join(dir, 'state'), bin = path.join(dir, 'bin'), gh = path.join(dir, 'gh');
  fs.mkdirSync(path.join(root, 'team'), { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700); fs.mkdirSync(bin); fs.mkdirSync(gh);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH.replace('#!NODE', `#!${process.execPath}`), { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\ncase "$*" in *"show origin/main:docs/DECISIONS.md"*) cat '${path.join(here, '..', 'docs', 'DECISIONS.md')}'; exit 0;; esac\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(gh, 'issues.json'), JSON.stringify(issues)); fs.writeFileSync(path.join(gh, 'prs.json'), JSON.stringify(prs));
  if (prs.length) fs.writeFileSync(path.join(gh, 'head-sha'), prs[0].headRefOid);
  const manifest = id => ({ schema_version: 1, id, display_name: id, adapter_version: '0.1.0', launch: { command: process.execPath, args: [path.join(here, 'fake-agent.mjs'), 'done', path.join(dir, 'm')], env_allowlist: ['HOME', 'PATH', 'LANG'] },
    capabilities: { launch: 'supported', resume: 'supported', session_status: 'supported', usage_limit_detection: 'supported', reset_time_parsing: 'supported', checkpoint: 'supported', non_interactive: 'supported' }, billing: { model: 'subscription', fallback_to_other_billing: false } });
  const providers = {}; for (const id of ['fake', 'claude', 'codex']) { fs.writeFileSync(path.join(dir, id + '.json'), JSON.stringify(manifest(id))); providers[id] = { adapter: 'base', manifest: id + '.json' }; }
  const registry = path.join(dir, 'registry.json'); fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers }));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, AI_SUPERVISOR_STATE_ROOT: root, FAKE_GH_DIR: gh };
  t.after(() => fs.rmSync(dir, { maxRetries: 8, retryDelay: 250, recursive: true, force: true }));
  const cli = path.join(code, 'supervisor', 'cli.mjs');
  const run = (args = ['reconcile']) => spawnSync(process.execPath, [cli, ...args, '--state-root', root, '--registry', registry], { encoding: 'utf8', timeout: 120000, env });
  const calls = () => (fs.existsSync(path.join(gh, 'calls')) ? fs.readFileSync(path.join(gh, 'calls'), 'utf8').split('\n').filter(Boolean) : []);
  const issueReads = () => calls().filter(l => /^issue list.*title,state/.test(l)).length, probes = () => calls().filter(l => /^api /.test(l)).length;
  const set = (f, v) => fs.writeFileSync(path.join(gh, f), v);
  // One pass; `full` says the planner read the issue list, `probes` how many conditional requests the check made.
  const pass = args => { const i0 = issueReads(), p0 = probes(); const r = run(args); return { r, full: issueReads() > i0, probes: probes() - p0, snap: readSnapshots(root).at(-1) }; };
  return { dir, root, code, gh, run, pass, set, calls, issueReads, probes, registry, cli, repo };
}
const PR = { number: 7, title: 'p', headRefName: 'someone/else', headRefOid: SHA1, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: [], url: 'u', labels: [], closingIssuesReferences: [] };

test('real process: first pass is full and stores state; the second ends early as a no-op, reads no list, and is recorded with trigger, duration and the check result', async t => {
  const w = world(t, { prs: [PR] });
  const a = w.pass(); assert.equal(a.r.status, 0, a.r.stderr); assert.equal(a.full, true); assert.ok(fs.existsSync(cacheFile(w.root)), 'baseline stored after a clean full pass');
  assert.equal(a.snap.trigger, 'schedule'); assert.match(a.snap.check.reason, /no usable stored state/); assert.notEqual(a.snap.noop, true);
  assert.ok(a.snap.ghCalls > 0, 'the full pass records how many gh processes it started');
  const b = w.pass(); assert.equal(b.r.status, 0, b.r.stderr);
  assert.equal(b.full, false, 'no list was read'); assert.equal(b.snap.noop, true); assert.equal(b.snap.trigger, 'schedule'); assert.equal(b.snap.check.result, 'unchanged'); assert.match(b.snap.check.reason, /unchanged/);
  assert.ok(b.snap.startedAt > 0 && b.snap.at >= b.snap.startedAt, 'duration is recorded'); assert.ok(b.snap.ghCalls < a.snap.ghCalls, `fewer gh processes (${b.snap.ghCalls} against ${a.snap.ghCalls})`);
  assert.ok(b.probes >= 8, 'the check made its conditional requests');
  const stats = passStats(readSnapshots(w.root), 0, Date.now() + 1000); assert.equal(stats.noop, 1); assert.equal(stats.byTrigger.schedule.noop, 1); assert.ok(stats.seconds.medianNoop >= 0);
  assert.match(renderPassStats(stats), /Ended early as unchanged \(no-op\): 1 passes/);
  const idle = w.run(['team', 'idle-report', '--hours', '1']); assert.match(idle.stdout, /ended early as unchanged/);
});

test('real process: each covered change gives a full pass, then the next pass is a no-op again', async t => {
  const w = world(t, { prs: [PR] }); w.pass();
  assert.equal(w.pass().snap.noop, true, 'baseline reached');
  for (const key of ['issues', 'pulls', 'labels', 'issue-comments', 'review-comments', 'ref', 'runs', 'status']) {
    w.set('etag-' + key, 'changed-' + key);
    const full = w.pass(); assert.equal(full.full, true, `${key} changed: full pass`); assert.notEqual(full.snap.noop, true, key); assert.match(full.snap.check.reason, /changed/, key);
    const quiet = w.pass(); assert.equal(quiet.snap.noop, true, `${key}: the pass after re-baselines to a no-op (${quiet.snap.check?.reason})`);
  }
});

test('real process: an event wake always runs the full pass and makes no conditional request', async t => {
  const w = world(t, { prs: [PR] }); w.pass(); assert.equal(w.pass().snap.noop, true);
  for (const wake of ['job-end', 'install', 'inbox', 'approve']) {
    const x = w.pass(['reconcile', '--wake', wake]); assert.equal(x.full, true, wake); assert.equal(x.probes, 0, wake); assert.equal(x.snap.trigger, wake); assert.notEqual(x.snap.noop, true);
  }
});

test('real process fail-safe: a corrupt state file, any probe error or odd answer, a connection failure and the forced interval each give a full pass that still succeeds', async t => {
  const w = world(t, { prs: [PR] }); w.pass(); assert.equal(w.pass().snap.noop, true);
  const expectFull = (why, re) => { const x = w.pass(); assert.equal(x.full, true, why); assert.equal(x.r.status, 0, `${why}: ${x.r.stderr}`); assert.notEqual(x.snap.noop, true, why); assert.equal(x.snap.status, 'ok', why); assert.match(x.snap.check.reason, re, why); return x; };
  fs.writeFileSync(cacheFile(w.root), '{ not json'); expectFull('corrupt state', /no usable stored state/);
  assert.equal(w.pass().snap.noop, true, 'a clean full pass repaired the state');
  fs.writeFileSync(cacheFile(w.root), JSON.stringify({ v: 1, repository: 'x/y' })); expectFull('malformed state', /no usable stored state/);
  fs.rmSync(cacheFile(w.root)); expectFull('missing state', /no usable stored state/);
  for (const [mode, re] of [['connect', /no answer/], ['http500', /HTTP 500/], ['http403', /HTTP 403/], ['garbage', /no answer/], ['noetag', /no ETag/]]) {
    w.set('mode-all', mode); expectFull(mode, re); w.set('mode-all', '');
    assert.equal(w.pass().snap.noop, true, `${mode}: after the fault clears, back to a no-op`);
  }
  w.set('mode-status', 'http404'); expectFull('one failing endpoint', /status/); w.set('mode-status', '');
  w.pass(); const c = JSON.parse(fs.readFileSync(cacheFile(w.root), 'utf8')); c.fullAt = Date.now() - 31 * 60000; fs.writeFileSync(cacheFile(w.root), JSON.stringify(c));
  expectFull('forced interval', /forced full pass/); assert.equal(w.pass().snap.noop, true, 'the forced pass renewed it');
  const upg = path.join(w.root, 'team', 'self-upgrade.json'), s = fs.existsSync(upg) ? JSON.parse(fs.readFileSync(upg, 'utf8')) : {};
  assert.ok(!s.latch && !s.pending, 'a failed check left no latch and no pending install');
});

test('real process: a full pass that could not read does not store a baseline; the next pass is full again', async t => {
  const w = world(t, { prs: [PR] }); fs.writeFileSync(path.join(w.gh, 'issues.json'), 'not json');
  w.run(); assert.ok(!fs.existsSync(cacheFile(w.root)), 'nothing stored after a pass that could not read');
  fs.writeFileSync(path.join(w.gh, 'issues.json'), '[]'); const y = w.pass(); assert.equal(y.full, true); assert.ok(fs.existsSync(cacheFile(w.root)));
});

test('real process, what a no-op pass still does: dead-worker detection, dashboard freshness, the allowance record, lock release; and the pass after is a no-op again', async t => {
  const w = world(t, { prs: [PR] }); w.pass(); assert.equal(w.pass().snap.noop, true);
  const t0 = readCache(w.root).tick.at;
  const wt = path.join(w.dir, 'wt902'); execFileSync('git', ['-C', w.repo, 'worktree', 'add', '-qb', 'issue-902', wt]);
  const job = await createJob(w.root, { role: 'devtest', provider: 'fake', repository: w.repo, worktree: wt, issue: 902, scope: 'fixture', allowed_actions: ['read'], prompt: 'x', handover: 'H.md', autoResume: false }, w.registry);
  const file = path.join(w.root, 'jobs', job.id + '.json'), j = JSON.parse(fs.readFileSync(file, 'utf8')); j.status = 'running'; j.workerPid = 2147483000; j.workerStart = 'gone'; fs.writeFileSync(file, JSON.stringify(j));
  const x = w.pass(); assert.equal(x.r.status, 0, x.r.stderr);
  assert.equal(x.full, false, 'GitHub was unchanged, so no list was read'); assert.equal(x.snap.check.result, 'unchanged');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).status, 'blocked', 'dead-worker detection ran on the unchanged pass');
  assert.ok(readCache(w.root).tick.at > t0, 'the dashboard record is fresh'); assert.ok(x.snap.allowance && 'claude' in x.snap.allowance, 'the allowance reading is recorded');
  assert.ok(!fs.existsSync(path.join(w.root, 'team', 'wake-pass.lock')) && !fs.existsSync(path.join(w.root, 'team', 'tick.lock')), 'locks released');
  const y = w.pass(); assert.equal(y.snap.noop, true); assert.ok(y.snap.at > x.snap.at);
});
test('replay pass that did something enters the chain window; once a job ends the chained pass reads GitHub live, not the replayed cache', async t => {
  const pr = h => ({ number: 10, title: 't', headRefName: 'codex/issue-2-x', headRefOid: H(h), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  const pulls = [pr(1)], issues = [{ number: 23, title: 'a', state: 'CLOSED', body: '', labels: [] }, { number: 5, title: 'b', state: 'CLOSED', body: '', labels: [] }, { number: 2, title: 'c', state: 'OPEN', body: '', labels: [] }];
  const w = teamWorld(t, { pulls, issues });
  const rec = cachedGithub(w.base, { mode: 'record' }); await w.make(rec.gh).plan();
  const cache = buildCache({ repository: 'o/r', baseline: { etags: {}, heads: [H(1)] }, wrapper: rec, now: 1 }); assert.ok(cache);
  w.jobs.active = [{ id: 'j9', provider: 'claude', status: 'running' }];
  const rep = cachedGithub(w.base, { mode: 'replay', cache }), team = w.make(rep.gh);
  let slept = 0; team.sleep = async () => { slept++; w.jobs.active = []; pulls[0] = pr(2); };   // the running job ends and the PR head moves
  let liveHead = null, passes = 0; const orig = team.tickPass.bind(team);
  team.tickPass = async o => { passes++; if (passes === 2) liveHead = (await team.gh.listPulls())[0].headRefOid; return orig(o); };
  const report = await team.tick({ dryRun: false, replay: true, beforeChain: () => rep.endReplay() });
  assert.notEqual(report.noop, true); assert.equal(slept, 1, 'the chain window was entered'); assert.equal(passes, 2, 'a chained pass ran');
  assert.equal(liveHead, H(2), 'the chained pass reads GitHub live');
});

// Issue #758: the cli.mjs wiring (beforeChain -> wrapper.endReplay) in a real process. A replay pass that did something (an inbox directory that cannot
// be read is a skipped item) enters the chain window while a job runs; the job ends; the chained pass must then read GitHub live (issue list read).
test('real process: a replay pass that did something enters the chain window, and the chained pass after a job end reads GitHub live', async t => {
  const w = world(t, { prs: [PR] });
  const teamFile = path.join(w.code, 'supervisor', 'team.json'), team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  const blocker = path.join(w.dir, 'not-a-dir'); fs.writeFileSync(blocker, 'x');
  const first = w.pass(); assert.equal(first.r.status, 0, first.r.stderr); assert.equal(first.full, true); assert.ok(fs.existsSync(cacheFile(w.root)), 'baseline stored');
  // only now: a skipped item makes a pass not clean, so it must not be in the baseline pass
  team.inbox = { ...(team.inbox || {}), dir: path.join(blocker, 'inbox') }; team.limits.chain_seconds = 60; team.limits.chain_poll_seconds = 1; team.limits.chain_passes = 1;
  fs.writeFileSync(teamFile, JSON.stringify(team));
  const wt = path.join(w.dir, 'wt903'); execFileSync('git', ['-C', w.repo, 'worktree', 'add', '-qb', 'issue-903', wt]);
  const job = await createJob(w.root, { role: 'devtest', provider: 'fake', repository: w.repo, worktree: wt, issue: 903, scope: 'fixture', allowed_actions: ['read'], prompt: 'x', handover: 'H.md', autoResume: false }, w.registry);
  const file = path.join(w.root, 'jobs', job.id + '.json'), j = JSON.parse(fs.readFileSync(file, 'utf8')); const sleeper = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 120000)'], { stdio: 'ignore' }); t.after(() => sleeper.kill());   // a live worker, so dead-worker detection leaves the job running
  j.status = 'running'; j.workerPid = sleeper.pid; j.workerStart = processStart(sleeper.pid); fs.writeFileSync(file, JSON.stringify(j));
  const i0 = w.issueReads(), p0 = w.probes();
  const child = spawn(process.execPath, [w.cli, 'reconcile', '--state-root', w.root, '--registry', w.registry], { env: { ...process.env, PATH: `${path.join(w.dir, 'bin')}:${process.env.PATH}`, AI_SUPERVISOR_STATE_ROOT: w.root, FAKE_GH_DIR: w.gh }, stdio: 'ignore' });
  const done = new Promise(res => child.on('exit', code => res(code)));
  const until = async (cond, ms) => { for (let n = 0; n < ms / 100 && !cond(); n++) await new Promise(r => setTimeout(r, 100)); return cond(); };
  t.after(() => child.kill());
  assert.ok(await until(() => w.probes() - p0 >= first.probes, 30000), 'the replay check made its probes');
  assert.equal(w.issueReads(), i0, 'the replay pass read no issue list');
  // The replay pass is in the chain window once it has gone quiet: its GitHub calls stop and the process stays alive for longer than two chain polls
  // (1 s each, window 60 s). Observed as a condition (a stable call count), not a fixed sleep, so a slow host only waits longer.
  let seen = w.calls().length, since = Date.now();
  assert.ok(await until(() => { const n = w.calls().length; if (n !== seen) { seen = n; since = Date.now(); } return child.exitCode !== null || Date.now() - since >= 2500; }, 60000), 'the pass went quiet');
  assert.equal(child.exitCode, null, 'the pass is still waiting in the chain window');
  const j2 = JSON.parse(fs.readFileSync(file, 'utf8')); j2.status = 'completed'; fs.writeFileSync(file, JSON.stringify(j2));   // the job ends
  await done;   // the pass is not clean (it has a skipped item), so its exit status is not the point
  assert.ok(w.issueReads() > i0, 'the chained pass read the issue list live, not from the replayed cache');
  const snap = readSnapshots(w.root).at(-1); assert.equal(snap.check.result, 'unchanged'); assert.notEqual(snap.noop, true);
});
