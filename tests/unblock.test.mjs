// Foreman unblocks itself (issue #163): fake GitHub, fake jobs, fake clock. No model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, overlapsRequired, validateTeamConfig, checksState, fixPrompt, reviewPrompt } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:00:00Z' }];
const cancelled = (conclusion = 'CANCELLED', run = 77) => [{ name: 'ci', workflowName: 'ci', status: 'COMPLETED', conclusion, startedAt: '2026-11-01T10:00:00Z', detailsUrl: `https://github.com/o/r/actions/runs/${run}/job/1` }];
const failed = [{ name: 'ci', workflowName: 'ci', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2026-11-01T10:30:00Z' }];
const config = (unblock = {}, over = {}) => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2, cancelled_wait_ms: 0, unblock: { per_pr: 6, per_day: 20, cooldown_ms: 0, ...unblock } },
  models: { agents: { claude: { fix: { model: 'sonnet' }, 'ci-fix': { model: 'sonnet' }, strong: { model: 'opus' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } }, ...over });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = (n, state = 'OPEN', body = '', labels = []) => ({ number: n, title: `Issue ${n} title here`, state, body, labels });
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n';

function world(t, { pulls = [], issues = [], cfg = config(), comments = [{ association: 'OWNER', body: '' }], now = 1_000_000 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unblock-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], labels: [], removed: [], merges: [], reruns: [], resumed: [], created: [], issues: [], alerts: [] };
  const clock = { t: now, now: () => clock.t };
  const gh = {
    pulls, issues, listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => gh.issues,
    rerunRun: async r => { calls.reruns.push(r); }, comment: async (n, body) => calls.comments.push([n, body]), addLabel: async (n, l) => calls.labels.push([n, l]),
    removeLabel: async (n, l) => calls.removed.push([n, l]), hasComment: async (n, text) => calls.comments.some(c => c[0] === n && c[1].includes(text)),
    findIssueByMarker: async m => gh.issues.find(i => i.body?.includes(m))?.number || null,
    createIssue: async (title, body) => { const number = 100 + gh.issues.length; gh.issues.push(issue(number, 'OPEN', body)); calls.issues.push([number, title, body]); return number; },
    issueComments: async () => comments, merge: async (n, head) => { calls.merges.push([n, head]); }, board: async () => {}, merged: [], listMergedPulls: async () => gh.merged
  };
  const jobs = { states: {}, seq: 0, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; },
    resume: async id => { calls.resumed.push(id); jobs.states[id] = { ...jobs.states[id], status: 'running' }; } };
  const git = { ensureWorktree: async o => o.path, worktreeFor: async () => null };
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock, alert: async text => { calls.alerts.push(text); } });
  return { dir, gh, jobs, git, team, calls, clock };
}
const noMerge = w => assert.deepEqual(w.calls.merges, [], 'no path merges without an approved verdict');

test('config: limits.unblock is validated', () => {
  assert.doesNotThrow(() => validateTeamConfig(config()));
  for (const bad of [{ per_pr: -1 }, { per_day: 1.5 }, { cooldown_ms: 'x' }, { other: 1 }]) assert.throws(() => validateTeamConfig(config(bad)), /unblock/);
  assert.throws(() => validateTeamConfig(config({}, { limits: { ...config().limits, unblock: [] } })), /unblock/);
});

test('CI: a cancelled, unsuperseded run is re-run once; a second failure starts cifix', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1), { statusCheckRollup: cancelled() })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  assert.equal(checksState(w.gh.pulls[0].statusCheckRollup), 'pending');
  let r = await w.team.tick();
  assert.deepEqual(w.calls.reruns, ['77']); assert.match(r.unblocked[0].what, /re-ran CI on PR #10/); assert.equal(r.actions.some(a => a.type === 'cifix'), false);
  await w.team.tick(); assert.deepEqual(w.calls.reruns, ['77'], 'once per head');
  w.gh.pulls[0] = { ...w.gh.pulls[0], statusCheckRollup: failed };   // the rerun fails
  r = await w.team.tick();
  assert.equal(r.actions.find(a => a.agent === 'claude')?.type, 'cifix'); assert.deepEqual(w.calls.reruns, ['77']);
  noMerge(w);
});

test('CI: a timed-out run is re-run once; timing out again counts as a failure and starts cifix', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1), { statusCheckRollup: cancelled('TIMED_OUT', 88) })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  assert.equal((await w.team.tick()).actions.some(a => a.type === 'cifix'), false);
  assert.deepEqual(w.calls.reruns, ['88']);
  w.clock.t += 120_000;   // the rerun has settled in the rollup
  w.gh.pulls[0] = { ...w.gh.pulls[0], statusCheckRollup: cancelled('TIMED_OUT', 89) };
  assert.equal((await w.team.tick()).actions.find(a => a.agent === 'claude')?.type, 'cifix');
  assert.deepEqual(w.calls.reruns, ['88']);
});

test('CI: a superseded cancelled run is green and is not re-run', async t => {
  const rollup = [...cancelled(), { name: 'ci', workflowName: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2026-11-01T10:05:00Z' }];
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1), { statusCheckRollup: rollup })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  assert.equal(checksState(rollup), 'green'); await w.team.tick(); assert.deepEqual(w.calls.reruns, []);
});

const stoppedJob = (w, id, lastEvent, over = {}) => {
  w.team.s.jobs[id] = { kind: 'implement', agent: 'claude', key: '23', issue: 23, ingested: false, at: 1 };
  w.jobs.states[id] = { id, status: 'blocked', lastEvent, updatedAt: w.clock.t - 5000, ...over };
};

test('transient stop: resumed once after the cooldown, no notice; stopping again asks the homeowner', async t => {
  const w = world(t, { issues: [issue(23), issue(5, 'CLOSED')], cfg: config({ cooldown_ms: 60_000 }) });
  stoppedJob(w, 'j1', 'crash');
  let r = await w.team.tick();
  assert.deepEqual(w.calls.resumed, [], 'still cooling down'); assert.deepEqual(w.calls.labels, []); assert.equal(w.calls.comments.length, 0, 'no notice during the cooldown');
  w.clock.t += 61_000;
  r = await w.team.tick();
  assert.deepEqual(w.calls.resumed, ['j1']); assert.match(r.unblocked[0].why, /crash/); assert.deepEqual(w.calls.labels, []);
  // it stops again: resumed only once, now the homeowner is asked as before
  w.jobs.states.j1 = { id: 'j1', status: 'blocked', lastEvent: 'crash', updatedAt: w.clock.t - 5000 };
  w.clock.t += 61_000; await w.team.tick();
  assert.deepEqual(w.calls.resumed, ['j1']); assert.deepEqual(w.calls.labels, [[23, 'needs-homeowner']]);
});

test('transient stop: a real decision (auth, closed issue) is never auto-resumed; an agent out of allowance waits', async t => {
  const w = world(t, { issues: [issue(23), issue(5, 'CLOSED')] });
  stoppedJob(w, 'j1', 'auth_error'); await w.team.tick();
  assert.deepEqual(w.calls.resumed, []); assert.deepEqual(w.calls.labels, [[23, 'needs-homeowner']]);
  const o = world(t, { issues: [issue(23), issue(5, 'CLOSED')] }); o.team.limitedOf = () => ({ out: true, reason: 'weekly' });
  stoppedJob(o, 'j2', 'crash'); await o.team.tick();
  assert.deepEqual(o.calls.resumed, []); assert.deepEqual(o.calls.labels, []);
});

const reject = (w, n, head, findings = [{ kind: 'blocking', text: 'The retry loop never stops' }]) => {
  w.gh.pulls = [pr(n, 'claude/issue-23-x', head)];
  w.team.s.verdicts[`${n}:${head}`] = { verdict: 'CHANGES', reviewer: 'codex', findings, at: w.clock.t };
};

test('fix limit: no notice while the escalation is pending; one escalated fix runs with the full review history', async t => {
  const w = world(t, { pulls: [pr(38, 'claude/issue-23-x', H(1))], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  w.team.s.verdicts[`38:${H(0)}`] = { verdict: 'CHANGES', reviewer: 'codex', findings: [{ kind: 'blocking', text: 'first head problem' }], at: 1 };
  reject(w, 38, H(1), [{ kind: 'blocking', text: 'second head problem' }, { kind: 'follow-up', text: 'rename later' }]);
  w.team.s.fixAttempts[`38:${H(0)}`] = 2;
  const r = await w.team.tick();
  assert.equal(w.calls.comments.filter(c => /fix rounds/.test(c[1])).length, 0, 'the homeowner is not asked before the escalated round');
  const spec = w.calls.created[0];
  assert.equal(spec.kind, 'fix'); assert.equal(spec.modelSource, 'configured'); assert.match(spec.prompt, /final round/); assert.match(spec.prompt, /review-history\.json/);
  const [jobId, rec] = Object.entries(w.team.s.jobs)[0];
  const history = JSON.parse(fs.readFileSync(path.join(w.team.dir, 'inbox', rec.ticket, 'review-history.json'), 'utf8'));
  assert.deepEqual(history.verdicts.map(v => v.head), [H(0), H(1)]); assert.equal(history.verdicts[0].findings[0].text, 'first head problem');
  assert.match(r.unblocked[0].what, /escalated the fix of PR #38/);
  assert.equal(w.team.s.unblock.escalated[38].head, H(1));
  // only one escalated round per PR; while it runs, still no notice
  assert.equal((await w.team.plan()).some(a => a.type === 'fix'), false); await w.team.tick(); assert.equal(w.calls.created.length, 1);
  assert.equal(w.calls.comments.filter(c => /fix rounds/.test(c[1])).length, 0);
  // the escalated round is rejected: now it becomes a Inbox item, once
  w.jobs.states[jobId] = { id: jobId, status: 'completed' };
  reject(w, 38, H(2));
  await w.team.tick(); await w.team.tick();
  assert.equal(w.calls.created.length, 1, 'no second escalation');
  assert.equal(w.calls.comments.filter(c => /fix rounds/.test(c[1])).length, 1); assert.deepEqual(w.calls.labels.filter(l => l[0] === 38), [[38, 'needs-homeowner']]);
  // the notice and the AI-channel alert give the same choices as the card, with no paid option
  const noticeText = w.calls.comments.find(c => /fix rounds/.test(c[1]))[1];
  for (const text of [noticeText, w.calls.alerts.find(x => /fix rounds/.test(x))]) { assert.match(text, /wait for another agent to be able to review/); assert.match(text, /split the PR into smaller pieces/); assert.match(text, /fix it by hand/); assert.doesNotMatch(text, /pay|credit|paid|stronger model/i); }
  noMerge(w);
});

test('fix limit: red CI escalates once too', async t => {
  const w = world(t, { pulls: [pr(38, 'claude/issue-23-x', H(1), { statusCheckRollup: failed })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  w.team.s.fixAttempts[`38:${H(0)}`] = 2;
  await w.team.tick();
  assert.equal(w.calls.created[0].kind, 'cifix'); assert.equal(w.calls.created[0].modelSource, 'configured'); assert.match(w.calls.created[0].prompt, /review-history\.json/);
  assert.equal((await w.team.plan()).some(a => a.type === 'cifix'), false);
});

async function escalatedWorld(t, { body = 'Do the thing.\n- The dispatcher must never merge without approval.', comments } = {}) {
  const w = world(t, { pulls: [pr(38, 'claude/issue-23-x', H(1))], issues: [issue(23, 'OPEN', body), issue(5, 'CLOSED')], ...(comments ? { comments } : {}) });
  reject(w, 38, H(1), [{ kind: 'blocking', text: 'Add a retry limit to the poller' }, { kind: 'blocking', text: 'The dispatcher must never merge without approval' }, { kind: 'follow-up', text: 'Rename the helper for clarity please' }, { kind: 'follow-up', text: 'Log the poller interval at debug level' }]);
  w.team.s.fixAttempts[`38:${H(0)}`] = 2;
  await w.team.tick();
  const [jobId, rec] = Object.entries(w.team.s.jobs)[0];
  const write = split => { fs.writeFileSync(path.join(w.team.dir, 'inbox', rec.ticket, 'split.json'), JSON.stringify({ split })); };
  const finish = async () => { w.jobs.states[jobId] = { id: jobId, status: 'completed' }; return w.team.tick(); };
  return { w, jobId, rec, write, finish };
}

test('split: out-of-scope findings become one queued follow-up issue; homeowner-required items are never split', async t => {
  const { w, write, finish } = await escalatedWorld(t);
  write([{ finding: 'Rename the helper for clarity please', reason: 'cosmetic, not in the acceptance list' }, { finding: 'The dispatcher must never merge without approval', reason: 'try to split a required item' }, { finding: 'invented finding', reason: 'not from a review' }]);
  const r = await finish();
  assert.equal(w.calls.issues.length, 1); const [num, , body] = w.calls.issues[0];
  assert.match(body, /Rename the helper/); assert.doesNotMatch(body, /never merge without approval/); assert.doesNotMatch(body, /invented/);
  assert.deepEqual(w.team.s.unblock.queued.claude, [num]); assert.deepEqual(w.team.issuesOf('claude').slice(-1), [num]);
  assert.match(w.calls.comments.map(c => c[1]).join('\n'), /2 proposed split\(s\) refused/);
  // the queued issue is implementable at the end of the list, and the re-review is told it is out of scope
  assert.ok(!w.calls.created.some(c => c.kind === 'implement' && c.issue === num), 'the follow-up waits while PR #38 is open (issue #212)');
  const inbox = path.join(w.dir, 'i'); fs.mkdirSync(inbox);
  assert.match(reviewPrompt({ pr: 38, head: H(3), branch: 'b', repository: 'o/r', inbox, splitOut: [num] }), new RegExp(`#${num}.*original issue`));
  assert.equal(w.team.splitOut(38, inbox)[0], num);
  assert.ok(w.team.s.unblock.log.some(u => /split 1 finding/.test(u.what)));
  noMerge(w);
});

test('split: a homeowner comment protects its text; unreadable comments split nothing', async t => {
  const a = await escalatedWorld(t, { comments: [{ association: 'OWNER', body: 'Please also rename the helper for clarity before release.' }, { association: 'NONE', body: 'unrelated' }] });
  a.write([{ finding: 'Rename the helper for clarity please', reason: 'cosmetic' }, { finding: 'Log the poller interval at debug level', reason: 'extra' }]);
  await a.finish();
  assert.equal(a.w.calls.issues.length, 1); assert.doesNotMatch(a.w.calls.issues[0][2], /Rename the helper/); assert.match(a.w.calls.issues[0][2], /poller interval/);
  const b = await escalatedWorld(t); b.w.gh.issueComments = async () => { throw new Error('gh down'); };
  b.write([{ finding: 'Rename the helper for clarity please', reason: 'cosmetic' }]); await b.finish();
  assert.equal(b.w.calls.issues.length, 0); assert.deepEqual(b.w.team.s.unblock.queued, {});
  assert.equal(overlapsRequired('retry limit on poller loop', 'a retry limit on poller loop here'), true);
  assert.equal(overlapsRequired('something totally different happens here today', 'the issue says other words entirely'), false);
});

test('transient stop: usage_limit and retry_exhausted (D-019 bounds) are never auto-resumed with reset attempts', async t => {
  for (const ev of ['usage_limit', 'retry_exhausted']) {
    const w = world(t, { issues: [issue(23), issue(5, 'CLOSED')] });
    stoppedJob(w, 'j1', ev); w.clock.t += 10_000_000; await w.team.tick();
    assert.deepEqual(w.calls.resumed, [], ev); assert.deepEqual(w.calls.labels, [[23, 'needs-homeowner']], ev);
  }
});

test('split: an issue missing from the issue list is unreadable, so nothing is split', async t => {
  const { w, write, finish } = await escalatedWorld(t);
  w.gh.issues = w.gh.issues.filter(i => i.number !== 23);
  write([{ finding: 'The dispatcher must never merge without approval', reason: 'try to split a required item' }]);
  await finish();
  assert.equal(w.calls.issues.length, 0); assert.deepEqual(w.team.s.unblock.queued, {});
});

test('split: an issue missing from the capped list is fetched directly, and a valid split goes ahead', async t => {
  const { w, write, finish } = await escalatedWorld(t);
  const own = w.gh.issues.find(i => i.number === 23);
  w.gh.issues = w.gh.issues.filter(i => i.number !== 23);
  w.gh.getIssue = async n => (n === 23 ? own : null);
  write([{ finding: 'Log the poller interval at debug level', reason: 'extra' }]);
  await finish();
  assert.equal(w.calls.issues.length, 1);
  // a direct lookup that returns the wrong issue stays unreadable
  const b = await escalatedWorld(t);
  b.w.gh.issues = b.w.gh.issues.filter(i => i.number !== 23); b.w.gh.getIssue = async () => issue(999);
  b.write([{ finding: 'Log the poller interval at debug level', reason: 'extra' }]); await b.finish();
  assert.equal(b.w.calls.issues.length, 0);
});

test('labels: a Foreman-added needs-homeowner label is removed when its cause clears, and the removal is recorded', async t => {
  // job cause
  const w = world(t, { issues: [issue(23), issue(5, 'CLOSED')], cfg: config({ cooldown_ms: 86_400_000 }) });
  stoppedJob(w, 'j1', 'auth_error'); await w.team.tick();
  assert.deepEqual(w.calls.labels, [[23, 'needs-homeowner']]);
  await w.team.tick(); assert.deepEqual(w.calls.removed, [], 'still blocked: label stays');
  w.jobs.states.j1 = { id: 'j1', status: 'running' };   // the homeowner resumed it
  const r = await w.team.tick();
  assert.deepEqual(w.calls.removed, [[23, 'needs-homeowner']]); assert.match(r.unblocked.at(-1).what, /removed needs-homeowner from #23/); assert.match(r.unblocked.at(-1).why, /resumed or completed/);
  await w.team.tick(); assert.equal(w.calls.removed.length, 1, 'removed once');
  // fix-limit cause: a new, no longer rejected head clears it; the same head does not
  const f = world(t, { pulls: [pr(38, 'claude/issue-23-x', H(1))], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  reject(f, 38, H(1)); f.team.s.fixAttempts[`38:${H(0)}`] = 2; f.team.s.unblock.escalated[38] = { head: H(1) };
  await f.team.tick(); assert.deepEqual(f.calls.labels, [[38, 'needs-homeowner']]); await f.team.tick(); assert.deepEqual(f.calls.removed, []);
  f.gh.pulls = [pr(38, 'claude/issue-23-x', H(2))]; await f.team.tick();
  assert.deepEqual(f.calls.removed, [], 'a new head that is not yet reviewed does not clear the fix limit');
  f.team.s.verdicts[`38:${H(2)}`] = { verdict: 'PASS', reviewer: 'codex', job: 'x', findings: [], at: 1 }; await f.team.tick();
  assert.deepEqual(f.calls.removed, [[38, 'needs-homeowner']]);
  // a label Foreman did not add (the homeowner's own, or a lost-commits notice) is never touched
  const h = world(t, { pulls: [pr(9, 'claude/issue-23-x', H(3))], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED', '', ['needs-homeowner'])] });
  await h.team.tick(); assert.deepEqual(h.calls.removed, []);
});

test('labels: the cancelled-CI notice clears when the check turns green; another cause keeps the label', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1), { statusCheckRollup: cancelled() })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  await w.team.tick();                       // rerun
  w.clock.t += 1; await w.team.tick();       // still cancelled after the rerun: notice
  assert.deepEqual(w.calls.labels, [[10, 'needs-homeowner']]);
  w.team.s.unblock.flags[10]['fixlimit'] = { key: 'fixlimit', kind: 'fixlimit', head: H(1), tk: 'pull' };   // a second, still-open cause
  w.gh.pulls[0] = { ...w.gh.pulls[0], statusCheckRollup: green };
  reject(w, 10, H(1)); w.gh.pulls[0] = { ...w.gh.pulls[0], statusCheckRollup: green };
  await w.team.tick(); assert.deepEqual(w.calls.removed, [], 'the fix-limit cause still holds the label');
  w.team.s.verdicts[`10:${H(2)}`] = { verdict: 'PASS', reviewer: 'codex', job: 'x', findings: [], at: 1 };
  w.gh.pulls = [pr(10, 'claude/issue-23-x', H(2))]; await w.team.tick();
  assert.deepEqual(w.calls.removed, [[10, 'needs-homeowner']]);
});

test('budget: the per-PR limit stops automation and raises exactly one Inbox item that names it', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1), { statusCheckRollup: cancelled() })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')], cfg: config({ per_pr: 1 }) });
  w.team.s.unblock.pr[10] = 1;   // the one allowed unblock for this PR is already spent
  for (let i = 0; i < 3; i++) await w.team.tick();
  assert.deepEqual(w.calls.reruns, []);
  const items = w.calls.comments.filter(c => /Foreman stopped unblocking/.test(c[1]));
  assert.equal(items.length, 1); assert.match(items[0][1], /per-PR limit of 1/); assert.match(items[0][1], /limits\.unblock\.per_pr/);
  assert.deepEqual(w.calls.labels, [[10, 'needs-homeowner']]); assert.equal(w.calls.alerts.length, 1);
  // not an escalation either
  const e = world(t, { pulls: [pr(38, 'claude/issue-23-x', H(1))], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')], cfg: config({ per_pr: 1 }) });
  reject(e, 38, H(1)); e.team.s.fixAttempts[`38:${H(0)}`] = 2; e.team.s.unblock.pr[38] = 1;
  await e.team.tick(); assert.equal(e.calls.created.length, 0); assert.equal(e.calls.comments.filter(c => /fix rounds/.test(c[1])).length, 1, 'the fix-limit notice follows at once');
  // a stopped job is not held for a resume that cannot happen
  const j = world(t, { issues: [issue(23), issue(5, 'CLOSED')], cfg: config({ per_pr: 0 }) });
  stoppedJob(j, 'j1', 'crash'); await j.team.tick(); assert.deepEqual(j.calls.resumed, []); assert.ok(j.calls.labels.some(l => l[0] === 23));
});

test('budget: the per-day limit is shared across PRs, raises one item per day, and resets the next day', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1), { statusCheckRollup: cancelled() }), pr(11, 'codex/issue-2-x', H(2), { statusCheckRollup: cancelled('CANCELLED', 78) })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED'), issue(2, 'CLOSED'), issue(3, 'CLOSED')], cfg: config({ per_day: 1 }) });
  for (let i = 0; i < 3; i++) await w.team.tick();
  assert.equal(w.calls.reruns.length, 1);
  assert.equal(w.calls.comments.filter(c => /Foreman stopped unblocking/.test(c[1])).length, 1); assert.match(w.calls.comments.find(c => /Foreman stopped unblocking/.test(c[1]))[1], /per-day limit of 1/);
  w.clock.t += 86_400_000; await w.team.tick();
  assert.equal(w.calls.reruns.length, 2, 'a new day has room again');
  noMerge(w);
});

test('visibility: every automatic unblock is an Activity entry and a report event', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1), { statusCheckRollup: cancelled() })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  const r = await w.team.tick();
  assert.equal(r.unblocked.length, 1); const e = w.team.s.unblock.log[0];
  assert.deepEqual(Object.keys(e).sort(), ['at', 'result', 'target', 'tk', 'what', 'why']);
  const view = await buildView({ config: config(), root: w.dir, jobs: [], events: [], state: w.team.s, cache: { pulls: [], issues: [] }, snapshots: [], now: w.clock.t + 1000, register: REGISTER });
  const row = view.activity.find(a => /Foreman unblocked/.test(a.text));
  assert.match(row.text, /^Foreman unblocked: re-ran CI on PR #10, check\(s\) ci were cancelled.*, rerun requested/); assert.match(row.link.url, /pull\/10$/);
});

test('never automated: no unblock path merges, and a PASS on another head does not merge a rerun PR', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1), { statusCheckRollup: cancelled() })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  w.team.s.verdicts[`10:${H(9)}`] = { verdict: 'PASS', reviewer: 'codex', job: 'x', findings: [], at: 1 };
  for (let i = 0; i < 3; i++) await w.team.tick();
  noMerge(w);
  w.gh.pulls[0] = { ...w.gh.pulls[0], statusCheckRollup: green };
  await w.team.tick(); noMerge(w);   // green but no PASS on this exact head
});

test('prompts: the escalated note is only in the escalated fix prompt', () => {
  assert.doesNotMatch(fixPrompt({ pr: 1, head: H(1), branch: 'b' }), /escalated/);
  assert.match(fixPrompt({ pr: 1, head: H(1), branch: 'b', escalatedInbox: '/i/x' }), /Never propose a blocking finding or anything that comes from the issue body/);
});

// ---- review of head f165548 (issue #163): regressions for the blocking findings
test('transient stop: a job already reported to the homeowner, a closed PR, a moved head or a closed issue is never auto-resumed', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1)), pr(11, 'claude/issue-23-y', H(2))], issues: [issue(23), issue(5, 'CLOSED'), issue(6, 'CLOSED')] });
  const stop = (id, rec, over = {}) => { w.team.s.jobs[id] = { agent: 'claude', ingested: true, at: 1, ...rec }; w.jobs.states[id] = { id, status: 'failed', lastEvent: 'crash', updatedAt: w.clock.t - 5000, ...over }; };
  stop('notified', { kind: 'implement', key: '23', issue: 23 }); w.team.s.notified['notified:blocked'] = 1;   // reported before the feature ran
  stop('merged', { kind: 'fix', key: `9:${H(3)}`, pr: 9, head: H(3), branch: 'claude/issue-23-z' });             // PR no longer open
  stop('moved', { kind: 'fix', key: `10:${H(4)}`, pr: 10, head: H(4), branch: 'claude/issue-23-x' });            // head moved since
  stop('closed', { kind: 'implement', key: '6', issue: 6 });                                                        // issue closed
  stop('live', { kind: 'fix', key: `11:${H(2)}`, pr: 11, head: H(2), branch: 'claude/issue-23-y' });             // still current
  w.clock.t += 10_000_000;
  for (let i = 0; i < 2; i++) await w.team.tick();
  assert.deepEqual(w.calls.resumed, ['live']);
  assert.deepEqual(Object.keys(w.team.s.unblock.noResume).sort(), ['closed', 'merged', 'moved', 'notified']);
  assert.match(w.team.s.unblock.noResume.notified.why, /already reported/);
  // the stale ones are handled as before: one Inbox notice each, nothing relaunched
  assert.ok(w.calls.comments.some(c => c[0] === 9 && /Needs the homeowner/.test(c[1])));
  assert.ok(w.calls.comments.some(c => c[0] === 10 && /Needs the homeowner/.test(c[1])));
  noMerge(w);
});

test('split: a blocking finding is never split automatically, even when it paraphrases the acceptance criteria', async t => {
  const { w, write, finish } = await escalatedWorld(t, { body: 'The budget limit stops automation and raises exactly one item.' });
  w.team.s.verdicts[`38:${H(0)}`] = { verdict: 'CHANGES', reviewer: 'codex', findings: [{ kind: 'blocking', text: 'When per_day is exhausted Foreman keeps going and never tells anybody about it' }], at: 0 };
  assert.equal(overlapsRequired('When per_day is exhausted Foreman keeps going and never tells anybody about it', 'The budget limit stops automation and raises exactly one item.'), false, 'the paraphrase passes the text check');
  write([{ finding: 'When per_day is exhausted Foreman keeps going and never tells anybody about it', reason: 'out of scope' }, { finding: 'Add a retry limit to the poller', reason: 'extra' }]);
  await finish();
  assert.equal(w.calls.issues.length, 0); assert.deepEqual(w.team.s.unblock.queued, {});
  assert.match(w.calls.comments.map(c => c[1]).join('\n'), /2 proposed split\(s\) refused: it is a blocking finding/);
  // a finding first reported as a follow-up and later as blocking counts as blocking
  const b = await escalatedWorld(t);
  b.w.team.s.verdicts[`38:${H(0)}`] = { verdict: 'CHANGES', reviewer: 'codex', findings: [{ kind: 'blocking', text: 'Rename the helper for clarity please' }], at: 0 };
  b.write([{ finding: 'Rename the helper for clarity please', reason: 'cosmetic' }]); await b.finish();
  assert.equal(b.w.calls.issues.length, 0);
});

test('labels: the fix-limit flag clears only after a PASS on the new head, and a later rejection raises Inbox again', async t => {
  const f = world(t, { pulls: [pr(38, 'claude/issue-23-x', H(1))], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  reject(f, 38, H(1)); f.team.s.fixAttempts[`38:${H(0)}`] = 2; f.team.s.unblock.escalated[38] = { head: H(1) };
  await f.team.tick(); assert.deepEqual(f.calls.labels, [[38, 'needs-homeowner']]);
  f.gh.pulls = [pr(38, 'claude/issue-23-x', H(2), { statusCheckRollup: [{ name: 'ci', status: 'IN_PROGRESS' }] })];   // pushed, CI pending, no review
  await f.team.tick(); assert.deepEqual(f.calls.removed, [], 'an unreviewed head with pending CI keeps the label');
  reject(f, 38, H(2)); await f.team.tick(); await f.team.tick();
  assert.deepEqual(f.calls.removed, [], 'rejected again: the label stays');
  // a head that passes clears it and re-arms the notice; a later rejection on another head is raised again
  f.gh.pulls = [pr(38, 'claude/issue-23-x', H(3))]; f.team.s.verdicts[`38:${H(3)}`] = { verdict: 'PASS', reviewer: 'codex', job: 'x', findings: [], at: 2 };
  f.team.plan = async () => [];   // keep the PASS from merging in this fixture
  await f.team.tick(); assert.deepEqual(f.calls.removed, [[38, 'needs-homeowner']]);
  reject(f, 38, H(4)); await f.team.tick();
  assert.equal(f.calls.labels.filter(l => l[0] === 38).length, 2, 'the new rejection is labelled again');
  assert.equal(f.calls.comments.filter(c => /fix rounds/.test(c[1])).length, 1, 'the notice marker is per PR, so the comment is not duplicated');
});

test('self-check (issue #752): a removed label at a still-rejected head is neither re-flagged nor re-noticed by runSelfCheck then notifyFixLimit', async t => {
  const f = world(t, { pulls: [pr(38, 'claude/issue-23-x', H(1))], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  reject(f, 38, H(1)); f.team.s.fixAttempts[`38:${H(0)}`] = 2; f.team.s.unblock.escalated[38] = { head: H(1) };
  await f.team.tick(); assert.deepEqual(f.calls.labels, [[38, 'needs-homeowner']]);
  const notices = () => f.calls.comments.filter(c => /fix rounds/.test(c[1])).length;
  assert.equal(notices(), 1);
  // The homeowner removes the label; the record is old enough for the self-check to consider it. The head is still rejected.
  for (const c of Object.values(f.team.s.unblock.flags[38])) c.at = 0;
  f.gh.pulls = [{ ...f.gh.pulls[0], labels: [] }];
  f.team.view = { prs: f.gh.pulls, issues: f.gh.issues };
  const report = {}; await f.team.runSelfCheck(report); await f.team.notifyFixLimit(report);
  assert.equal(report.selfChecked, undefined, 'the fix-limit record is not dropped');
  assert.ok(f.team.s.unblock.flags[38], 'the record stays');
  assert.ok(f.team.s.notified['fixlimit:38'] && f.team.s.notified['fixlimit-alert:38'], 'the notice markers stay');
  assert.equal(f.calls.labels.length, 1, 'not flagged again'); assert.equal(notices(), 1, 'not noticed again');
});

test('self-check (issue #844): a full second tick after the label is removed neither re-flags nor re-notices, with the view filled by plan()', async t => {
  const f = world(t, { pulls: [pr(38, 'claude/issue-23-x', H(1))], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')] });
  reject(f, 38, H(1)); f.team.s.fixAttempts[`38:${H(0)}`] = 2; f.team.s.unblock.escalated[38] = { head: H(1) };
  await f.team.tick(); assert.deepEqual(f.calls.labels, [[38, 'needs-homeowner']]);
  const notices = () => f.calls.comments.filter(c => /fix rounds/.test(c[1])).length;
  assert.equal(notices(), 1);
  for (const c of Object.values(f.team.s.unblock.flags[38])) c.at = 0;
  f.gh.pulls = [{ ...f.gh.pulls[0], labels: [] }];
  f.team.view = undefined;   // not set by hand: the second tick's plan() must fill it
  await f.team.tick();
  assert.ok(f.team.s.unblock.flags[38], 'the record stays after the full tick');
  assert.equal(f.calls.labels.length, 1, 'not flagged again'); assert.equal(notices(), 1, 'not noticed again');
});

test('budget: a spent budget at the fix limit raises the limit item, and the fix-limit notice says no escalated round ran', async t => {
  const e = world(t, { pulls: [pr(38, 'claude/issue-23-x', H(1))], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')], cfg: config({ per_pr: 0 }) });
  reject(e, 38, H(1)); e.team.s.fixAttempts[`38:${H(0)}`] = 2;
  await e.team.tick(); await e.team.tick();
  assert.equal(e.calls.created.length, 0); assert.deepEqual(e.team.s.unblock.escalated, {});
  const items = e.calls.comments.filter(c => /Foreman stopped unblocking/.test(c[1]));
  assert.equal(items.length, 1); assert.match(items[0][1], /per-PR limit of 0/);
  const notice = e.calls.comments.filter(c => /fix rounds/.test(c[1]));
  assert.equal(notice.length, 1); assert.match(notice[0][1], /no final round ran: Foreman reached the per-PR limit of 0/); assert.doesNotMatch(notice[0][1], /including one escalated round/);
  // the resume path raises the limit item too
  const j = world(t, { issues: [issue(23), issue(5, 'CLOSED')], cfg: config({ per_pr: 0 }) });
  stoppedJob(j, 'j1', 'crash'); await j.team.tick(); await j.team.tick();
  assert.deepEqual(j.calls.resumed, []);
  assert.equal(j.calls.comments.filter(c => c[0] === 23 && /Foreman stopped unblocking/.test(c[1])).length, 1);
  assert.equal(j.calls.comments.filter(c => c[0] === 23 && /Needs the homeowner.\*\* Supervised/.test(c[1])).length, 1);
});

// ---- issue #188 review follow-ups
test('limit cause: a per-day limit label is removed after the day rolls over; a per-PR limit label stays', async t => {
  const w = world(t, { pulls: [pr(11, 'claude/issue-23-x', H(1))], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')], now: Date.UTC(2026, 10, 1, 12) });
  const day = w.team.dayKey();
  w.team.s.unblock.flags[11] = { [`limit:day:${day}`]: { key: `limit:day:${day}`, kind: 'limit', tk: 'pull', at: 1 } };
  w.team.s.unblock.flags[12] = { 'limit:pr:12': { key: 'limit:pr:12', kind: 'limit', tk: 'pull', at: 1 } };
  await w.team.tick(); assert.deepEqual(w.calls.removed, [], 'same day: still held');
  w.clock.t += 86400000; await w.team.tick();
  assert.deepEqual(w.calls.removed, [[11, 'needs-homeowner']]); assert.equal(w.team.s.unblock.flags[11], undefined);
  assert.ok(w.team.s.unblock.flags[12], 'a per-PR limit does not reset by itself');
});

test('label removal is not budgeted: a spent per-PR budget still removes a stale label', async t => {
  const w = world(t, { pulls: [pr(38, 'claude/issue-23-x', H(2))], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')], cfg: config({ per_pr: 1 }) });
  w.team.s.unblock.pr[38] = 1;
  w.team.s.unblock.flags[38] = { 'job:x': { key: 'job:x', kind: 'job', job: 'x', tk: 'pull', at: 1 } };
  w.jobs.states.x = { id: 'x', status: 'completed' };
  await w.team.tick();
  assert.deepEqual(w.calls.removed, [[38, 'needs-homeowner']]); assert.equal(w.team.s.unblock.pr[38], 1, 'no budget spent');
  assert.deepEqual(w.team.s.unblock.limit, {}, 'no limit item raised');
});

test('budget spent: a timed-out check becomes red (cifix) after the wait instead of pending for good', async t => {
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1), { statusCheckRollup: cancelled('TIMED_OUT', 88) })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')], cfg: config({ per_pr: 0 }) });
  await w.team.tick(); w.clock.t += 3600000; const r = await w.team.tick();
  assert.deepEqual(w.calls.reruns, []);
  assert.equal(w.team.ciState(w.gh.pulls[0]), 'red'); assert.equal(r.actions.find(a => a.agent === 'claude')?.type, 'cifix');
});

test('split: the agent-written reason is not copied into the new issue body', async t => {
  const src = fs.readFileSync(new URL('../supervisor/team.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /why split: \$\{x\.reason\}/);
});

test('budget spent: a timeout beside a cancelled sibling becomes red (cifix) without a false rerun notice', async t => {
  const roll = [...cancelled('TIMED_OUT', 88), { name: 'lint', workflowName: 'lint', status: 'COMPLETED', conclusion: 'CANCELLED', startedAt: '2026-11-01T10:00:00Z', detailsUrl: 'https://github.com/o/r/actions/runs/89/job/1' }];
  const w = world(t, { pulls: [pr(10, 'claude/issue-23-x', H(1), { statusCheckRollup: roll })], issues: [issue(23, 'CLOSED'), issue(5, 'CLOSED')], cfg: config({ per_pr: 0 }) });
  await w.team.tick(); w.clock.t += 3600000; const seen = []; for (let i = 0; i < 2; i++) seen.push(...(await w.team.tick()).actions); w.clock.t += 3600000; seen.push(...(await w.team.tick()).actions);
  assert.deepEqual(w.calls.reruns, []);
  assert.equal(w.team.ciState(w.gh.pulls[0]), 'red'); assert.equal(seen.find(a => a.agent === 'claude')?.type, 'cifix');
  assert.equal(w.team.s.cancelWatch[`10:${H(1)}`].rerunAt, undefined, 'no rerun was made');
  assert.equal(w.team.s.cancelWatch[`10:${H(1)}`].noticed, undefined, 'no "rerun once" notice');
});
