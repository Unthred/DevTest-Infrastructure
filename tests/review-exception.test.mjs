// One-off homeowner review exception for named pull requests (issue #318, proposal D-027). Fake GitHub, fake jobs, fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = Date.now();   // config validation reads the wall clock; the Team clock is fixed at this value
const DAY = 86400000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REG = (ex = 'homeowner-approved') => `## D-020 — x\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n\n## D-026 — e\n- Status: ${ex}\n`;
const exception = (over = {}) => ({ agent: 'claude', full_review: { model: 'opus', effort: 'medium' }, commit_review: { model: 'sonnet', effort: 'medium' },
  prs: [{ pr: 77, expires_at: new Date(NOW + 5 * DAY).toISOString() }], ...over });
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, fix: { model: 'sonnet', effort: 'medium' }, 'ci-fix': { model: 'sonnet', effort: 'medium' }, rebase: { model: 'sonnet', effort: 'low' }, review: { model: 'opus', effort: 'medium' }, strong: { model: 'opus', effort: 'high' } }, codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  review_exception: exception(),
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...over });
const pr = (n, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: `claude/issue-${n}-x`, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const manifests = { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };

function world(t, { pulls = [pr(77, H(5))], cfg = config(), register = REG(), now = { t: NOW }, merged = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ex-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], merges: [], created: [] };
  const gh = { pulls,
    listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [],
    getMergedPull: async n => (merged[n] ? { number: n, state: merged[n] } : null),
    comment: async (n, body) => calls.comments.push([n, body]), addLabel: async () => {}, removeLabel: async () => {}, hasComment: async () => false, findIssueByMarker: async () => null, board: async () => {},
    createIssue: async () => 300,
    merge: async (n, head) => { const p = gh.pulls.find(x => x.number === n); if (!p || p.headRefOid !== head) throw new Error('head moved'); calls.merges.push([n, head]); } };
  const jobs = { states: {}, seq: 0, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register, clock: { now: () => now.t }, limitedOf: () => ({ out: false }), providerModels: manifests });
  // Opus wrote the PR head: D-024 alone would refuse an Opus review of it.
  team.s.jobs.aaaaaaaa = { kind: 'implement', agent: 'claude', model: 'opus', pr: 77, branch: 'claude/issue-77-x', ingested: true, at: NOW - 1000 };
  return { gh, jobs, team, calls, now };
}
const finish = async (w, verdict = 'PASS') => {
  const [id, rec] = Object.entries(w.team.s.jobs).at(-1);
  const d = path.join(w.team.dir, 'inbox', rec.ticket); fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'verdict.json'), JSON.stringify({ pr: rec.pr, headSha: rec.head, verdict, findings: verdict === 'CHANGES' ? [{ kind: 'blocking', text: 'x' }] : [], commandsRun: ['node --test'] }));
  w.jobs.states[id].status = 'completed'; const report = { ingested: [] }; await w.team.ingest(report); return { rec, report };
};
const types = actions => actions.map(a => `${a.type}${a.exceptionStage ? ':' + a.exceptionStage : ''}`);

test('listed PR: whole-PR Opus review, then Sonnet review of the Opus commits, then merge recorded as using the exception', async t => {
  const w = world(t);
  const r1 = await w.team.tick();
  assert.deepEqual(types(r1.actions), ['review:full']);
  assert.equal(w.calls.created.at(-1).model, 'opus');   // D-024 alone would have refused: Opus wrote the head
  await finish(w);
  assert.deepEqual(types((await w.team.tick()).actions), ['review:commits'], 'one PASS is not enough to merge');
  assert.equal(w.calls.created.at(-1).model, 'sonnet');
  const ranges = JSON.parse(fs.readFileSync(path.join(w.team.dir, 'inbox', Object.values(w.team.s.jobs).at(-1).ticket, 'model-commits.json'), 'utf8'));
  assert.equal(ranges.model, 'opus'); assert.equal(ranges.ranges.length, 1); assert.equal(ranges.ranges[0].from, 'merge-base');
  assert.match(w.calls.created.at(-1).prompt, /commits written on the opus model/);
  assert.equal(w.calls.merges.length, 0);
  await finish(w);
  assert.deepEqual(types((await w.team.tick()).actions), ['merge']);
  assert.deepEqual(w.calls.merges, [[77, H(5)]]);
  assert.equal(w.team.s.mergeLog.at(-1).exception, 'D-027');
  assert.ok(w.calls.comments.some(([n, b]) => n === 77 && /review exception \(D-027\)/.test(b)));
  assert.equal(w.team.s.exceptionEnded[77].reason, 'merged');
  assert.equal(w.team.exceptionFor(77), null);
});

test('unlisted PR: D-024 is unchanged (one independent PASS merges; an Opus review of an Opus-written head is still refused)', async t => {
  const w = world(t, { pulls: [pr(88, H(6))] });
  w.team.s.jobs.aaaaaaaa.pr = 88; w.team.s.jobs.aaaaaaaa.branch = 'claude/issue-88-x';
  assert.equal(w.team.exceptionFor(88), null);
  const r = await w.team.tick();
  assert.deepEqual(r.actions.map(a => [a.type, a.agent, a.exceptionStage]), [['review', 'codex', undefined]], 'claude (opus) would review its own model: refused; only the other provider reviews, and no exception stage');
  // a recorded independent PASS on an unlisted PR merges on one review, as before
  w.team.s.verdicts[`88:${H(6)}`] = { verdict: 'PASS', reviewer: 'codex', job: 'b'.repeat(32), independent: true, findings: [], commandsRun: ['x'], at: NOW };
  assert.deepEqual(types((await w.team.plan())), ['merge']);
  assert.equal((await w.team.plan())[0].exception, undefined);
});

test('a PASS missing: the commit review alone, or the whole-PR review alone, never merges', async t => {
  const w = world(t);
  const vk = `77:${H(5)}`;
  w.team.s.exceptionReviews[vk] = { verdict: 'PASS', reviewer: 'claude', job: 'c'.repeat(32), model: 'sonnet', exceptionStage: 'commits', findings: [], commandsRun: ['x'], at: NOW };
  assert.ok(!types(await w.team.plan()).includes('merge'), 'commit PASS without the whole-PR PASS');
  assert.deepEqual(types(await w.team.plan()), ['review:full']);
  delete w.team.s.exceptionReviews[vk];
  w.team.s.verdicts[vk] = { verdict: 'PASS', reviewer: 'claude', job: 'd'.repeat(32), model: 'opus', exceptionStage: 'full', independent: true, findings: [], commandsRun: ['x'], at: NOW };
  assert.ok(!types(await w.team.plan()).includes('merge'), 'whole-PR PASS without the commit PASS');
  // an ordinary D-024 PASS (no exception stage) does not satisfy the whole-PR step either
  w.team.s.verdicts[vk] = { verdict: 'PASS', reviewer: 'codex', job: 'd'.repeat(32), independent: true, findings: [], commandsRun: ['x'], at: NOW };
  assert.ok(!types(await w.team.plan()).includes('merge'));
  // a commit PASS from the same model as the whole-PR PASS does not count
  w.team.s.verdicts[vk] = { verdict: 'PASS', reviewer: 'claude', job: 'd'.repeat(32), model: 'opus', exceptionStage: 'full', independent: true, findings: [], commandsRun: ['x'], at: NOW };
  w.team.s.exceptionReviews[vk] = { verdict: 'PASS', reviewer: 'claude', job: 'c'.repeat(32), model: 'opus', exceptionStage: 'commits', findings: [], commandsRun: ['x'], at: NOW };
  assert.ok(!types(await w.team.plan()).includes('merge'));
});

test('head moved after both PASSes: neither carries; both reviews run again on the new head', async t => {
  const w = world(t);
  const vk = `77:${H(5)}`;
  w.team.s.verdicts[vk] = { verdict: 'PASS', reviewer: 'claude', job: 'd'.repeat(32), model: 'opus', exceptionStage: 'full', independent: true, findings: [], commandsRun: ['x'], at: NOW };
  w.team.s.exceptionReviews[vk] = { verdict: 'PASS', reviewer: 'claude', job: 'c'.repeat(32), model: 'sonnet', exceptionStage: 'commits', findings: [], commandsRun: ['x'], at: NOW };
  assert.deepEqual(types(await w.team.plan()), ['merge']);
  w.gh.pulls[0] = pr(77, H(7));
  assert.deepEqual(types(await w.team.plan()), ['review:full']);
});

test('expiry, ended and unapproved: the exception stops applying and the D-024 route returns', async t => {
  const w = world(t);
  assert.ok(w.team.exceptionFor(77));
  w.now.t = NOW + 6 * DAY;   // past expires_at, PR still open
  assert.equal(w.team.exceptionFor(77), null);
  const report = {}; await w.team.plan(); await w.team.endExceptions(report);
  assert.deepEqual(report.exceptionEnded, [{ pr: 77, reason: 'expired' }]);
  // a verdict job started under the exception is not recorded once it has ended
  const w2 = world(t);
  await w2.team.tick();
  w2.now.t = NOW + 6 * DAY;
  const { report: rep } = await finish(w2);
  assert.match(rep.ingested[0].error, /exception ended/);
  assert.equal(Object.keys(w2.team.s.verdicts).length, 0);
  // closed / merged elsewhere ends it; an unknown state does not
  const w3 = world(t, { merged: { 77: 'CLOSED' } });
  w3.gh.pulls = []; await w3.team.plan(); const r3 = {}; await w3.team.endExceptions(r3);
  assert.deepEqual(r3.exceptionEnded, [{ pr: 77, reason: 'closed' }]);
  const w4 = world(t); w4.gh.pulls = []; await w4.team.plan(); const r4 = {}; await w4.team.endExceptions(r4);
  assert.equal(r4.exceptionEnded, undefined);
  assert.ok(w4.team.exceptionFor(77));
  // not homeowner-approved: inactive
  assert.equal(world(t, { register: REG('agent-proposal') }).team.exceptionFor(77), null);
});

test('fixes: Sonnet only, never escalated; the fix limit stops the PR with one Needs you reason', async t => {
  const w = world(t);
  const vk = `77:${H(5)}`;
  w.team.s.verdicts[vk] = { verdict: 'CHANGES', reviewer: 'claude', job: 'd'.repeat(32), model: 'opus', exceptionStage: 'full', independent: true, findings: [{ kind: 'blocking', text: 'x' }], commandsRun: ['x'], at: NOW };
  const r = await w.team.tick();
  assert.deepEqual(types(r.actions), ['fix']);
  assert.equal(w.calls.created.at(-1).model, 'sonnet');
  w.team.s.fixAttempts[vk] = 2;
  assert.deepEqual(types(await w.team.plan()), [], 'no escalated round for a listed PR');
  const reasons = w.team.stallReasons(w.gh.pulls[0]);
  assert.equal(reasons.filter(x => x.code === 'fix-limit').length, 1);
  assert.match(reasons.find(x => x.code === 'fix-limit').text, /does not escalate/);
  // an unlisted PR still gets its escalated round
  const u = world(t, { pulls: [pr(88, H(6))], cfg: config({ models: undefined }) });
  assert.equal(u.team.exceptionFor(88), null);
});

test('config validation: dates, models, duplicates and unknown fields', () => {
  const ok = config();
  assert.doesNotThrow(() => validateTeamConfig(structuredClone(ok)));
  const bad = over => () => validateTeamConfig(config({ review_exception: exception(over) }));
  assert.throws(bad({ agent: 'nobody' }), /review_exception/);
  assert.throws(bad({ prs: [{ pr: 1 }] }), /review_exception/);
  assert.throws(bad({ prs: [{ pr: 1, expires_at: 'soon' }] }), /review_exception/);
  assert.throws(bad({ prs: [{ pr: 1, expires_at: '2099-01-01T00:00:00Z' }] }), /31 days/);
  assert.throws(bad({ prs: [{ pr: 1, expires_at: '2026-11-09T00:00:00Z' }, { pr: 1, expires_at: '2026-11-09T00:00:00Z' }] }), /review_exception/);
  assert.throws(bad({ commit_review: { model: 'opus' } }), /different models/);
  assert.throws(bad({ extra: 1 }), /review_exception/);
});
