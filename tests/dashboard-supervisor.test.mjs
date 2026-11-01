// Dashboard Supervisor area and copy buttons (issue #72): reconcile-log parsing, the five health cards and their colours,
// Git refs read from files, drill-down pages, copy buttons site-wide, the copy-for-overseer text and what must never be in it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LOG_TAIL_BYTES, TICK_RED_MS, parseReconcileLog, readGitRef, readHeadBranch, readReconcileLog, scrub, supervisorHealth, tickLine } from '../supervisor/suphealth.mjs';
import { copyFeedback, copyMethods } from '../supervisor/dashui/logic.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { matchRoute } from '../supervisor/dashrender.mjs';

const NOW = Date.parse('2026-10-31T18:07:00Z');
// Credential-shaped canaries are built at run time so the repository never contains one (validator secret scan).
const FAKE_GH = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123'].join('_');
const FAKE_BEARER = ['Bearer', 'abcdefghijklmnopqrstuvwxyz'].join(' ');
const MIN = 60000;
const H = n => String(n).repeat(40).slice(0, 40);
const SAMPLE = fs.readFileSync(new URL('./fixtures/dashboard/reconcile-sample.log', import.meta.url), 'utf8');
const tmp = (t, p = 'sup-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'init.defaultBranch=main', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
const logLine = (iso, obj) => `${iso} tick\n${JSON.stringify({ resumed: 0, blocked: 0, ...obj })}\n`;
const isoAgo = ms => new Date(NOW - ms).toISOString().replace('.000Z', '+00:00');

// ---- reconcile log parsing
test('reconcile log: both real line formats, stray non-JSON lines, error/partial/skipped/empty ticks', () => {
  const ticks = parseReconcileLog(SAMPLE);
  assert.equal(ticks.length, 7);
  const [gh, busy, lease, enoent, rc127, rebase, implement] = ticks;
  assert.equal(gh.status, 'error'); assert.match(gh.errors[0], /team tick: gh issue list failed/);
  assert.equal(busy.status, 'skipped'); assert.equal(busy.note, 'another tick is running'); assert.deepEqual(busy.errors, []);
  assert.equal(lease.status, 'error'); assert.equal(lease.errors.length, 2, 'helper stderr line and the team error');
  assert.match(lease.errors[0], /team-alert: line 15/); assert.equal(lease.at, Date.parse('2026-10-31T09:00:03Z'));
  assert.equal(enoent.status, 'partial'); assert.deepEqual(enoent.skipped.map(s => s.what), ['continue 28 (codex)']); assert.match(enoent.skipped[0].reason, /^ENOENT: no such file/);
  assert.deepEqual(enoent.actions, [{ agent: 'codex', type: 'continue', ref: 28, pr: 28, issue: 3 }]); assert.equal(enoent.selfUpgrade, 'current');
  assert.equal(rc127.status, 'error'); assert.equal(rc127.rc, 127); assert.match(rc127.errors[0], /supervisor cli unreadable/);
  assert.equal(rebase.status, 'ok'); assert.deepEqual(rebase.ingested, [{ job: 'b485512f78df4a50af28f7b192a30710', pr: 41, verdict: 'CHANGES' }]); assert.equal(rebase.released, 1);
  assert.equal(implement.status, 'ok', 'installer format rc=0 with the JSON on the same line'); assert.equal(implement.rc, 0); assert.equal(implement.actions[0].issue, 72); assert.equal(implement.selfUpgrade, 'no-supervisor-change');
  assert.match(tickLine(rebase), /tick ok; ingested CHANGES on PR #41; actions claude rebase #41; released 1 lease\(s\); self-upgrade current/);
  const odd = parseReconcileLog('2026-10-31T10:00:00Z\n{"not":"closed"\n2026-10-31T10:05:00Z rc=1 boom {"resumed":0,"blocked":0,"team":{"skipped":[{"what":"x","reason":"y"}]}}\n');
  assert.equal(odd[0].status, 'error', 'a broken JSON line is a non-JSON line'); assert.match(odd[0].errors[0], /not/);
  assert.equal(odd[1].status, 'error', 'text before the JSON is a stray error line'); assert.match(odd[1].errors[0], /boom/);
  assert.equal(parseReconcileLog('2026-10-31T10:00:00+00:00\n')[0].status, 'empty');
  assert.deepEqual(parseReconcileLog(''), []);
});
test('reconcile log: secrets, e-mail addresses and IP addresses never survive parsing', () => {
  const evil = `2026-10-31T10:00:00Z tick\nfatal: could not read from 192.168.13.1:8731 as squiggle@example.com token ${FAKE_GH}\n${JSON.stringify({ team: { error: `${FAKE_BEARER} connecting to 10.0.0.5` } })}\n`;
  const text = JSON.stringify(parseReconcileLog(evil));
  for (const bad of ['192.168.13.1', '10.0.0.5', 'squiggle@example.com', FAKE_GH, 'abcdefghijklmnopqrstuvwxyz']) assert.ok(!text.includes(bad), bad);
  assert.match(text, /\[ip\]/); assert.match(text, /\[email\]/); assert.match(text, /\[token\]/);
  assert.equal(scrub('version 0.165.0 at 1.2.3'), 'version 0.165.0 at 1.2.3', 'version numbers are not addresses');
});
test('reconcile log: only the tail is read, and a cut first line is dropped', t => {
  const root = tmp(t);
  const filler = 'x'.repeat(200) + '\n';
  fs.writeFileSync(path.join(root, 'reconcile.log'), logLine('2026-10-01T00:00:00Z', { team: { error: 'OLD' } }) + filler.repeat(Math.ceil(LOG_TAIL_BYTES / filler.length) + 10) + logLine('2026-10-31T18:05:00Z', { team: { actions: [] } }));
  const ticks = readReconcileLog(root);
  assert.ok(!JSON.stringify(ticks).includes('OLD'), 'content before the tail is not read');
  assert.equal(ticks.at(-1).status, 'ok');
  assert.equal(readReconcileLog(tmp(t)), null, 'no log file');
});

// ---- git refs from files only
test('git refs: loose and packed refs, symbolic HEAD, linked worktree; hostile ref names and relative paths are refused', t => {
  const repo = tmp(t, 'gitref-');
  git(repo, 'init', '-q'); fs.writeFileSync(path.join(repo, 'f'), '1'); git(repo, 'add', 'f'); git(repo, 'commit', '-qm', 'one');
  const one = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'update-ref', 'refs/remotes/origin/main', one);
  assert.equal(readGitRef(repo, 'refs/heads/main'), one); assert.equal(readGitRef(repo, 'refs/remotes/origin/main'), one); assert.equal(readGitRef(repo, 'HEAD'), one);
  assert.equal(readHeadBranch(repo), 'main');
  git(repo, 'pack-refs', '--all'); assert.ok(!fs.existsSync(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'main')), 'packed');
  assert.equal(readGitRef(repo, 'refs/remotes/origin/main'), one, 'from packed-refs');
  fs.writeFileSync(path.join(repo, 'f'), '2'); git(repo, 'commit', '-qam', 'two'); const two = git(repo, 'rev-parse', 'HEAD');
  assert.equal(readGitRef(repo, 'refs/heads/main'), two, 'a loose ref wins over packed-refs');
  const wt = path.join(tmp(t, 'gitwt-'), 'wt'); git(repo, 'worktree', 'add', '-q', '-b', 'side', wt);
  assert.equal(readGitRef(wt, 'refs/heads/main'), two, 'linked worktree reads the common refs'); assert.equal(readHeadBranch(wt), 'side');
  git(repo, 'checkout', '-q', '--detach'); assert.match(readHeadBranch(repo), /^detached at [0-9a-f]{7}$/);
  for (const bad of ['refs/heads/../../config', '../HEAD', 'refs/tags/v1', 'config', 'refs/heads/main\nx']) assert.equal(readGitRef(repo, bad), null, bad);
  assert.equal(readGitRef('relative/path', 'HEAD'), null); assert.equal(readGitRef(path.join(repo, 'missing'), 'HEAD'), null); assert.equal(readGitRef(undefined, 'HEAD'), null);
});

// ---- the five cards
const config = (repo = '/nonexistent/repo') => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: repo, worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [3] } }
});
function stateRoot(t, { log, upgrades, selfUpgrade, latch, installed, installedAt, leases = [] } = {}) {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, 'team'), { recursive: true }); fs.mkdirSync(path.join(root, 'leases'), { recursive: true });
  if (log !== undefined) fs.writeFileSync(path.join(root, 'reconcile.log'), log);
  if (upgrades) fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), upgrades.map(u => JSON.stringify(u)).join('\n') + '\nnot json\n');
  if (selfUpgrade) fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify(selfUpgrade));
  if (latch) fs.writeFileSync(path.join(root, 'team', 'self-upgrade.latch'), JSON.stringify(latch));
  if (installed) {
    fs.mkdirSync(path.join(root, 'versions', installed), { recursive: true }); fs.symlinkSync(`versions/${installed}`, path.join(root, 'current'));
    if (installedAt) fs.lutimesSync(path.join(root, 'current'), installedAt / 1000, installedAt / 1000);
  }
  leases.forEach((l, i) => fs.writeFileSync(path.join(root, 'leases', `k${i}`), JSON.stringify(l)));
  return root;
}
function repoWith(t, { local, origin, branch } = {}) {
  const repo = tmp(t, 'repo-');
  fs.mkdirSync(path.join(repo, '.git', 'refs', 'heads'), { recursive: true }); fs.mkdirSync(path.join(repo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch || 'main'}\n`);
  if (local) fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', 'main'), `${local}\n`);
  if (origin) fs.writeFileSync(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'main'), `${origin}\n`);
  return repo;
}
const cardOf = (h, id) => h.cards.find(c => c.id === id);
const okLog = (ms = MIN, extra = {}) => logLine(isoAgo(ms), { team: { ingested: [], actions: [], skipped: [] }, selfUpgrade: 'current', ...extra });

test('last tick: green when fresh, red after more than two five-minute intervals, red on error, amber on a skipped item', t => {
  const at = ms => cardOf(supervisorHealth({ root: stateRoot(t, { log: okLog(ms) }), config: config(), jobs: [], now: NOW }), 'tick');
  assert.equal(TICK_RED_MS, 10 * MIN);
  assert.equal(at(MIN).severity, 'ok'); assert.equal(at(9 * MIN).severity, 'ok'); assert.equal(at(10 * MIN).severity, 'ok', 'exactly two intervals');
  const old = at(10 * MIN + 1000); assert.equal(old.severity, 'action'); assert.equal(old.stale, true); assert.match(old.notes[0], /more than two five-minute intervals/);
  const err = cardOf(supervisorHealth({ root: stateRoot(t, { log: logLine(isoAgo(MIN), { team: { error: 'boom' } }) }), config: config(), jobs: [], now: NOW }), 'tick');
  assert.equal(err.severity, 'action');
  const part = cardOf(supervisorHealth({ root: stateRoot(t, { log: logLine(isoAgo(MIN), { team: { actions: [{ agent: 'codex', type: 'review', pr: 9 }], skipped: [{ what: 'review 9 (codex)', reason: 'lease conflict' }], ingested: [{ job: 'a'.repeat(32), pr: 8, verdict: 'PASS' }] } }) }), config: config(), jobs: [], now: NOW }), 'tick');
  assert.equal(part.severity, 'warning'); assert.equal(part.tick.actions.length, 1); assert.equal(part.tick.ingested.length, 1); assert.equal(part.tick.skipped[0].reason, 'lease conflict');
  const none = cardOf(supervisorHealth({ root: stateRoot(t), config: config(), jobs: [], now: NOW }), 'tick');
  assert.equal(none.severity, 'action'); assert.equal(none.tick, null);
});
test('version: installed vs origin/main, last upgrade result and reason, pre-check latched target with when it latched, rollback latch', t => {
  const repo = repoWith(t, { local: H(2), origin: H(2) });
  const v = o => cardOf(supervisorHealth({ root: stateRoot(t, { installed: H(1), ...o }), config: config(repo), jobs: [], now: NOW }), 'version');
  const cur = cardOf(supervisorHealth({ root: stateRoot(t, { installed: H(2), log: okLog() }), config: config(repo), jobs: [], now: NOW }), 'version');
  assert.equal(cur.severity, 'ok'); assert.match(cur.summary, /= origin\/main/);
  const quiet = v({ log: okLog(MIN, { selfUpgrade: 'no-supervisor-change' }) });
  assert.equal(quiet.severity, 'ok', 'main ahead without a supervisor change is fine'); assert.equal(quiet.behind, true);
  const latched = v({ log: okLog(MIN, { selfUpgrade: 'precheck-failed' }), selfUpgrade: { prechecked: { [H(2)]: NOW - 3 * 3600000, [H(9)]: NOW - 9 * 3600000, bogus: 1 } },
    upgrades: [{ at: NOW - 3 * 3600000, from: H(1), to: H(2), result: 'precheck_failed', reason: 'tests: 1 failing' }] });
  assert.equal(latched.severity, 'warning'); assert.deepEqual(latched.prechecked.map(p => [p.sha, p.isMain]), [[H(2), true], [H(9), false]]);
  assert.equal(latched.prechecked[0].at, NOW - 3 * 3600000); assert.equal(latched.lastUpgrade.reason, 'tests: 1 failing'); assert.equal(latched.lastUpgrade.result, 'precheck_failed');
  assert.ok(latched.notes.some(n => /failed its pre-check/.test(n)));
  const rolled = v({ log: okLog(MIN, { selfUpgrade: 'latched' }), latch: { at: NOW - 3600000, from: H(1), to: H(2), reason: 'live tick failed: x' } });
  assert.equal(rolled.severity, 'action'); assert.equal(rolled.latch.reason, 'live tick failed: x');
  const unversioned = cardOf(supervisorHealth({ root: stateRoot(t, { log: okLog() }), config: config(repo), jobs: [], now: NOW }), 'version');
  assert.equal(unversioned.severity, 'warning'); assert.equal(unversioned.installed, null);
});
const job = (o = {}) => ({ id: 'a'.repeat(32), provider: 'codex', kind: 'review', issue: 41, status: 'running', attempts: 1, lastEvent: 'started', createdAt: NOW - 30 * MIN, updatedAt: NOW - MIN,
  worktree: '/mnt/user/projects/secret-worktree', postcondition: { kind: 'verdict', ticket: 'f'.repeat(32), pr: 41, head: H(4) }, ...o });
test('leases: active ones with job, agent and age; stale ones are red with the recovery command; held by a blocked job is amber', t => {
  const l = (jobs, leases) => cardOf(supervisorHealth({ root: stateRoot(t, { leases }), config: config(), jobs, now: NOW }), 'leases');
  const active = l([job()], [{ job: 'a'.repeat(32), at: NOW - 20 * MIN }, { job: 'a'.repeat(32), at: NOW - 20 * MIN }]);
  assert.equal(active.severity, 'ok'); assert.equal(active.leases.length, 1, 'issue and worktree lease of one job are one row'); assert.equal(active.leases[0].files, 2);
  assert.equal(active.leases[0].agent, 'codex'); assert.equal(active.leases[0].ageMs, 20 * MIN); assert.equal(active.leases[0].state, 'active');
  const stale = l([job({ status: 'completed' })], [{ job: 'a'.repeat(32), at: NOW - 3 * 3600000 }]);
  assert.equal(stale.severity, 'action'); assert.equal(stale.leases[0].state, 'stale'); assert.equal(stale.leases[0].command, `ai-supervisor release ${'a'.repeat(32)}`);
  const orphan = l([], [{ job: 'b'.repeat(32), at: NOW - 3600000 }]);
  assert.equal(orphan.severity, 'action'); assert.equal(orphan.leases[0].command, null, 'no command offered for a missing job record'); assert.match(orphan.leases[0].reason, /no job record/);
  const held = l([job({ status: 'blocked' })], [{ job: 'a'.repeat(32), at: NOW - 3600000 }]);
  assert.equal(held.severity, 'warning'); assert.equal(held.leases[0].state, 'held');
  assert.equal(l([], []).severity, 'ok');
});
test('errors: counted since the last upgrade only, with the latest message; red while the latest tick still has it', t => {
  const log = logLine(isoAgo(5 * 3600000), { team: { error: 'before the upgrade' } }) + logLine(isoAgo(60 * MIN), { team: { error: 'after one' } })
    + `${isoAgo(50 * MIN)} tick\nnode: script ENOENT\n${JSON.stringify({ team: { actions: [] } })}\n` + okLog(MIN);
  const e = cardOf(supervisorHealth({ root: stateRoot(t, { log, installed: H(1), installedAt: NOW - 2 * 3600000 }), config: config(), jobs: [], now: NOW }), 'errors');
  assert.equal(e.count, 2); assert.equal(e.severity, 'warning', 'the newest tick is clean'); assert.equal(e.latest.text, 'node: script ENOENT'); assert.equal(e.since, NOW - 2 * 3600000);
  const upgraded = cardOf(supervisorHealth({ root: stateRoot(t, { log, installed: H(1), installedAt: NOW - 10 * 3600000, upgrades: [{ at: NOW - 55 * MIN, from: H(0), to: H(1), result: 'upgraded' }] }), config: config(), jobs: [], now: NOW }), 'errors');
  assert.equal(upgraded.count, 1, 'the newer upgrade record moves the window'); assert.equal(upgraded.since, NOW - 55 * MIN);
  const now = cardOf(supervisorHealth({ root: stateRoot(t, { log: log + logLine(isoAgo(0), { team: { error: 'right now' } }), installed: H(1), installedAt: NOW - 2 * 3600000 }), config: config(), jobs: [], now: NOW }), 'errors');
  assert.equal(now.severity, 'action'); assert.equal(now.latest.text, 'team tick: right now');
  assert.equal(cardOf(supervisorHealth({ root: stateRoot(t, { log: okLog() }), config: config(), jobs: [], now: NOW }), 'errors').severity, 'ok');
});
test('local repo drift: equal is green, different main or another branch is amber, unreadable refs are blue', t => {
  const d = o => cardOf(supervisorHealth({ root: stateRoot(t), config: config(o === null ? '/nonexistent/x' : repoWith(t, o)), jobs: [], now: NOW }), 'drift');
  assert.equal(d({ local: H(1), origin: H(1) }).severity, 'ok');
  const drift = d({ local: H(1), origin: H(2) }); assert.equal(drift.severity, 'warning'); assert.match(drift.summary, /1111111 differs from origin\/main 2222222/); assert.match(drift.notes[0], /#69/);
  assert.equal(d({ local: H(1), origin: H(1), branch: 'feature' }).severity, 'warning');
  assert.equal(d(null).severity, 'info');
});

// ---- pages and copy buttons through the real handler
async function serve(t, { root, cfg = config(), cache, state }) {
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true }); fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  if (cache) fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache));
  if (state) fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify(state));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.close());
  const port = server.address().port; server.on('request', handler({ root, config: cfg, host: '127.0.0.1', port, now: () => NOW }));
  return { get: p => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject)) };
}
const writeJob = (root, j) => { fs.mkdirSync(path.join(root, 'jobs'), { recursive: true }); fs.writeFileSync(path.join(root, 'jobs', `${j.id}.json`), JSON.stringify(j)); };
const unesc = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const copies = body => [...body.matchAll(/data-copy="([^"]*)"/g)].map(m => unesc(m[1]));
const cache = { tick: { at: NOW - MIN, status: 'ok', error: null, lastOkAt: NOW - MIN }, fetchedAt: NOW - MIN, delivered: [], issues: [],
  pulls: [{ number: 41, title: 'PR forty-one', headRefName: 'claude/issue-30-x', headRefOid: H(4), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }] };

test('routes: /supervisor, its tick and upgrade drill-downs; the nav shows Supervisor on every page and marks it on the drill-downs', async t => {
  assert.deepEqual(matchRoute('/supervisor'), { page: 'supervisor' }); assert.deepEqual(matchRoute('/supervisor/ticks/'), { page: 'ticks' }); assert.deepEqual(matchRoute('/supervisor/upgrades'), { page: 'upgrades' });
  assert.equal(matchRoute('/supervisor/other'), null); assert.equal(matchRoute('/supervisor/ticks/1'), null);
  const s = await serve(t, { root: stateRoot(t, { log: SAMPLE }), cache });
  for (const u of ['/', '/work', '/system', '/supervisor', '/supervisor/ticks', '/supervisor/upgrades']) {
    const r = await s.get(u); assert.equal(r.status, 200, u); assert.match(r.body, /<a href="\/supervisor"[^>]*><svg[^>]*><use href="#i-shield"\/><\/svg><span>Supervisor<\/span>/, u);
  }
  assert.match((await s.get('/supervisor/ticks')).body, /<a href="\/supervisor" aria-current="page">/);
  assert.match((await s.get('/supervisor/upgrades')).body, /<a href="\/supervisor">Supervisor<\/a>.*<span aria-current="page">Upgrade history<\/span>/s);
  assert.equal((await s.get('/supervisor/nope')).status, 404);
});
test('Supervisor page: five summary cards that turn amber or red, each with a drill-down and a copy-for-overseer button; works without data', async t => {
  const empty = (await (await serve(t, { root: stateRoot(t), cache })).get('/supervisor')).body;
  for (const id of ['version', 'tick', 'leases', 'errors', 'drift']) assert.match(empty, new RegExp(`data-card="h-${id}"`), id);
  assert.match(empty, /data-card="h-tick"[^>]*>[\s\S]*?No tick in the reconcile log/); assert.match(empty, /class="card health hc-action" data-card="h-tick"/);
  const root = stateRoot(t, { log: SAMPLE + okLog(2 * MIN), installed: H(1), installedAt: NOW - 30 * 3600000, leases: [{ job: 'a'.repeat(32), at: NOW - 3600000 }] });
  writeJob(root, job({ status: 'completed' }));
  const body = (await (await serve(t, { root, cache })).get('/supervisor')).body;
  assert.match(body, /class="card health hc-ok" data-card="h-tick"/); assert.match(body, /class="card health hc-action" data-card="h-leases"/);
  assert.match(body, /class="card health hc-(warning|action)" data-card="h-errors"/); assert.match(body, /class="card health hc-info" data-card="h-drift"/);
  for (const href of ['/supervisor/upgrades', '/supervisor/ticks', '/supervisor#h-leases-table', '/supervisor/ticks?ticks.q=error']) assert.ok(body.includes(`href="${href}"`), href);
  assert.equal((body.match(/class="copy btn overseer"/g) || []).length, 5, 'one copy-for-overseer button per card');
  assert.match(body, /<code class="cmd mono">ai-supervisor release a{32}<\/code><button type="button" class="copy tbtn /);
  assert.match(body, /data-card="h-leases-table"[\s\S]*<td data-label="State"[^>]*><span class="badge sev-action/);
  assert.match(body, /Recent ticks/);
});
test('tick history: one row per tick, newest first, sortable, filterable, paginated, each row expands to the full action and skip detail', async t => {
  const many = Array.from({ length: 30 }, (_, i) => okLog(NOW - Date.parse('2026-10-29T00:00:00Z') - i * 5 * MIN)).join('');
  const s = await serve(t, { root: stateRoot(t, { log: many + SAMPLE }), cache });
  const p1 = (await s.get('/supervisor/ticks')).body;
  assert.match(p1, /Ticks in the reconcile log \(37\)/); assert.match(p1, /1–25 of 37/); assert.match(p1, /Page 1 of 2/); assert.match(p1, /<tfoot>[\s\S]*37 ticks/);
  const firstWhen = /<td data-label="When"[^>]*>([^<]+)</.exec(p1)[1]; assert.equal(firstWhen, '2026-10-31 18:05 UTC', 'newest first');
  const asc = (await s.get('/supervisor/ticks?ticks.sort=at&ticks.dir=asc')).body;
  assert.equal(/<td data-label="When"[^>]*>([^<]+)</.exec(asc)[1], '2026-10-29 00:00 UTC'); assert.match(asc, /aria-sort="ascending"/);
  const errs = (await s.get('/supervisor/ticks?ticks.q=error')).body;
  assert.match(errs, /4 ticks/);
  const at = Date.parse('2026-10-31T12:00:02Z');
  const closed = (await s.get('/supervisor/ticks?ticks.q=ENOENT')).body;
  assert.match(closed, new RegExp(`<a class="btn" href="/supervisor/ticks\\?ticks\\.q=ENOENT&amp;ticks\\.open=${at}#tick-${at}" aria-expanded="false">Show</a>`)); assert.doesNotMatch(closed, /class="tick-detail"/, 'collapsed rows carry no hidden detail');
  const enoent = (await s.get(`/supervisor/ticks?ticks.q=ENOENT&ticks.open=${at}`)).body;
  assert.match(enoent, new RegExp(`aria-expanded="true">Hide</a><div class="tick-detail" id="tick-${at}">[\\s\\S]*Skipped[\\s\\S]*<b>continue 28 \\(codex\\)</b>: <span class="err">ENOENT: no such file`));
  assert.equal((enoent.match(/class="tick-detail"/g) || []).length, 1, 'only the opened row expands');
  assert.match(enoent, /Actions<\/dt><dd><ul class="mini "><li>codex continue <a href="\/work\/issue\/3">issue #3<\/a>/);
  assert.match((await s.get('/supervisor/ticks?ticks.page=2')).body, /26–37 of 37/);
});
test('upgrade history: records newest first with result, from/to commits (copyable), PRs and reason', async t => {
  const upgrades = [{ at: NOW - 7200000, from: H(1), to: H(2), prs: [59, 28], result: 'verified', checks: { liveTick: 'ok' } }, { at: NOW - 3600000, from: H(2), to: H(3), prs: [70], result: 'refused', reason: 'changes the upgrader', files: ['supervisor/upgrade.mjs'] }];
  const body = (await (await serve(t, { root: stateRoot(t, { upgrades }), cache })).get('/supervisor/upgrades')).body;
  assert.match(body, /Self-upgrade records \(2\)/); assert.ok(body.indexOf('refused') < body.indexOf('verified'), 'newest first');
  assert.match(body, /href="\/work\/pr\/70"/); assert.match(body, /changes the upgrader/);
  const c = copies(body); for (const sha of [H(1), H(2), H(3)]) assert.ok(c.includes(sha), sha);
  const none = (await (await serve(t, { root: stateRoot(t), cache })).get('/supervisor/upgrades')).body; assert.match(none, /No self-upgrade record/);
});
test('copy buttons site-wide: commands, job IDs, commit IDs and error messages; hidden until the script runs; labelled for screen readers', async t => {
  const root = stateRoot(t, { log: SAMPLE });
  writeJob(root, job({ status: 'blocked', lastEvent: 'retry_exhausted' }));
  const state = { verdicts: { [`41:${H(4)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 5 * MIN, findings: [{ kind: 'blocking', summary: 'x' }] } }, jobs: {} };
  const s = await serve(t, { root, state, cache: { ...cache, tick: { at: NOW - 20 * MIN, status: 'error', error: 'gh issue list failed', lastOkAt: NOW - 3600000 } } });
  const over = (await s.get('/')).body;
  const needs = over.slice(over.indexOf('data-card="needs"'), over.indexOf('data-card="warnings"'));
  assert.match(needs, /<code class="cmd mono">ai-supervisor team tick --dry-run<\/code><button type="button" class="copy tbtn " data-copy="ai-supervisor team tick --dry-run" aria-label="Copy command" title="Copy command" hidden>/);
  assert.match(needs, new RegExp(`<code class="cmd mono">ai-supervisor status ${'a'.repeat(32)}</code>`), 'a command that exists (`status ID`), not `job ID`');
  assert.ok(copies(needs).includes(`ai-supervisor status ${'a'.repeat(32)}`));
  const usage = (await s.get('/usage')).body; assert.ok(copies(usage).includes('a'.repeat(32)), 'full job ID copied from the short one shown');
  const pr = (await s.get('/work/pr/41')).body; assert.ok(copies(pr).includes(H(4)), 'commit ID in the verdict history');
  const reviews = (await s.get('/reviews')).body; assert.ok(copies(reviews).includes(H(4)));
  const sys = (await s.get('/system')).body; assert.ok(copies(sys).includes('gh issue list failed'), 'the tick error message');
  const sup = (await s.get(`/supervisor/ticks?ticks.q=ENOENT&ticks.open=${Date.parse('2026-10-31T12:00:02Z')}`)).body; assert.ok(copies(sup).some(c => c.startsWith('ENOENT: no such file')), 'error messages in the tick detail');
  for (const b of [over, usage, pr, sys, sup]) {
    for (const btn of b.match(/<button type="button" class="copy[^>]*>/g) || []) { assert.match(btn, / hidden>$/); assert.match(btn, /aria-label="Copy [^"]+"/); }
    assert.match(b, /<p id="copy-status" class="vh" role="status" aria-live="polite"><\/p>/);
  }
});
test('copy for overseer on an Action needed job item: what is wrong, job record summary, latest PR verdict, related log lines; no secrets', async t => {
  const root = stateRoot(t, { log: SAMPLE + logLine(isoAgo(3 * MIN), { team: { skipped: [{ what: 'review 41 (codex)', reason: `lease held; token ${FAKE_GH} from 192.168.13.1` }] } }) });
  writeJob(root, job({ id: 'b485512f78df4a50af28f7b192a30710', status: 'blocked', lastEvent: 'retry_exhausted', worktree: '/mnt/user/projects/hidden-worktree-path', sessionId: 'sess-secret-value' }));
  const state = { verdicts: { [`41:${H(4)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 5 * MIN, findings: [{ kind: 'blocking', summary: 'x' }, { kind: 'follow-up', summary: 'y' }] } }, jobs: {} };
  const s = await serve(t, { root, state, cache });
  const over = (await s.get('/')).body;
  const needs = over.slice(over.indexOf('data-card="needs"'), over.indexOf('data-card="warnings"'));
  const block = copies(needs).find(c => c.startsWith('DevTest overseer note'));
  assert.ok(block, 'a copy-for-overseer button on the item'); assert.match(needs, /<span data-copy-label>Copy for overseer<\/span>/);
  assert.match(block, /^What is wrong: Job b485512f \(codex review #41\) is blocked: retry_exhausted\.$/m);
  assert.match(block, /^Job b485512f78df4a50af28f7b192a30710: status blocked, kind review, provider codex, ref #41, attempts 1, last event retry_exhausted, postcondition verdict PR #41 head 4444444, updated /m);
  assert.match(block, /^PR #41 latest review: CHANGES by codex at 4444444 \(current head\), .*1 blocking finding\(s\)$/m);
  assert.match(block, /^Command: ai-supervisor status b485512f78df4a50af28f7b192a30710$/m);
  assert.match(block, /^Log \(reconcile\.log\):\n  2026-10-31 18:00 UTC tick ok; ingested CHANGES on PR #41/m);
  assert.match(block, /skipped review 41 \(codex\): lease held; token \[token\] from \[ip\]/);
  for (const bad of [FAKE_GH, '192.168.13.1', 'hidden-worktree-path', 'sess-secret-value', 'f'.repeat(32)]) {
    assert.ok(!block.includes(bad), `copy text holds ${bad}`); assert.ok(!over.includes(bad), `page holds ${bad}`);
  }
  const api = (await s.get('/api/view.json')).body;
  for (const bad of [FAKE_GH, '192.168.13.1', 'sess-secret-value']) assert.ok(!api.includes(bad), `view json holds ${bad}`);
});
test('copy for overseer on each health card: a compact plain-text block with the card facts and relevant log lines', async t => {
  const root = stateRoot(t, { log: SAMPLE, installed: H(1), installedAt: NOW - 30 * 3600000, leases: [{ job: 'c'.repeat(32), at: NOW - 3600000 }], selfUpgrade: { prechecked: { [H(2)]: NOW - 7200000 } } });
  const body = (await (await serve(t, { root, cfg: config(repoWith(t, { local: H(1), origin: H(2) })), cache })).get('/supervisor')).body;
  const blocks = copies(body).filter(c => c.startsWith('DevTest overseer note'));
  assert.equal(blocks.length, 5);
  const by = name => blocks.find(b => b.split('\n')[1].startsWith(`Supervisor ${name}:`));
  assert.match(by('Version'), /^- pre-check latched for 2222222 at 2026-10-31 16:07 UTC \(this is origin\/main\)$/m); assert.match(by('Version'), /^Command: ai-supervisor self-upgrade status$/m);
  assert.match(by('Last tick'), /^Supervisor Last tick: OK$/m); assert.match(by('Last tick'), /^What is wrong: nothing; ok 2m ago$/m); assert.match(by('Last tick'), /^  2026-10-31 18:05 UTC tick ok; actions claude implement #72/m);
  assert.match(by('Leases'), /^What is wrong: 1 job holds leases, 1 stale; a stale lease blocks new jobs[\s\S]*^- lease of job c{32} \(unknown agent\), age 1h 0m: no job record exists for this lease$/m);
  assert.match(by('Errors'), /^Log \(reconcile\.log\):$/m); assert.match(by('Errors'), /supervisor cli unreadable/);
  assert.match(by('Local repo drift'), /^- local main 1111111$/m); assert.match(by('Local repo drift'), /^- origin\/main 2222222/m);
  for (const b of blocks) { assert.ok(b.length <= 4000); assert.doesNotMatch(b, /<|&lt;/, 'plain text, not HTML'); }
  // installed after the last error: the Errors card is green and its copy text does not quote older errors
  const later = copies((await (await serve(t, { root: stateRoot(t, { log: SAMPLE, installed: H(1), installedAt: NOW - 11 * MIN }), cache })).get('/supervisor')).body).find(b => b.split('\n')[1] === 'Supervisor Errors: OK');
  assert.ok(later); assert.doesNotMatch(later, /supervisor cli unreadable|ENOENT/); assert.match(later, /^Log \(reconcile\.log\): no related line$/m);
});
test('hostile log text is escaped on every Supervisor page', async t => {
  const log = logLine(isoAgo(MIN), { team: { error: '<img src=x onerror=alert(1)>', skipped: [{ what: '<b>w</b>', reason: '"><script>x</script>' }], actions: [{ agent: '<i>a</i>', type: 'review', pr: 3 }] } });
  const s = await serve(t, { root: stateRoot(t, { log }), cache });
  for (const u of ['/supervisor', '/supervisor/ticks', '/supervisor/upgrades']) {
    const b = (await s.get(u)).body;
    assert.doesNotMatch(b, /<img src=x/); assert.doesNotMatch(b, /<script>x/); assert.doesNotMatch(b, /<b>w<\/b>/); assert.doesNotMatch(b, /<i>a<\/i>/); assert.equal((b.match(/<script/g) || []).length, 2, u); assert.equal((b.match(/<script(?![^>]*\bsrc=)/g) || []).length, 0, u + ': no inline script');
  }
});

// ---- browser-side copy logic and phone layout
test('copy fallbacks: plain-HTTP LAN pages skip the Clipboard API; feedback is shown either way', () => {
  assert.deepEqual(copyMethods({ secure: false, clipboard: true, execCommand: true }), ['exec', 'manual'], 'not a secure context');
  assert.deepEqual(copyMethods({ secure: true, clipboard: true, execCommand: true }), ['clipboard', 'exec', 'manual']);
  assert.deepEqual(copyMethods({ secure: true, clipboard: false, execCommand: false }), ['manual']);
  assert.deepEqual(copyMethods(), ['manual']);
  assert.equal(copyFeedback(true).label, 'Copied'); assert.equal(copyFeedback(true).state, 'copied'); assert.equal(copyFeedback(false).state, 'failed');
  const app = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
  assert.match(app, /button\[data-copy\]/); assert.match(app, /b\.hidden = false/); assert.match(app, /execCommand\('copy'\)/); assert.match(app, /e\.stopPropagation\(\)/);
  assert.match(app, /font-size:16px/, 'no zoom on iOS when the textarea takes focus'); assert.doesNotMatch(app, /fetch\(|XMLHttpRequest|sendBeacon/, 'the script still sends nothing');
});
test('phone layout: copy targets are 44px, overseer buttons span the card, health facts stack, [hidden] wins over component display', async t => {
  const css = fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8');
  assert.match(css, /\[hidden\]\{display:none!important\}/);
  const phone = css.slice(css.indexOf('@media(max-width:639px)', css.indexOf('.copy.tbtn{min-width:28px')));
  assert.match(phone, /\.copy\.tbtn\{min-width:44px;min-height:44px\}/); assert.match(phone, /\.btn\.overseer\{width:100%/); assert.match(phone, /\.card\.health dl\.kv\{grid-template-columns:1fr\}/);
  for (const sev of ['action', 'warning', 'info', 'ok']) assert.match(css, new RegExp(`\\.card\\.hc-${sev}\\{border-top-color:var\\(--${sev}\\)\\}`));
});

// Runs the real dashui/app.js against a minimal fake DOM: the copy buttons are revealed, a click copies through the
// execCommand fallback on a plain-HTTP page, shows "Copied", does not toggle the table row, and a failed copy opens the
// manual dialog with the text selected. (A real-browser run is in tests/supervisor-page-smoke.mjs.)
class FakeEl {
  constructor(tag, { dataset = {}, title = '', children = [] } = {}) {
    Object.assign(this, { tagName: tag.toUpperCase(), dataset, title, children, hidden: true, textContent: '', value: '', style: {}, attrs: {}, listeners: {}, removed: false, className: '' });
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; }
  querySelector(sel) { return sel === '[data-copy-label]' ? this.children[0] || null : null; }
  querySelectorAll() { return []; }
  closest() { return null; }
  focus() { globalThis.__fake.focused = this; } select() {} setSelectionRange() {}
  remove() { this.removed = true; } append(...els) { this.children.push(...els); }
}
async function runApp({ execResult }) {
  const label = new FakeEl('span'); label.textContent = 'Copy for overseer';
  const button = new FakeEl('button', { dataset: { copy: 'DevTest overseer note\nline two' }, title: 'Copy a plain-text summary for the overseer', children: [label] });
  const live = new FakeEl('p'), body = new FakeEl('body'), timers = [];
  const fake = { copied: [], focused: null };
  const doc = {
    documentElement: { dataset: {}, classList: { add() {}, remove() {} } }, body,
    querySelector: sel => (sel === '#copy-status' ? live : sel === '.copy-manual' ? body.children.find(c => c.className === 'copy-manual' && !c.removed) || null : null),
    querySelectorAll: sel => (sel === 'button[data-copy]' ? [button] : []),
    createElement: tag => new FakeEl(tag),
    execCommand: cmd => { fake.copied.push([cmd, fake.focused?.value]); return execResult; }
  };
  const saved = {}; const set = (k, v) => { saved[k] = Object.getOwnPropertyDescriptor(globalThis, k); Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true }); };
  set('document', doc); set('window', globalThis); set('isSecureContext', false); set('navigator', {}); set('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  set('setInterval', () => 0); set('setTimeout', fn => { timers.push(fn); return timers.length; }); set('clearTimeout', () => {}); set('addEventListener', () => {}); set('innerWidth', 390); set('innerHeight', 800); set('location', { pathname: '/supervisor', search: '', origin: 'http://x' }); set('sessionStorage', { getItem: () => null, setItem() {} }); set('history', { length: 1 }); set('scrollTo', () => {}); set('scrollY', 0); set('requestAnimationFrame', fn => { fn(); return 1; }); set('__fake', fake);
  try {
    await import(`../supervisor/dashui/app.js?run=${Math.random()}`);
    assert.equal(button.hidden, false, 'the script reveals copy buttons');
    let stopped = false;
    for (const fn of button.listeners.click) await fn({ stopPropagation: () => { stopped = true; }, target: button });
    return { button, label, live, body, fake, stopped, timers };
  } finally { for (const [k, d] of Object.entries(saved)) { if (d) Object.defineProperty(globalThis, k, d); else delete globalThis[k]; } }
}
test('app.js copy: execCommand fallback on plain HTTP, visible confirmation, no row toggle; failure opens a manual-copy dialog', async () => {
  const ok = await runApp({ execResult: true });
  assert.deepEqual(ok.fake.copied, [['copy', 'DevTest overseer note\nline two']], 'the exact data-copy text was selected and copied');
  assert.equal(ok.stopped, true); assert.equal(ok.button.dataset.state, 'copied'); assert.equal(ok.label.textContent, 'Copied'); assert.equal(ok.live.textContent, 'Copied to the clipboard');
  assert.ok(ok.body.children.every(c => c.removed), 'the temporary textarea is removed');
  ok.timers.at(-1)(); assert.equal(ok.label.textContent, 'Copy for overseer', 'the label returns after the confirmation'); assert.equal(ok.button.dataset.state, undefined);
  const bad = await runApp({ execResult: false });
  assert.equal(bad.button.dataset.state, 'failed'); assert.equal(bad.label.textContent, 'Select and copy');
  const dialog = bad.body.children.find(c => c.className === 'copy-manual' && !c.removed);
  assert.ok(dialog, 'manual dialog shown'); assert.equal(dialog.children[0].value, 'DevTest overseer note\nline two'); assert.equal(dialog.children[0].readOnly, true);
});
