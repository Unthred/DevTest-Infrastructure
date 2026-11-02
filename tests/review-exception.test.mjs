// One-off homeowner review exception for named pull requests (issue #318, proposal D-027). Fake GitHub, fake jobs, fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = Date.parse('2026-11-02T12:00:00Z');   // config validation reads the wall clock; the Team clock is fixed at this value
const DAY = 86400000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REG = (ex = 'homeowner-approved') => `## D-020 — x\n- Status: homeowner-approved\n\n## D-024 — z\n- Status: homeowner-approved\n\n## D-027 — e\n- Status: ${ex}\n`;
const exception = (over = {}) => ({ agent: 'claude', full_review: { model: 'opus', effort: 'medium' }, commit_review: { model: 'sonnet', effort: 'medium' },
  prs: [{ pr: 137, expires_at: new Date(NOW + 5 * DAY).toISOString() }], ...over });
const config = (over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'medium' }, fix: { model: 'sonnet', effort: 'medium' }, 'ci-fix': { model: 'sonnet', effort: 'medium' }, rebase: { model: 'sonnet', effort: 'low' }, review: { model: 'opus', effort: 'medium' }, strong: { model: 'opus', effort: 'high' } }, codex: { implement: { effort: 'high' }, review: { effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  review_exception: exception(),
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...over });
const pr = (n, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: `claude/issue-${n}-x`, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const manifests = { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'medium', 'high'] }, codex: { aliases: [], efforts: ['low', 'medium', 'high'] } };

function world(t, { pulls = [pr(137, H(5))], cfg = config(), register = REG(), now = { t: NOW }, merged = {} } = {}) {
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
  team.s.jobs.aaaaaaaa = { kind: 'implement', agent: 'claude', model: 'opus', pr: 137, branch: 'claude/issue-137-x', ingested: true, at: NOW - 1000 };
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
  assert.deepEqual(w.calls.merges, [[137, H(5)]]);
  assert.equal(w.team.s.mergeLog.at(-1).exception, 'D-027');
  assert.ok(w.calls.comments.some(([n, b]) => n === 137 && /review exception \(D-027\)/.test(b)));
  assert.equal(w.team.s.exceptionEnded[137].reason, 'merged');
  assert.equal(w.team.exceptionFor(137), null);
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
  const vk = `137:${H(5)}`;
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
  const vk = `137:${H(5)}`;
  w.team.s.verdicts[vk] = { verdict: 'PASS', reviewer: 'claude', job: 'd'.repeat(32), model: 'opus', exceptionStage: 'full', independent: true, findings: [], commandsRun: ['x'], at: NOW };
  w.team.s.exceptionReviews[vk] = { verdict: 'PASS', reviewer: 'claude', job: 'c'.repeat(32), model: 'sonnet', exceptionStage: 'commits', findings: [], commandsRun: ['x'], at: NOW };
  assert.deepEqual(types(await w.team.plan()), ['merge']);
  w.gh.pulls[0] = pr(137, H(7));
  assert.deepEqual(types(await w.team.plan()), ['review:full']);
});

test('expiry, ended and unapproved: the exception stops applying and the D-024 route returns', async t => {
  const w = world(t);
  assert.ok(w.team.exceptionFor(137));
  w.now.t = NOW + 6 * DAY;   // past expires_at, PR still open
  assert.equal(w.team.exceptionFor(137), null);
  const report = {}; await w.team.plan(); await w.team.endExceptions(report);
  assert.deepEqual(report.exceptionEnded, [{ pr: 137, reason: 'expired' }]);
  // a verdict job started under the exception is not recorded once it has ended
  const w2 = world(t);
  await w2.team.tick();
  w2.now.t = NOW + 6 * DAY;
  const { report: rep } = await finish(w2);
  assert.match(rep.ingested[0].error, /exception ended/);
  assert.equal(Object.keys(w2.team.s.verdicts).length, 0);
  // closed / merged elsewhere ends it; an unknown state does not
  const w3 = world(t, { merged: { 137: 'CLOSED' } });
  w3.gh.pulls = []; await w3.team.plan(); const r3 = {}; await w3.team.endExceptions(r3);
  assert.deepEqual(r3.exceptionEnded, [{ pr: 137, reason: 'closed' }]);
  const w4 = world(t); w4.gh.pulls = []; await w4.team.plan(); const r4 = {}; await w4.team.endExceptions(r4);
  assert.equal(r4.exceptionEnded, undefined);
  assert.ok(w4.team.exceptionFor(137));
  // not homeowner-approved: inactive
  assert.equal(world(t, { register: REG('agent-proposal') }).team.exceptionFor(137), null);
});

test('fixes: Sonnet only, never escalated; the fix limit stops the PR with one Needs you reason', async t => {
  const w = world(t);
  const vk = `137:${H(5)}`;
  w.team.s.verdicts[vk] = { verdict: 'CHANGES', reviewer: 'claude', job: 'd'.repeat(32), model: 'opus', exceptionStage: 'full', independent: true, findings: [{ kind: 'blocking', text: 'x' }], commandsRun: ['x'], at: NOW };
  const r = await w.team.tick();
  assert.deepEqual(types(r.actions), ['fix']);
  assert.equal(w.calls.created.at(-1).model, 'sonnet');
  w.team.s.exceptionFixes[137] = 2;
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
  assert.throws(bad({ prs: [{ pr: 137, expires_at: '2026-11-09T00:00:00Z' }, { pr: 137, expires_at: '2026-11-09T00:00:00Z' }] }), /review_exception/);
  assert.throws(bad({ commit_review: { model: 'opus' } }), /different models/);
  // D-027 scope is enforced, not just recorded: no other PR, and no expiry past 9 Nov 2026
  assert.throws(bad({ prs: [{ pr: 999, expires_at: '2026-11-03T00:00:00Z' }] }), /not one of the pull requests D-027 approves/);
  assert.throws(bad({ prs: [{ pr: 137, expires_at: '2026-11-09T00:00:01Z' }] }), /9 Nov 2026/);
  assert.doesNotThrow(bad({ prs: [137, 216, 217, 222, 234].map(pr => ({ pr, expires_at: '2026-11-09T00:00:00Z' })) }));
  assert.throws(bad({ extra: 1 }), /review_exception/);
});

test('a whole-PR exception PASS never merges once the exception has expired or lost approval; D-024 returns and a normal review is planned', async t => {
  for (const how of ['expired', 'unapproved']) {
    const w = world(t);
    assert.deepEqual(types((await w.team.tick()).actions), ['review:full']);
    await finish(w);   // Opus PASS of an Opus-written head, recorded under the exception
    if (how === 'expired') w.now.t = NOW + 6 * DAY; else w.team.register = REG('superseded');
    assert.equal(w.team.exceptionFor(137), null);
    const actions = (await w.team.tick()).actions;
    assert.ok(!types(actions).includes('merge'), `${how}: the exception PASS must not merge`);
    assert.equal(w.calls.merges.length, 0);
    // D-024 refuses an Opus review of the Opus-written head, so no review of it is planned either, and it is never merged
    assert.ok(!actions.some(a => a.type === 'merge'));
  }
});

test('fix rounds spent before the exception began do not stop the Sonnet fix of a listed PR', async t => {
  const w = world(t);
  w.team.s.fixAttempts['137:' + H(3)] = 2;   // two earlier rounds on an older head, before the exception route
  const vk = `137:${H(5)}`;
  w.team.s.verdicts[vk] = { verdict: 'CHANGES', reviewer: 'claude', job: 'd'.repeat(32), model: 'opus', exceptionStage: 'full', independent: true, findings: [{ kind: 'blocking', text: 'x' }], commandsRun: ['x'], at: NOW };
  assert.equal(w.team.fixCount(137), 0);
  const r = await w.team.tick();
  assert.deepEqual(types(r.actions), ['fix']);
  assert.equal(w.calls.created.at(-1).model, 'sonnet');
  assert.equal(w.team.s.exceptionFixes[137], 1);
  assert.equal(w.team.s.fixAttempts[vk], 1);
});

test('shipped team.json lists exactly the five approved PRs, all expiring 9 Nov 2026 (D-027)', () => {
  const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
  assert.deepEqual(shipped.review_exception.prs.map(e => e.pr).sort((a, b) => a - b), [137, 216, 217, 222, 234]);
  for (const e of shipped.review_exception.prs) assert.equal(Date.parse(e.expires_at), Date.parse('2026-11-09T00:00:00Z'));
});
