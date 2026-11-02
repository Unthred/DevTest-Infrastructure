// One naming scheme (issue #147): the formatter for each kind, and every surface rendering a known job through it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TITLE_MAX, clipTitle, formatCommit, formatIssue, formatJob, formatPr, makeNamer, shortCommit, shortJob } from '../supervisor/naming.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderRoute, matchRoute } from '../supervisor/dashrender.mjs';
import { buildStatus, renderStatus } from '../supervisor/teamstatus.mjs';
import { Team } from '../supervisor/team.mjs';
import { alertSender } from '../supervisor/alert.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const NOW = Date.UTC(2026, 10, 1, 20, 50, 0);
const H = n => String(n).repeat(40).slice(0, 40);
const TITLE = 'Show the allowance honestly';
const LONG = 'A deliberately long issue title that goes on well past the sixty character limit for display';
const RUNNING = '3f2a91c0' + 'a'.repeat(24);      // the 32-character id the notices used to print in full
const BLOCKED = '9d8e7f60' + 'b'.repeat(24);

// ---- 1. the formatter, one test per kind
test('issue: "#104 <issue title>"', () => {
  assert.equal(formatIssue(104, TITLE), '#104 Show the allowance honestly');
  assert.equal(formatIssue(104, null), '#104');
});
test('PR: "PR #146 · #104 <issue title>", always naming the issue and using the ISSUE title, never the PR title', () => {
  assert.equal(formatPr(146, { number: 104, title: TITLE }), 'PR #146 · #104 Show the allowance honestly');
  assert.equal(formatPr(146, null), 'PR #146');
  const names = makeNamer({ repo: 'o/r', issues: [{ number: 104, title: TITLE }], pulls: [{ number: 146, title: 'Totally different PR title', headRefName: 'claude/issue-104-x' }] });
  assert.equal(names.pr(146).text, 'PR #146 · #104 Show the allowance honestly');
  assert.ok(!names.pr(146).text.includes('Totally different'));
});
test('job: "<type> · PR #146 · #104 <issue title> · job 3f2a91c0" with the first 8 characters of the id', () => {
  assert.equal(formatJob({ kind: 'review', id: RUNNING, pr: 146, issue: { number: 104, title: TITLE } }), 'review · PR #146 · #104 Show the allowance honestly · job 3f2a91c0');
  assert.equal(formatJob({ kind: 'implement', id: RUNNING, issue: { number: 104, title: TITLE } }), 'implement · #104 Show the allowance honestly · job 3f2a91c0');
  assert.equal(shortJob(RUNNING), '3f2a91c0'); assert.equal(shortJob(RUNNING).length, 8);
  const names = makeNamer({ repo: 'o/r', issues: [{ number: 104, title: TITLE }], pulls: [{ number: 146, headRefName: 'claude/issue-104-x' }] });
  const j = names.job({ id: RUNNING, kind: 'review', issue: 146 });      // a review job's `issue` field holds the PR number
  assert.equal(j.text, 'review · PR #146 · #104 Show the allowance honestly · job 3f2a91c0');
  assert.equal(j.url, '/work/job/3f2a91c0');
});
test('commit: first 7 characters', () => {
  assert.equal(formatCommit(H(7)), '7777777'); assert.equal(shortCommit(H(7)).length, 7);
  assert.equal(makeNamer({ repo: 'o/r' }).commit(H(7)).url, `https://github.com/o/r/commit/${H(7)}`);
});
test('links go to the GitHub page; a long title is cut with the full title kept for the hover', () => {
  const names = makeNamer({ repo: 'o/r', issues: [{ number: 104, title: LONG }], pulls: [{ number: 146, headRefName: 'claude/issue-104-x' }] });
  assert.equal(names.issue(104).url, 'https://github.com/o/r/issues/104'); assert.equal(names.pr(146).url, 'https://github.com/o/r/pull/146');
  assert.ok(names.issue(104).text.endsWith('…') && names.issue(104).text.length <= `#104 `.length + TITLE_MAX);
  assert.equal(names.issue(104).full, `#104 ${LONG}`);
  assert.equal(clipTitle('short'), 'short');
});
test('the issue of a PR is found from its branch, a merged PR, the merge log or a job record', () => {
  const issues = [{ number: 104, title: TITLE }, { number: 7, title: 'Seven' }, { number: 8, title: 'Eight' }, { number: 9, title: 'Nine' }];
  const n = makeNamer({ issues, merged: [{ number: 50, closingIssuesReferences: [{ number: 7 }] }], mergeLog: [{ pr: 51, issue: 8 }], stateJobs: { x: { pr: 52, issue: 9 } } });
  assert.equal(n.pr(50).text, 'PR #50 · #7 Seven'); assert.equal(n.pr(51).text, 'PR #51 · #8 Eight'); assert.equal(n.pr(52).text, 'PR #52 · #9 Nine');
});

// ---- 2. every surface renders a known job through the formatter
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [104] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } }
};
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const cache = () => ({ tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, delivered: [], merged: [],
  pulls: [{ number: 146, title: 'Unrelated PR title', headRefName: 'claude/issue-104-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green }],
  issues: [{ number: 104, title: TITLE, state: 'OPEN', labels: [], prerequisites: [] }, { number: 2, title: 'Two', state: 'OPEN', labels: [], prerequisites: [] }] });
const job = (id, over) => ({ id, provider: 'codex', kind: 'review', issue: 146, branch: 'codex/review-146', status: 'running', createdAt: NOW - 600000, updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 1, ...over });
const jobs = [job(RUNNING), job(BLOCKED, { status: 'blocked', lastEvent: 'retry_exhausted', updatedAt: NOW - 60000 })];
const events = [{ job: RUNNING, kind: 'started', at: NOW - 500000 }];
const state = { verdicts: { [`146:${H(1)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 5000, findings: [] } }, jobs: {}, mergeLog: [] };
const known = id => `review · PR #146 · #104 ${TITLE} · job ${id.slice(0, 8)}`;
const strip = html => html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'");

test('Activity, Now, Needs you, Reviews and Work render the known job and PR through the formatter, linked', async () => {
  const v = await buildView({ config, root: fs.mkdtempSync(path.join(os.tmpdir(), 'nm-')), jobs, events, state, cache: cache(), snapshots: [], now: NOW });
  const page = name => renderRoute(v, matchRoute(name), { pathname: name }).html;
  const overview = page('/'), activity = page('/activity'), reviews = page('/reviews'), work = page('/work');
  const now = overview.slice(overview.indexOf('data-card="now"'), overview.indexOf('data-card="next"'));
  const needs = overview.slice(overview.indexOf('data-card="needs"'), overview.indexOf('data-card="warnings"'));
  assert.ok(strip(now).includes(known(RUNNING)), 'Now panel');
  assert.match(now, new RegExp(`<a href="/work/job/3f2a91c0">review · PR #146`), 'a job links to its job page');
  assert.ok(strip(needs).includes(known(BLOCKED)), 'Needs you');
  assert.ok(strip(activity).includes(known(RUNNING)), 'Activity');
  assert.match(strip(reviews), /PR #146 · #104 Show the allowance honestly/, 'Reviews');
  assert.match(work, /<a href="\/work\/pr\/146">PR #146 · #104 Show the allowance honestly<\/a>/, 'Work');
  assert.equal(page('/work/job/3f2a91c0').includes('job 3f2a91c0'), true, 'the job page exists');
  for (const html of [overview, activity, reviews, work]) {
    assert.ok(!html.includes(RUNNING) || /data-copy="/.test(html), 'a full job id appears only as a copy value');
    assert.doesNotMatch(strip(html), /PR #146(?! · #104)/, 'a PR is never named without its issue');
  }
});
test('long titles truncate with the full title on hover', async () => {
  const c = cache(); c.issues[0].title = LONG;
  const v = await buildView({ config, root: fs.mkdtempSync(path.join(os.tmpdir(), 'nm-')), jobs, events, state, cache: c, snapshots: [], now: NOW });
  const html = renderRoute(v, matchRoute('/work'), { pathname: '/work' }).html;
  assert.match(html, new RegExp(`<a href="/work/pr/146" title="PR #146 · #104 ${LONG}">PR #146 · #104 A deliberately[^<]*…</a>`));
});
test('team status names the same job and PR with the same strings', async () => {
  const s = await buildStatus({ config: (await import('../supervisor/team.mjs')).validateTeamConfig(config), root: '/nonexistent', jobs, events, state, cache: cache(), snapshots: [], leases: [], now: NOW, tz: 'UTC' });
  const out = renderStatus(s);
  assert.ok(out.includes(`running: ${known(RUNNING)}`), out);
  assert.ok(out.includes(known(BLOCKED)), 'Problems names the blocked job');
  assert.ok(out.includes(`PR #146 · #104 ${TITLE} ready`), 'Pull requests');
  assert.doesNotMatch(out, /PR #146(?! · #104)/);
  assert.ok(!out.includes(RUNNING));
});
test('a GitHub notice and an alert for a job use the same job and PR names', async t => {
  const comments = [], alerts = [];
  const pulls = cache().pulls, issues = cache().issues;
  const gh = { listPulls: async () => pulls, listIssues: async () => issues, listMergedPulls: async () => [], getPull: async n => pulls.find(p => p.number === n) || null,
    comment: async (n, b) => comments.push([n, b]), hasComment: async () => false, addLabel: async () => {}, board: async () => {} };
  const jobsApi = { listActive: async () => [], get: async id => (id === BLOCKED ? { status: 'blocked', lastEvent: 'retry_exhausted' } : null) };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { validateTeamConfig } = await import('../supervisor/team.mjs');
  const team = new Team({ config: validateTeamConfig(config), root: stateRoot(path.join(dir, 'state')), gh, jobs: jobsApi, git: null, register: '', clock: { now: () => NOW }, alert: async text => alerts.push(text) });
  team.s.jobs[BLOCKED] = { kind: 'review', agent: 'codex', pr: 146, ingested: true, at: 1 };
  await team.loadNames();
  await team.notifyOne(BLOCKED, team.s.jobs[BLOCKED], { notified: [] });
  assert.equal(comments.length, 1);
  assert.ok(comments[0][1].includes(`Supervised ${known(BLOCKED)} (codex) stopped`), comments[0][1]);
  assert.ok(!comments[0][1].includes(`job \`${BLOCKED}\``) || comments[0][1].includes(`status ${BLOCKED}`), 'the full id appears only in the command to run');
  // the fix-limit alert names the PR the same way
  assert.equal(team.names().pr(146).text, `PR #146 · #104 ${TITLE}`);
  // alert sender is unchanged: it delivers whatever text it is given
  assert.equal(typeof alertSender, 'function');
});
