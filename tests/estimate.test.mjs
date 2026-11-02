// Estimated finish time (issue #156): deterministic p50/p90 from a fixture job history, allowance moving the estimate past a
// reset, the upgrade rate limit as a wait, "no estimate yet" with too little history, and the same text in `team status` and
// on the dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateQueue, globalWaits, percentile, stepStats, fixChance, MIN_SAMPLES, TICK_MS } from '../supervisor/estimate.mjs';
import { buildStatus, renderStatus } from '../supervisor/teamstatus.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { validateTeamConfig } from '../supervisor/team.mjs';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const MIN = 60000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = () => validateTeamConfig({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } } });
const hex = n => n.toString(16).padStart(32, '0');

// History: five PRs (100-104). Per PR: implement (50..70 min), a 15 min CI gap, review (10 min), fix (20 min), 15 min CI gap,
// re-review (10 min). Only PR 100 ever got CHANGES, so the chance of a fix round is 20%.
function history({ reviews = 5 } = {}) {
  const jobs = [], st = { jobs: {}, verdicts: {} };
  let id = 1, t = NOW - 48 * 60 * MIN;
  const add = (kind, pr, minutes, extra = {}) => {
    const job = { id: hex(id++), provider: kind === 'review' ? 'codex' : 'claude', kind, issue: pr, status: 'completed', createdAt: t, updatedAt: t + minutes * MIN };
    jobs.push(job); st.jobs[job.id] = { kind, pr, ...extra };
    t = job.updatedAt; return job;
  };
  [50, 55, 60, 65, 70].forEach((m, i) => {
    const pr = 100 + i;
    add('implement', pr, m); t += 15 * MIN;
    if (i < reviews) add('review', pr, 10);
    st.verdicts[`${pr}:${'a'.repeat(40)}`] = { verdict: i === 0 ? 'CHANGES' : 'PASS', reviewer: 'codex', at: t };
    if (i === 0) { t += 0; add('fix', pr, 20); t += 15 * MIN; add('review', pr, 10); }
    else { add('fix', pr, 20); t += 15 * MIN; add('review', pr, 10); }
    t += 60 * MIN;
  });
  return { jobs, state: st };
}
const queue = (over = {}) => ({ claude: [{ type: 'issue', ref: 30, title: 'thirty', reason: 'next: implement', next: true }], codex: [], ...over });
const est = (o = {}) => estimateQueue({ queues: queue(), pulls: [], budget: {}, config: config(), now: NOW, tz: 'UTC', ...history(), ...o });

test('percentile is nearest-rank and deterministic', () => {
  assert.equal(percentile([50, 55, 60, 65, 70], 0.5), 60);
  assert.equal(percentile([50, 55, 60, 65, 70], 0.9), 70);
  assert.equal(percentile([], 0.5), null);
});

test('fixture history gives the exact step statistics and fix chance', () => {
  const { jobs, state } = history();
  const s = stepStats(jobs, state);
  assert.deepEqual([s.implement.n, s.implement.p50, s.implement.p90], [5, 60 * MIN, 70 * MIN]);
  assert.deepEqual([s.review.n, s.review.p50], [10, 10 * MIN]);
  assert.deepEqual([s.fix.n, s.fix.p50], [5, 20 * MIN]);
  assert.equal(s.ci.p50, 15 * MIN);
  assert.ok(s.ci.n >= MIN_SAMPLES);
  const f = fixChance(state);
  assert.deepEqual([f.prs, f.p], [5, 0.2]);
});

test('1. a queued issue gets a deterministic p50-p90 range from the job history', () => {
  const e = est().items['issue:30'];
  assert.equal(e.status, 'estimated');
  // p50: implement 60 + CI 15 + review 10, then one tick to merge. 20% < 50%, so no fix round on the p50 path.
  assert.equal(e.finish.p50, NOW + (60 + 15 + 10) * MIN + TICK_MS);
  // p90: implement 70 + CI 15 + review 10, a fix round (20% >= 10%): fix 20 + CI 15 + re-review 10, then one tick.
  assert.equal(e.finish.p90, NOW + (70 + 15 + 10 + 20 + 15 + 10) * MIN + TICK_MS);
  assert.equal(e.text, 'est. 13:30\u201314:25');
  assert.deepEqual(est().items['issue:30'], e);   // same history, same answer
  const basis = e.basis.join('\n');
  assert.match(basis, /Queue position 1 of 1/);
  assert.match(basis, /implement \u2192 CI \u2192 review/);
  assert.match(basis, /implement 1 h 00 min\/1 h 10 min \(n=5\)/);
  assert.match(basis, /overall cap 2/);
});

test('1b. queue position and the role slot push a second issue back', () => {
  const q = queue({ claude: [{ type: 'issue', ref: 30, title: 'a', reason: 'next: implement', next: true }, { type: 'issue', ref: 31, title: 'b', reason: 'ready; waits behind the running job', next: false }] });
  const e = est({ queues: q }).items;
  // One implementer slot: 31 starts only when 30's implement step has ended (60 min at p50).
  assert.equal(e['issue:31'].finish.p50, NOW + (60 + 60 + 15 + 10) * MIN + TICK_MS);
  assert.match(e['issue:31'].basis[0], /Queue position 2 of 2/);
});

test('1c. a running job holds the slot only for the rest of its typical time', () => {
  const running = { id: hex(900), provider: 'claude', kind: 'implement', issue: 29, status: 'running', createdAt: NOW - 20 * MIN, updatedAt: NOW };
  const e = est({ jobs: [...history().jobs, running] }).items['issue:30'];
  assert.equal(e.finish.p50, NOW + (40 + 60 + 15 + 10) * MIN + TICK_MS);
});

test('2. an allowance limit moves the estimate past the reset time and says so', () => {
  const reset = NOW + 5 * 3600000;
  const e = est({ budget: { claude: { mode: 'waiting', until: reset, resetsAt: reset } } }).items['issue:30'];
  assert.equal(e.finish.p50, reset + (60 + 15 + 10) * MIN + TICK_MS);
  assert.ok(e.finish.p90 > reset);
  assert.match(e.text, /\(after 17:00 reset\)$/);
  assert.ok(e.waits.some(w => w.kind === 'allowance' && /after 17:00 reset/.test(w.text)));
  // A forecast that runs out before the step would start is treated the same way.
  const f = est({ budget: { claude: { mode: 'normal', runsOutAt: NOW - MIN, resetsAt: reset } } }).items['issue:30'];
  assert.equal(f.finish.p50, e.finish.p50);
  // A forecast that runs out later than the step starts does not move it.
  const later = est({ budget: { claude: { mode: 'normal', runsOutAt: NOW + 2 * 3600000, resetsAt: reset } } }).items['issue:30'];
  assert.equal(later.finish.p50, est().items['issue:30'].finish.p50);
  assert.ok(!later.waits.some(w => w.kind === 'allowance'));
});

test('3. a rate-limited upgrade appears as a wait with its next-try time', () => {
  const w = globalWaits({ upgrade: { lastUpgradeAt: NOW - 30 * MIN }, now: NOW, tz: 'UTC' });
  assert.deepEqual(w.map(x => [x.kind, x.at, x.text]), [['upgrade', NOW + 30 * MIN, 'upgrade waiting, next try 12:30']]);
  assert.deepEqual(globalWaits({ upgrade: { lastUpgradeAt: NOW - 61 * MIN }, now: NOW, tz: 'UTC' }), []);   // limit over: no wait
  assert.deepEqual(globalWaits({ upgrade: null, now: NOW, tz: 'UTC' }), []);
  assert.deepEqual(est({ upgrade: { lastUpgradeAt: NOW - 30 * MIN } }).waits.map(x => x.text), ['upgrade waiting, next try 12:30']);
});

test('4. a step type with too little history shows "no estimate yet"', () => {
  const { jobs, state } = history();
  const few = jobs.filter(j => !(j.kind === 'review' && state.jobs[j.id].pr >= 102 && jobs.filter(x => x.kind === 'review').indexOf(j) >= 4));
  const e = est({ jobs: few, state }).items['issue:30'];
  assert.equal(stepStats(few, state).review.n, 4);
  assert.equal(e.status, 'no-estimate');
  assert.equal(e.text, 'no estimate yet');
  assert.ok(e.missing.includes('review'));   // CI gaps are measured against reviews, so they thin out too
  assert.match(e.basis[0], /review \(4 so far\)/);
  assert.equal(e.finish, undefined);
  // no history at all
  assert.equal(est({ jobs: [], state: {} }).items['issue:30'].text, 'no estimate yet');
});

test('blocked and conflicting items get a reason instead of a time', () => {
  const q = queue({ claude: [{ type: 'issue', ref: 30, title: 'a', reason: 'blocked by #9', next: false }] });
  assert.equal(est({ queues: q }).items['issue:30'].text, 'no estimate: blocked by #9');
});

test('an open PR: CI running is a wait; a PASS merges on the next tick; red CI needs a CI fix first', () => {
  const pr = (n, extra) => ({ number: n, title: `pr ${n}`, headRefName: `claude/issue-${n}-x`, headRefOid: 'b'.repeat(40), mergeable: 'MERGEABLE', isDraft: false, statusCheckRollup: green, ...extra });
  const pending = pr(40, { statusCheckRollup: [{ status: 'IN_PROGRESS' }] });
  const pass = pr(41), red = pr(42, { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] });
  const h = history();
  h.state.verdicts[`41:${'b'.repeat(40)}`] = { verdict: 'PASS', reviewer: 'codex', at: NOW };
  const q = { claude: [40, 41, 42].map(n => ({ type: 'pr', ref: n, title: `pr ${n}`, reason: 'x', next: false })), codex: [] };
  const e = estimateQueue({ queues: q, pulls: [pending, pass, red], budget: {}, config: config(), now: NOW, tz: 'UTC', ...h }).items;
  assert.equal(e['pr:40'].finish.p50, NOW + (15 + 10) * MIN + TICK_MS);
  assert.deepEqual(e['pr:40'].waits.map(w => w.text), ['CI running']);
  assert.equal(e['pr:41'].finish.p50, NOW + TICK_MS);
  assert.equal(e['pr:42'].status, 'no-estimate');   // red CI needs a CI fix first and no ci-fix jobs are recorded yet
  assert.ok(e['pr:42'].missing.includes('cifix'));
});

// ---- the same estimate in `team status` and on the dashboard
const issueRow = (n, state = 'OPEN') => ({ number: n, title: `issue ${n}`, state, body: '', labels: [] });
async function status() {
  const h = history();
  return buildStatus({ config: config(), root: '/nonexistent', jobs: h.jobs, events: [], state: h.state, snapshots: [], leases: [], now: NOW, tz: 'UTC',
    cache: { tick: { at: NOW - MIN, status: 'ok', lastOkAt: NOW - MIN }, fetchedAt: NOW - MIN, pulls: [], issues: [issueRow(30), issueRow(2)], merged: [] } });
}
test('team status prints the estimates', async () => {
  const s = await status();
  const out = renderStatus(s);
  assert.match(out, /=== Estimated finish/);
  assert.match(out, /issue #30 \(claude\): est\. \d\d:\d\d\u2013\d\d:\d\d/);
  assert.match(out, /claude → implement issue #30 \(est\. /);
  assert.ok(s.estimates.items.every(e => e.basis.length > 0));
  assert.ok(!/est\./.test(s.next.plan[0].text), 'plan text itself is unchanged');
});

test('the dashboard shows the estimate on Next and queue rows with the basis on hover', async () => {
  const { buildView } = await import('../supervisor/dashboard.mjs');
  const h = history();
  const view = await buildView({ config: config(), root: '/nonexistent', jobs: h.jobs, events: [], state: h.state, snapshots: [], now: NOW,
    cache: { tick: { at: NOW - MIN, status: 'ok', lastOkAt: NOW - MIN }, fetchedAt: NOW - MIN, pulls: [], issues: [issueRow(30), issueRow(2)], merged: [] }, register: '', registerUnreadable: true });
  assert.ok(view.estimates.items['issue:30']);
  const overview = renderRoute(view, { page: 'overview' }).html;
  assert.match(overview, /data-est="estimated" title="[^"]*Queue position 1 of /);
  assert.match(overview, /est\. \d\d:\d\d\u2013\d\d:\d\d/);
  const work = renderRoute(view, { page: 'work' }).html;
  assert.match(work, /est\. \d\d:\d\d/);
  const agent = renderRoute(view, { page: 'agent', id: 'claude' }).html;
  assert.match(agent, /Est\. finish/);
});

test('a reviews_only author is not delayed for fix, CI fix or rebase steps', () => {
  const h = history();
  for (let i = 0; i < 5; i++) {
    const id = hex(900 + i), at = NOW - (10 + i) * 60 * MIN;
    h.jobs.push({ id, provider: 'claude', kind: 'cifix', issue: 100 + i, status: 'completed', createdAt: at, updatedAt: at + 12 * MIN });
    h.state.jobs[id] = { kind: 'cifix', pr: 100 + i };
  }
  const red = { number: 42, title: 'pr 42', headRefName: 'claude/issue-42-x', headRefOid: 'b'.repeat(40), mergeable: 'MERGEABLE', isDraft: false, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] };
  const q = { claude: [{ type: 'pr', ref: 42, title: 'pr 42', reason: 'x', next: false }], codex: [] };
  const reset = NOW + 72 * 3600000;
  const run = budget => estimateQueue({ queues: q, pulls: [red], budget, config: config(), now: NOW, tz: 'UTC', ...h }).items['pr:42'];
  const normal = run({}), only = run({ claude: { mode: 'reviews_only', until: reset, resetsAt: reset } });
  assert.equal(normal.status, only.status);
  assert.deepEqual(only.finish, normal.finish);
  assert.doesNotMatch(only.text, /reset/);
  // implement steps are still held to the reset
  assert.ok(est({ budget: { claude: { mode: 'reviews_only', until: reset, resetsAt: reset } } }).items['issue:30'].finish.p50 > reset);
});
