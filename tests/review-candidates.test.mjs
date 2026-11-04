// Issue #258: Foreman tries the next review model before holding a PR under D-024; a clean rebase is not authorship; a PR nobody
// can review raises one Needs you item with the real reasons. Fake GitHub, fake jobs, real git only for the rebase classification.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { checkRebase } from '../supervisor/rebasecheck.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = 1_800_000_000_000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n\n## D-021 — y\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n';
const CANDIDATES = [{ model: 'opus', effort: 'medium' }, { model: 'sonnet', effort: 'medium' }];
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, review: { model: 'opus', effort: 'medium' }, review_candidates: CANDIDATES }, codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...over });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const manifests = { claude: { aliases: ['opus', 'sonnet', 'haiku'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };
const OUT = { codex: 'codex weekly limit' };

function world(t, { pulls = [pr(137, 'claude/issue-72-x', H(5))], out = OUT, cfg = config(), headWriterOf = () => null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-cand-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { created: [] };
  const gh = { pulls, issues: [], listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {}, hasComment: async () => false, findIssueByMarker: async () => null, board: async () => {} };
  const jobs = { active: [], states: {}, seq: 0, listActive: async () => jobs.active, get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const state = { out };
  const limitedOf = agent => (state.out[agent] ? { out: true, reason: state.out[agent] } : { out: false });
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => NOW }, limitedOf, providerModels: manifests, headWriterOf });
  return { gh, jobs, team, calls, state };
}
const job = (w, id, over) => { w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '72', model: 'opus', branch: 'claude/issue-72-x', pr: 137, ingested: true, at: NOW - 5000, ...over }; };
const claudeReview = async w => (await w.team.plan()).find(a => a.type === 'review' && a.agent === 'claude');

test('Opus-only writers: the review runs on Sonnet', async t => {
  const w = world(t); job(w, 'w1', {});
  const act = await claudeReview(w);
  assert.ok(act); await w.team.execute(act);
  assert.equal(w.calls.created[0].model, 'sonnet');
});

test('no writer record of the same model: the first candidate (Opus) is still used', async t => {
  const w = world(t); job(w, 'w1', { model: 'sonnet' });
  await w.team.execute(await claudeReview(w));
  assert.equal(w.calls.created[0].model, 'opus');
});

test('Opus writers plus a clean Sonnet rebase: the review still runs on Sonnet', async t => {
  const w = world(t); job(w, 'w1', {}); job(w, 'r1', { kind: 'rebase', model: 'sonnet', rebase: { resolvedConflicts: false } });
  assert.deepEqual(w.team.writersOf(w.gh.pulls[0]).map(x => x.model), ['opus']);
  await w.team.execute(await claudeReview(w));
  assert.equal(w.calls.created[0].model, 'sonnet');
});

test('Opus writers plus a Sonnet rebase that resolved conflicts, or an unknown one: no Claude review', async t => {
  for (const rebase of [{ resolvedConflicts: true }, {}, undefined]) {
    const w = world(t); job(w, 'w1', {}); job(w, 'r1', { kind: 'rebase', model: 'sonnet', ...(rebase ? { rebase } : {}) });
    assert.equal(await claudeReview(w), undefined, JSON.stringify(rebase));
    assert.match(w.team.held.claude.review, /review refused/);
  }
});

test('Opus and Sonnet writers (PR 137): no Claude review, and one Needs you item per PR with every reason', async t => {
  const w = world(t); job(w, 'w1', {}); job(w, 'w2', { kind: 'fix', model: 'sonnet' });
  assert.equal(await claudeReview(w), undefined);
  const [u, ...more] = w.team.unreviewable(w.gh.pulls);
  assert.equal(more.length, 0); assert.equal(u.pr, 137); assert.equal(u.head, H(5));
  assert.match(u.reasons.join('|'), /claude: claude would review PR #137/); assert.match(u.reasons.join('|'), /codex: out of allowance \(codex weekly limit\)/);
  // the dashboard raises it as an action item naming the PR, head and reason
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-cand-d-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const solo = config({ agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } }); delete solo.models.agents.codex;
  const v = await buildView({ config: solo, root, jobs: [], events: [], state: { jobs: w.team.s.jobs }, register: REGISTER,
    cache: { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls: w.gh.pulls.map(p => ({ ...p, labels: [] })), issues: [] }, snapshots: [], now: NOW });
  const items = v.panels.needsYou.filter(a => a.id === 'noreviewer-137');
  assert.equal(items.length, 1); assert.equal(items[0].severity, 'action');
  assert.match(items[0].text, /137/); assert.match(items[0].text, /5555555/); assert.match(items[0].text, /the model that wrote it/);
});

test('no Needs you item while a reviewer is available, and none once reviewed', async t => {
  const w = world(t); job(w, 'w1', {});
  assert.deepEqual(w.team.unreviewable(w.gh.pulls), []);
  const x = world(t, { out: {} }); job(x, 'w1', {}); job(x, 'w2', { kind: 'fix', model: 'sonnet' });
  assert.deepEqual(x.team.unreviewable(x.gh.pulls), [], 'codex is independent and available');
  const y = world(t); job(y, 'w1', {}); job(y, 'w2', { kind: 'fix', model: 'sonnet' }); y.team.s.verdicts['137:' + H(5)] = { verdict: 'PASS', reviewer: 'x', job: 'j' };
  assert.deepEqual(y.team.unreviewable(y.gh.pulls), []);
});

test('held reasons for several PRs are all kept, per agent and per PR', async t => {
  const w = world(t, { pulls: [pr(137, 'claude/issue-72-x', H(5)), pr(217, 'claude/issue-80-y', H(6))] });
  job(w, 'w1', {}); job(w, 'w2', { kind: 'fix', model: 'sonnet' });
  job(w, 'w3', { pr: 217, branch: 'claude/issue-80-y', key: '80' }); job(w, 'w4', { pr: 217, branch: 'claude/issue-80-y', kind: 'fix', model: 'sonnet', key: '80' });
  await w.team.plan();
  assert.match(w.team.held.claude.review, /PR #137/); assert.match(w.team.held.claude.review, /PR #217/);
  assert.match(w.team.heldPr['claude:review:137'], /PR #137/); assert.match(w.team.heldPr['claude:review:217'], /PR #217/);
});

test('the low-allowance re-review entry keeps its rule, and the independence check applies to the model it picks', async t => {
  const cfg = config(); cfg.models.agents.claude.low = { model: 'sonnet', effort: 'low' };
  const w = world(t, { cfg }); job(w, 'w1', { model: 'opus' }); w.team.allowanceOf = () => 0.9;   // allowance is low
  const act = { agent: 'claude', pr: 137, branch: 'claude/issue-72-x', key: 'k', reReview: true };
  assert.equal(w.team.modelFor(act, 'review', {}, true).model, 'sonnet', 'the low entry, not the candidate list');
  assert.equal(w.team.reviewRefusal('claude', w.gh.pulls[0], 'k'), null, 'sonnet differs from the opus writer');
  job(w, 'w2', { kind: 'fix', model: 'sonnet' });
  assert.match(w.team.reviewRefusal('claude', w.gh.pulls[0], 'k'), /the model that wrote it/, 'the low entry is refused when it wrote the head');
});

test('a second opinion still blocks merging a PASS from the fallback model', async t => {
  const cfg = config({ second_opinion: { paths: ['supervisor/upgrade.mjs'], reviewer: 'codex' } });
  const w = world(t, { cfg, out: {} }); job(w, 'w1', {});
  w.gh.listPullFiles = async () => ['supervisor/upgrade.mjs'];
  w.team.s.verdicts['137:' + H(5)] = { verdict: 'PASS', reviewer: 'claude', job: 'j', independent: true, at: NOW - 1000 };
  const acts = await w.team.plan();
  assert.equal(acts.some(a => a.type === 'merge'), false);
  assert.ok(acts.some(a => a.type === 'review' && a.secondOpinion && a.agent === 'codex'));
});

test('review_candidates is validated', () => {
  assert.doesNotThrow(() => validateTeamConfig(config()));
  for (const bad of [[], 'opus', [{ model: 5 }], [{ model: 'opus', x: 1 }], Array(9).fill({ model: 'opus' })]) {
    const cfg = config(); cfg.models.agents.claude.review_candidates = bad;
    assert.throws(() => validateTeamConfig(cfg), /review_candidates/, JSON.stringify(bad));
  }
});

test('the shipped config lists only Opus for Claude (Sonnet writes, issue #316), and no Haiku or Fable', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.deepEqual(shipped.models.agents.claude.review_candidates.map(c => c.model), ['opus']);
  assert.equal(shipped.models.agents.codex.review_candidates, undefined);
});

// --- real git: does the rebase resolve a conflict?
const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...a) => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (cwd, file, text, msg) => { fs.writeFileSync(path.join(cwd, file), text); git(cwd, 'add', '-A'); git(cwd, 'commit', '-q', '-m', msg); return git(cwd, 'rev-parse', 'HEAD'); };
function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-cand-g-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main', 'r'); const r = path.join(dir, 'r');
  commit(r, 'shared.txt', 'a\nb\nc\n', 'base');
  git(r, 'checkout', '-q', '-b', 'feat'); commit(r, 'shared.txt', 'a\nB-feature\nc\n', 'feature edit'); const old = git(r, 'rev-parse', 'HEAD');
  git(r, 'checkout', '-q', 'main'); return { r, old };
}
test('a rebase onto unrelated main changes is clean; one that needed a conflict resolution is flagged; a changed result is flagged', t => {
  const a = repo(t);
  commit(a.r, 'other.txt', 'x\n', 'main moves'); git(a.r, 'checkout', '-q', 'feat'); git(a.r, 'rebase', '-q', 'main');
  assert.equal(checkRebase({ repoPath: a.r, base: 'main', oldHead: a.old, newHead: git(a.r, 'rev-parse', 'HEAD') }).resolvedConflicts, false);
  // moving main on afterwards does not turn a clean rebase into a resolved one
  git(a.r, 'checkout', '-q', 'main'); commit(a.r, 'later.txt', 'y\n', 'main moves again');
  assert.equal(checkRebase({ repoPath: a.r, base: 'main', oldHead: a.old, newHead: git(a.r, 'rev-parse', 'feat') }).resolvedConflicts, false);
  const b = repo(t);
  commit(b.r, 'shared.txt', 'a\nB-main\nc\n', 'main edits same line'); git(b.r, 'checkout', '-q', 'feat');
  assert.throws(() => git(b.r, 'rebase', '-q', 'main'));   // conflict
  fs.writeFileSync(path.join(b.r, 'shared.txt'), 'a\nB-main+feature\nc\n'); git(b.r, 'add', '-A'); execFileSync('git', [...G, 'rebase', '--continue'], { cwd: b.r, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  assert.equal(checkRebase({ repoPath: b.r, base: 'main', oldHead: b.old, newHead: git(b.r, 'rev-parse', 'HEAD') }).resolvedConflicts, true);
  // a "clean" rebase that also changed something else is not clean
  const c = repo(t);
  commit(c.r, 'other.txt', 'x\n', 'main moves'); git(c.r, 'checkout', '-q', 'feat'); git(c.r, 'rebase', '-q', 'main'); commit(c.r, 'extra.txt', 'sneaky\n', 'extra');
  assert.equal(checkRebase({ repoPath: c.r, base: 'main', oldHead: c.old, newHead: git(c.r, 'rev-parse', 'HEAD') }).resolvedConflicts, true);
});

test('recordRebase stores the classification on the job; a check without it records nothing', async t => {
  for (const [res, want] of [[false, false], [true, true], [undefined, undefined]]) {
    const w = world(t); job(w, 'r1', { kind: 'rebase', model: 'sonnet', ingested: false, head: H(5), base: 'main' });
    w.gh.pulls = [pr(137, 'claude/issue-72-x', H(6))];
    w.team.git.checkRebase = async () => ({ commits: [], missing: [], ...(res === undefined ? {} : { resolvedConflicts: res }) });
    await w.team.recordRebase('r1', w.team.s.jobs.r1, {});
    assert.equal(w.team.s.jobs.r1.rebase.resolvedConflicts, want);
  }
});

// Issue #351: a head written outside any job. The writer is known only from evidence Foreman finds itself.
const HAND = pr(342, 'claude/issue-341-x', 'e270645'.padEnd(40, 'a'));
test('no job record and no evidence: the writer is unknown, every Claude model is refused as "writer unknown", Codex out of allowance', async t => {
  const w = world(t, { pulls: [HAND] });
  assert.equal(await claudeReview(w), undefined);
  const [u] = w.team.unreviewable(w.gh.pulls);
  assert.equal(u.writerUnknown, true);
  assert.ok(u.tried.filter(x => x.startsWith('claude')).every(x => /refused, writer unknown/.test(x)), u.tried.join('|'));
  assert.doesNotMatch(u.reasons.join(' '), /the model that wrote it/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-cand-d-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const solo = config({ agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } }); delete solo.models.agents.codex;
  const v = await buildView({ config: solo, root, jobs: [], events: [], state: { jobs: {} }, register: REGISTER,
    cache: { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls: w.gh.pulls.map(p => ({ ...p, labels: [] })), issues: [] }, snapshots: [], now: NOW });
  const [item] = v.panels.needsYou.filter(a => a.id === 'noreviewer-342');
  assert.ok(item); assert.match(item.text, /writer of this head is unknown/); assert.doesNotMatch(item.text, /wrote this head|the model that wrote it/);
  assert.match(JSON.stringify(item), /Writer unknown/);
});

test('session-log evidence for the exact head records the writer; a different model reviews, the same model does not', async t => {
  const seen = [];
  const w = world(t, { pulls: [HAND], headWriterOf: a => { seen.push(a); return { provider: 'claude', models: ['claude-opus-5-5'], sessions: ['abcd1234'] }; } });
  const act = await claudeReview(w);
  assert.ok(act, 'a review on another model is possible'); await w.team.execute(act);
  assert.equal(w.calls.created[0].model, 'sonnet');
  assert.deepEqual(w.team.writersOf(HAND).map(x => x.model), ['opus']);
  assert.equal(seen[0].head, HAND.headRefOid);
});

test('evidence of two writers, an unrecognised model id, or a provider mismatch leaves no model provably different', async t => {
  for (const found of [{ provider: 'claude', models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }, { provider: 'claude', models: ['claude-mystery-1'] }, { provider: 'codex', models: ['claude-opus-5-5'] }]) {
    const w = world(t, { pulls: [HAND], headWriterOf: () => found });
    assert.equal(await claudeReview(w), undefined, JSON.stringify(found));
  }
});

test('a new head clears the record; a miss is retried only after five minutes; a job record wins over evidence', async t => {
  let n = 0; const w = world(t, { pulls: [HAND], headWriterOf: () => (++n, { provider: 'claude', models: ['claude-opus-5-5'] }) });
  await w.team.plan(); assert.ok(w.team.s.headWriters[`342:${HAND.headRefOid}`]);
  w.gh.pulls = [{ ...HAND, headRefOid: 'f'.repeat(40) }]; await w.team.plan();
  assert.deepEqual(Object.keys(w.team.s.headWriters), [`342:${'f'.repeat(40)}`]);
  assert.deepEqual(w.team.writersOf(w.gh.pulls[0]).map(x => x.model), ['opus']);
  const m = world(t, { pulls: [HAND], headWriterOf: () => (++n, null) }); const before = n;
  await m.team.plan(); await m.team.plan(); assert.equal(n - before, 1, 'miss cached');
});

// Issue #547: ingestion judges a hand-pushed head by the job's reviewed head, with the tick's view cleared, as dispatch does.
const TICKET = 'a'.repeat(32);
async function ingestReview(t, { model, evidence }) {
  const w = world(t, { pulls: [HAND] });
  if (evidence) w.team.s.headWriters[`342:${HAND.headRefOid}`] = { provider: 'claude', models: evidence, sessions: ['s1'], at: NOW, source: 'session-log' };
  w.team.view = null;   // the tick clears the view before ingestion
  const d = path.join(w.team.dir, 'inbox', TICKET); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'verdict.json'), JSON.stringify({ pr: 342, headSha: HAND.headRefOid, verdict: 'PASS', findings: [], commandsRun: ['node --test'] }));
  w.team.s.jobs.rv = { kind: 'review', agent: 'claude', model, pr: 342, head: HAND.headRefOid, branch: HAND.headRefName, ticket: TICKET, ingested: false, at: NOW - 5000 };
  w.jobs.states.rv = { id: 'rv', status: 'completed' };
  const report = { ingested: [] };
  await w.team.ingestOne('rv', w.team.s.jobs.rv, report);
  return { w, report };
}
test('hand-pushed head, evidence says opus wrote it: a sonnet review is accepted at ingestion with the view cleared', async t => {
  const { w, report } = await ingestReview(t, { model: 'sonnet', evidence: ['claude-opus-5-5'] });
  assert.equal(report.ingested[0].verdict, 'PASS'); assert.equal(w.team.s.verdicts[`342:${HAND.headRefOid}`].verdict, 'PASS');
  assert.deepEqual(w.team.refusedVerdicts([HAND]), []);
});
test('hand-pushed head, evidence says opus wrote it: an opus review is refused, settled once, and visible in Needs you', async t => {
  const { w, report } = await ingestReview(t, { model: 'opus', evidence: ['claude-opus-5-5'] });
  assert.match(report.ingested[0].error, /a model that wrote this pull request/); assert.equal(w.team.s.verdicts[`342:${HAND.headRefOid}`], undefined);
  assert.equal(w.team.s.jobs.rv.ingested, true);
  const [r] = w.team.refusedVerdicts([HAND]); assert.equal(r.pr, 342); assert.equal(r.reason, 'it wrote this head'); assert.ok(fs.existsSync(r.file));
  const item = await needsYouItem(t, w, 'noreviewer-refused-342');
  assert.equal(item.severity, 'action'); assert.match(item.text, /342/); assert.match(item.text, /verdict\.json/); assert.match(item.action || JSON.stringify(item), /different model/);
});
test('hand-pushed head with no evidence: any Claude review is refused as writer unknown and visible; a moved head or a recorded verdict hides it', async t => {
  const { w } = await ingestReview(t, { model: 'sonnet', evidence: null });
  const [r] = w.team.refusedVerdicts([HAND]); assert.equal(r.reason, 'writer unknown');
  const item = await needsYouItem(t, w, 'noreviewer-refused-342'); assert.match(item.text, /writer of this head is unknown/);
  assert.deepEqual(w.team.refusedVerdicts([{ ...HAND, headRefOid: 'f'.repeat(40) }]), []);
  w.team.s.verdicts[`342:${HAND.headRefOid}`] = { verdict: 'PASS', reviewer: 'codex', job: 'x' };
  assert.deepEqual(w.team.refusedVerdicts([HAND]), []);
});
async function needsYouItem(t, w, id) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rev-cand-n-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const v = await buildView({ config: w.team.c, root, jobs: [], events: [], state: { jobs: w.team.s.jobs, refusedReviews: w.team.s.refusedReviews, verdicts: w.team.s.verdicts }, register: REGISTER,
    cache: { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls: [{ ...HAND, labels: [] }], issues: [] }, snapshots: [], now: NOW });
  return v.panels.needsYou.find(a => a.id === id);
}
