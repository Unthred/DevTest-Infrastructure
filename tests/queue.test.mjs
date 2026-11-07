// Issue #863: one queue of every open issue and pull request in the planner's own order, with reasons, waits and estimated starts;
// the strip at the top of the Overview; the homeowner-first ordering rule; the waiting-for-you pile. Real planner code, no stubs of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView, cacheBackedTeam } from '../supervisor/dashboard.mjs';
import { agentGenerated } from '../supervisor/team.mjs';
import { compactIssues } from '../supervisor/dashdata.mjs';
import { renderRoute, matchRoute } from '../supervisor/dashrender.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';

const NOW = Date.parse('2026-11-07T10:00:00Z'), MIN = 60000;
const H = n => String(n).repeat(40).slice(0, 40);
const config = (extra = {}) => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 3, max_review_attempts: 2, max_fix_attempts: 2, ...extra },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } });
const issue = (number, title, extra = {}) => ({ number, title, state: 'OPEN', labels: [], prerequisites: [], pullPrerequisites: [], body: '', ...extra });
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-')); fs.chmodSync(d, 0o700); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const done = (id, kind, mins, i) => ({ id: String(id).repeat(32).slice(0, 32), provider: 'claude', kind, issue: 100 + i, status: 'completed', createdAt: NOW - (i + 2) * 3600000, updatedAt: NOW - (i + 2) * 3600000 + mins * MIN });
const history = (kind, mins, n = 6) => Array.from({ length: n }, (_, i) => done(`${kind[0]}${i}`.replace(/[^a-f0-9]/g, 'a') + i, kind, mins, i));
async function view(t, { issues, pulls = [], jobs = [], cfg = config(), state = {} }) {
  const cache = { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls, issues, probes: {}, fetchedAt: NOW - 60000 };
  return buildView({ config: cfg, root: tmp(t), jobs, events: [], state, cache, snapshots: [], now: NOW });
}
const byNumber = (v, n, kind = 'issue') => v.queue.items.find(i => i.number === n && i.kind === kind);

test('homeowner issues go ahead of agent-generated follow-ups, with the reason, without editing agents.<name>.issues', async t => {
  const v = await view(t, { issues: [
    issue(5, 'Review follow-ups for PR #3 at abc1234', { body: '<!-- devtest-review-followup v1 job=x pr=3 head=y -->' }),
    issue(9, 'Add the thing the homeowner asked for'), issue(7, 'Review follow-ups for PR #4 at def5678') ] });
  const order = v.queue.items.filter(i => i.type === 'implement').map(i => i.number);
  assert.deepEqual(order, [9, 5, 7], 'homeowner first; the two follow-ups after, lowest number first');
  assert.match(byNumber(v, 9).reason, /raised by the homeowner/);
  assert.match(byNumber(v, 5).reason, /agent-generated follow-up/);
  assert.equal(v.plan[0].issue, 9, 'the planner itself takes the homeowner issue first');
});

test('agentGenerated: marker, title, compacted flag; a homeowner issue is not one', () => {
  assert.equal(agentGenerated({ title: 'x', body: '<!-- devtest-postmerge v1 job=a -->' }), true);
  assert.equal(agentGenerated({ title: 'Review follow-ups for PR #12' }), true);
  assert.equal(agentGenerated({ title: 'x', followUp: true }), true);
  assert.equal(agentGenerated({ title: 'Please review follow-ups for the homeowner', body: 'about PR #1' }), false);
  assert.equal(agentGenerated(null), false);
  const [c] = compactIssues([{ number: 1, title: 'Review follow-ups for PR #2', state: 'OPEN', labels: [], body: '' }]);
  assert.equal(c.followUp, true);
});

test('the queue order is the planner\'s own: the items that fit a slot now are exactly view.plan, in its order', async t => {
  const v = await view(t, { cfg: config({ roles: { implementer: 1, reviewer: 1 } }), issues: [issue(1, 'one'), issue(2, 'two'), issue(3, 'three')] });
  const starts = v.queue.items.filter(i => i.startsNow && i.type !== 'merge');
  assert.deepEqual(starts.map(i => `${i.agent}:${i.type}:${i.number}`).sort(), v.plan.filter(a => a.type !== 'merge').map(a => `${a.agent}:${a.type}:${a.issue ?? a.pr}`).sort());
  const planned = v.queue.items.filter(i => i.type === 'implement' && i.order !== undefined).map(i => i.number);
  assert.deepEqual(planned, [1, 2, 3], 'every ready issue is queued, in candidate order');
  assert.equal(starts.length, 1, 'one implementer slot: one starts now');
  const second = byNumber(v, 2);
  assert.equal(second.state, 'waiting');
  assert.equal(second.waitsOn.kind, 'slot');
  assert.match(second.waitsOn.text, /implementer slot/);
  // plan() without the queue option is unchanged
  assert.ok(v.plan.every(a => a.fits === undefined));
});

test('estimated start: slots and the median duration of the job type; no estimate without enough history; labelled as an estimate', async t => {
  const jobs = history('implement', 30);
  const v = await view(t, { jobs, issues: [issue(1, 'one'), issue(2, 'two'), issue(3, 'three')] });
  const [a, b, c] = [1, 2, 3].map(n => byNumber(v, n));
  assert.ok(a.estStart >= NOW, 'first starts at the next tick or now');
  assert.equal(b.estStart - a.estStart, 30 * MIN, 'the second starts a median implement job (30 min) after the first');
  assert.equal(c.estStart - b.estStart, 30 * MIN);
  assert.equal(a.estimate, true);
  assert.match(b.estimateBasis, /median 30 min of 6 recent implement jobs/);
  const none = await view(t, { jobs: history('implement', 30, 2), issues: [issue(1, 'one'), issue(2, 'two')] });
  assert.ok(Number.isFinite(byNumber(none, 1).estStart), 'the first starts now whatever the history');
  assert.equal(byNumber(none, 2).estStart, null, 'behind a job of unknown length: no estimate, nothing guessed');
  assert.match(byNumber(none, 2).estimateBasis, /no estimate yet/);
});

test('a running job holds its slot for the rest of its typical duration', async t => {
  const running = { id: 'f'.repeat(32), provider: 'claude', kind: 'implement', issue: 1, status: 'running', createdAt: NOW - 10 * MIN, updatedAt: NOW - MIN };
  const v = await view(t, { jobs: [running, ...history('implement', 30)], issues: [issue(1, 'one'), issue(2, 'two')], state: { jobs: { [running.id]: { kind: 'implement', issue: 1, key: '1', agent: 'claude' } } } });
  const run = byNumber(v, 1);
  assert.equal(run.state, 'running');
  assert.equal(run.estEnd, NOW + 20 * MIN, 'started 10 minutes ago, median 30');
  const next = byNumber(v, 2);
  assert.equal(next.estStart, NOW + 20 * MIN, 'starts when the running job is expected to finish');
});

test('needs-homeowner issues wait for you: not in the flow, in the waiting-for-you pile with the action', async t => {
  const v = await view(t, { issues: [issue(1, 'ready'), issue(2, 'needs a decision', { labels: ['needs-homeowner'] })] });
  const w = byNumber(v, 2);
  assert.equal(w.needsMe, true);
  assert.equal(w.state, 'needs-you');
  assert.equal(w.waitsOn.kind, 'homeowner');
  assert.match(w.waitsOn.action, /needs-homeowner label/);
  assert.equal(w.estStart, null);
  const lane = v.queue.lanes.find(l => l.role === 'implementer');
  assert.deepEqual(lane.waitingForYou.map(i => i.number), [2]);
  assert.ok(!lane.next.some(i => i.number === 2), 'not shown as if it will run');
  assert.deepEqual(lane.next.map(i => i.number), [1]);
  const html = renderRoute(v, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  assert.match(html, /Waiting for you \(1\)/);
});

test('blocked by a prerequisite, a file overlap and the open-PR cap say what they wait on, naming the other item', async t => {
  const v = await view(t, { issues: [issue(1, 'first, edits supervisor/team.mjs'), issue(2, 'second, also edits supervisor/team.mjs'), issue(3, 'third', { prerequisites: [4] }), issue(4, 'fourth, edits docs/x.md')] });
  const overlap = byNumber(v, 2);
  assert.equal(overlap.waitsOn.kind, 'overlap');
  assert.match(overlap.waitsOn.text, /supervisor\/team\.mjs/);
  assert.match(overlap.waitsOn.text, /#1/);
  const blocked = byNumber(v, 3);
  assert.equal(blocked.waitsOn.kind, 'prerequisite');
  assert.match(blocked.waitsOn.text, /#4/);
  const pulls = [1, 2].map(n => ({ number: n, title: `pr ${n}`, headRefName: `claude/issue-${n}-x`, headRefOid: H(n), baseRefName: 'main', isDraft: true, mergeable: 'MERGEABLE', statusCheckRollup: [] }));
  const capped = await view(t, { cfg: config({ max_open_prs: 2 }), pulls, issues: [issue(1, 'a'), issue(2, 'b'), issue(8, 'waits for the cap')] });
  const c = byNumber(capped, 8);
  assert.equal(c.waitsOn.kind, 'cap');
  assert.match(c.waitsOn.text, /cap 2/);
  assert.match(c.waitsOn.action, /Merge or close/);
});

test('without a breaker halt no item waits on the breaker', async t => {
  const v = await view(t, { issues: [issue(1, 'one')] });
  assert.equal(byNumber(v, 1).waitsOn, null, 'no halt: no breaker wait');
});

test('pull requests: a ready review is queued with the review order as the reason; CI-pending and draft PRs wait', async t => {
  const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'ci' }];
  const pr = (n, extra = {}) => ({ number: n, title: `pr ${n}`, headRefName: `claude/issue-${n}-x`, headRefOid: H(n), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
  const v = await view(t, { pulls: [pr(20), pr(21, { statusCheckRollup: [{ status: 'IN_PROGRESS', name: 'ci' }] }), pr(22, { isDraft: true })], issues: [] });
  const review = byNumber(v, 20, 'pr');
  assert.equal(review.type, 'review');
  assert.equal(review.role, 'reviewer');
  assert.match(review.reason, /review order 1 of 1/);
  assert.equal(byNumber(v, 21, 'pr').state, 'waiting');
  assert.match(byNumber(v, 21, 'pr').waitsOn.text, /./);
  assert.ok(byNumber(v, 22, 'pr'), 'a draft is listed too');
});

test('an issue and the pull request that carries it form one group', async t => {
  const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS', name: 'ci' }];
  const v = await view(t, { pulls: [{ number: 30, title: 'pr', headRefName: 'claude/issue-30-x', headRefOid: H(3), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green }], issues: [issue(30, 'the issue')] });
  const pr = byNumber(v, 30, 'pr');
  assert.equal(pr.group, 'issue-30');
  assert.deepEqual(v.queue.groups.map(g => g.key), ['issue-30']);
});

test('the strip: finished (struck through), running, next with a cap of six and a +N more card; each state has an icon', async t => {
  const finished = [1, 2, 3, 4, 5].map(i => ({ id: `${i}`.repeat(32), provider: 'claude', kind: 'implement', issue: 40 + i, status: i === 5 ? 'failed' : 'completed', createdAt: NOW - (10 - i) * 3600000, updatedAt: NOW - (10 - i) * 3600000 + 600000 }));
  const issues = Array.from({ length: 9 }, (_, i) => issue(60 + i, `todo ${i}`));
  const v = await view(t, { jobs: finished, issues });
  const lane = v.queue.lanes.find(l => l.role === 'implementer');
  assert.equal(lane.done.length, 4, 'the last four finished');
  assert.equal(lane.done.at(-1).state, 'failed');
  assert.equal(lane.next.length, 6);
  assert.equal(lane.more, 3);
  const html = renderRoute(v, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  assert.match(html, /<s>#4\d<\/s>/, 'finished numbers are struck through');
  assert.match(html, /\+3 more/);
  assert.match(html, /qs-card st-failed/);
  assert.match(html, /qs-ic sev-action"[^>]*>\s*<svg/, 'a failure has an icon as well as a colour');
  assert.match(html, /no estimate|est\. start/);
});

test('the Queue page: route, sortable headers, type and needs-me filters, estimate label', async t => {
  const v = await view(t, { jobs: history('implement', 30), issues: [issue(1, 'one'), issue(2, 'two'), issue(3, 'blocked', { labels: ['needs-homeowner'] })] });
  assert.deepEqual(matchRoute('/queue'), { page: 'queue' });
  const get = q => renderRoute(v, matchRoute('/queue'), { query: new URLSearchParams(q), pathname: '/queue' });
  const all = get('');
  assert.equal(all.status ?? 200, 200);
  assert.match(all.html, /Estimate: counted from the jobs ahead/);
  assert.match(all.html, /queue\.sort=position/, 'sortable header');
  assert.match(all.html, /#1 one|#1/);
  const needs = get('qf.needs=1').html;
  assert.match(needs, /blocked/);
  assert.ok(!/>#1 one</.test(needs) && !needs.includes('>two<'), 'only the items waiting for me');
  const reviews = get('qf.type=review').html;
  assert.ok(!reviews.includes('>#2'), 'filtered by type');
  const phone = all.html;
  assert.match(phone, /data-label="Est\. start"/, 'the phone layout labels every cell');
});

test('foreman_queue: the same data, filters, read-only, and a clear answer when the view has no queue', async t => {
  const v = await view(t, { issues: [issue(1, 'one'), issue(2, 'needs me', { labels: ['needs-homeowner'] })] });
  const tools = createTools({ source: { get: async () => ({ view: v, ageMs: 0, stale: false }) }, readHost: () => ({}), now: () => NOW });
  const def = tools.list().find(x => x.name === 'foreman_queue');
  assert.equal(def.annotations?.readOnlyHint, true);
  const all = JSON.parse((await tools.call('foreman_queue', {})).text);
  assert.equal(all.total, v.queue.total);
  assert.deepEqual(all.items.map(i => i.position), v.queue.items.map(i => i.position));
  const me = JSON.parse((await tools.call('foreman_queue', { needsMe: true })).text);
  assert.deepEqual(me.items.map(i => i.number), [2]);
  assert.equal(me.items[0].waitsOn.kind, 'homeowner');
  const bad = await tools.call('foreman_queue', { type: 'nope' });
  assert.ok(bad.isError || JSON.parse(bad.text).matching === 0);
  const none = JSON.parse((await createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), now: () => NOW }).call('foreman_queue', {})).text);
  assert.equal(none.available, false);
});

test('queue mode leaves the plan and the slot-full holds exactly as a plain plan: no non-fitting pick feeds a later role', async t => {
  // Slot-full hold (issue #380) survives the queue extension.
  const running = [{ id: 'a'.repeat(32), provider: 'claude', status: 'running', createdAt: NOW - MIN, updatedAt: NOW }];
  const v = await view(t, { cfg: config({ roles: { implementer: 1, reviewer: 1 } }), issues: [issue(1, 'one'), issue(2, 'two'), issue(3, 'three')], jobs: running, state: { jobs: { [running[0].id]: { kind: 'implement', issue: 1, agent: 'claude' } } } });
  assert.match(Object.values(v.budget || {}).map(b => b.held?.implement).filter(Boolean).join('|'), /implementer slot full/);
  // Across roles: a rebase pick beyond the rebaser slot must not claim files that block a fitting implement pick.
  const sha = n => H(n);
  const pulls = [10, 11].map((iss, k) => ({ number: 60 + k, title: `p${k}`, headRefName: `claude/issue-${iss}-x`, headRefOid: sha(k + 1), baseRefName: 'main', isDraft: false, mergeable: 'CONFLICTING', statusCheckRollup: [] }));
  const w = await view(t, { cfg: config({ roles: { implementer: 1, reviewer: 1, rebaser: 1 } }), pulls, issues: [issue(10, 'a', { body: 'edit docs/a.md' }), issue(11, 'b', { body: 'edit docs/b.md' }), issue(12, 'c', { body: 'edit docs/b.md' })] });
  const pick = a => `${a.type}:${a.pr ?? a.issue}`;
  const mine = w.plan.map(pick);
  assert.ok(mine.includes('implement:12') || !mine.some(x => x.startsWith('rebase:')), `the implement pick is not lost to a queued rebase: ${mine}`);
});

test('plan({queue:true}) returns exactly what a plain plan() returns, with the same holds, across roles and scenarios', async t => {
  const sha = n => H(n);
  const conflicting = [10, 11].map((iss, k) => ({ number: 60 + k, title: `p${k}`, headRefName: `claude/issue-${iss}-x`, headRefOid: sha(k + 1), baseRefName: 'main', isDraft: false, mergeable: 'CONFLICTING', statusCheckRollup: [] }));
  const running = [{ id: 'a'.repeat(32), provider: 'claude', status: 'running', createdAt: NOW - MIN, updatedAt: NOW }];
  const scenarios = [
    { cfg: config({ roles: { implementer: 1, reviewer: 1, rebaser: 1 } }), pulls: conflicting, issues: [issue(10, 'a', { body: 'edit docs/a.md' }), issue(11, 'b', { body: 'edit docs/b.md' }), issue(12, 'c', { body: 'edit docs/b.md' })] },
    { cfg: config({ roles: { implementer: 1, reviewer: 1 } }), pulls: [], issues: [issue(1, 'one'), issue(2, 'two'), issue(3, 'three')], jobs: running, state: { jobs: { [running[0].id]: { kind: 'implement', issue: 1, agent: 'claude' } } } } ];
  for (const sc of scenarios) {
    const mk = () => { const cache = { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls: sc.pulls, issues: sc.issues, probes: {}, fetchedAt: NOW - 60000 };
      return cacheBackedTeam(sc.cfg, tmp(t), cache, sc.jobs || [], sc.state || {}, [], NOW, [], '', 'UTC'); };
    const [plain, queued] = [mk(), mk()];
    const a = await plain.plan(), b = await queued.plan({ queue: true });
    assert.deepEqual(b, a, 'same plan');
    for (const [ag, h] of Object.entries(plain.held || {})) for (const [k, v] of Object.entries(h)) assert.equal(queued.held?.[ag]?.[k], v, `hold ${ag}.${k} survives the queue extension`);
    assert.ok(queued.queued.length >= a.filter(x => x.type !== 'merge').length);
  }
});
