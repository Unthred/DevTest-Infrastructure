// One naming scheme (issue #147): the formatter for each kind, and every surface rendering a known job through it.
import { tmpDir } from './helpers/tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TITLE_MAX, clipTitle, describeJob, formatCommit, formatIssue, formatJob, formatPr, makeNamer, shortCommit, shortJob } from '../supervisor/naming.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderRoute, matchRoute } from '../supervisor/dashrender.mjs';
import { buildStatus, renderStatus } from '../supervisor/teamstatus.mjs';
import { Team } from '../supervisor/team.mjs';
import { alertSender } from '../supervisor/alert.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const NOW = Date.UTC(2026, 10, 1, 20, 50, 0);
const H = n => String(n).repeat(40).slice(0, 40);
const TITLE = 'Show the allowance honestly';
const PRT = 'Allow menu to be top, bottom, left or right';
const LONG = 'A deliberately long issue title that goes on well past the sixty character limit for display';
const RUNNING = '3f2a91c0' + 'a'.repeat(24);      // the 32-character id the notices used to print in full
const BLOCKED = '9d8e7f60' + 'b'.repeat(24);

// ---- 1. the formatter, one test per kind
test('issue: "#104 <issue title>"', () => {
  assert.equal(formatIssue(104, TITLE), '#104 Show the allowance honestly');
  assert.equal(formatIssue(104, null), '#104');
});
test('PR: "PR #149 <PR title> (for #140 <issue title>)", the PR\'s own title', () => {
  assert.equal(formatPr(149, PRT, { number: 140, title: 'Configurable menu position' }), 'PR #149 Allow menu to be top, bottom, left or right (for #140 Configurable menu position)');
  assert.equal(formatPr(149, PRT, null), 'PR #149 Allow menu to be top, bottom, left or right');
  assert.equal(formatPr(149, null, null), 'PR #149');
  const names = makeNamer({ repo: 'o/r', issues: [{ number: 104, title: TITLE }], pulls: [{ number: 146, title: PRT, headRefName: 'claude/issue-104-x' }] });
  assert.equal(names.pr(146).text, `PR #146 ${PRT} (for #104 ${TITLE})`);
});
test('the "(for #n …)" clause is dropped from the short form when there is no room, and kept in the full form', () => {
  const longPr = 'P'.repeat(80), issue = { number: 5, title: 'I'.repeat(80) };
  assert.ok(!formatPr(1, longPr, issue).includes('(for'));
  assert.ok(formatPr(1, longPr, issue, { max: Infinity }).includes('(for #5 '));
});
test('job: "<Role> · <action> · <item>" with the PR or issue and its title', () => {
  assert.equal(formatJob({ kind: 'review', pr: 146, prTitle: PRT, issue: { number: 104, title: TITLE } }), 'Reviewer · review · PR #146 Allow menu to be top, bottom, left or right');
  assert.equal(formatJob({ kind: 'implement', issue: { number: 104, title: TITLE } }), 'Implementer · implement · #104 Show the allowance honestly');
  assert.equal(formatJob({ kind: 'cifix', pr: 7, prTitle: 'X' }), 'Implementer · CI fix · PR #7 X');
  assert.equal(shortJob(RUNNING), '3f2a91c0'); assert.equal(shortJob(RUNNING).length, 8);
  const names = makeNamer({ repo: 'o/r', issues: [{ number: 104, title: TITLE }], pulls: [{ number: 146, title: PRT, headRefName: 'claude/issue-104-x' }] });
  const j = names.job({ id: RUNNING, kind: 'review', issue: 146 });      // a review job's `issue` field holds the PR number
  assert.equal(j.text, 'Reviewer · review · PR #146 Allow menu to be top, bottom, left or right'.replace(PRT, clipTitle(PRT)));
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
  const n = makeNamer({ issues, merged: [{ number: 50, title: 'p50', closingIssuesReferences: [{ number: 7 }] }], mergeLog: [{ pr: 51, issue: 8 }], stateJobs: { x: { pr: 52, kind: 'implement', issue: 9, prTitle: 'p52' } } });
  assert.equal(n.pr(50).text, 'PR #50 p50 (for #7 Seven)'); assert.equal(n.pr(51).text, 'PR #51 (for #8 Eight)'); assert.equal(n.pr(52).text, 'PR #52 p52 (for #9 Nine)');
});
test('titles fall back to the stored titles, then the job record, when GitHub gave none', () => {
  const stored = makeNamer({ titles: { issue: { 5: 'Stored issue' }, pr: { 6: 'Stored PR' } }, mergeLog: [{ pr: 6, issue: 5 }] });
  assert.equal(stored.pr(6).text, 'PR #6 Stored PR (for #5 Stored issue)');
  const rec = makeNamer({ stateJobs: { j: { kind: 'review', pr: 6, prTitle: 'On the record', forIssue: 5, issueTitle: 'Record issue' } } });
  assert.equal(rec.pr(6).text, 'PR #6 On the record (for #5 Record issue)');
  const live = makeNamer({ pulls: [{ number: 6, title: 'Fresh' }], titles: { pr: { 6: 'Stale' } } });
  assert.equal(live.pr(6).text, 'PR #6 Fresh', 'live GitHub data wins');
});
test('a title that carries a secret or e-mail is redacted before any surface can print it', () => {
  const tok = ['gh', 'p_'].join('') + 'A1b2C3d4'.repeat(4);
  const n = makeNamer({ pulls: [{ number: 1, title: `leak ${tok} a@b.example` }] });
  assert.ok(!n.pr(1).text.includes(tok) && !n.pr(1).full.includes('a@b.example'));
});

// ---- descriptions: one per outcome
const NM = makeNamer({ repo: 'o/r', issues: [{ number: 140, title: 'Configurable menu position' }], pulls: [{ number: 149, title: PRT, headRefName: 'claude/issue-140-menu' }] });
test('description: success (implementer opened a PR), changes requested, approved', () => {
  assert.equal(describeJob({ kind: 'implement', status: 'completed', issue: 140 }, { names: NM, rec: { kind: 'implement', issue: 140 }, opened: 149 }),
    `Implementer opened PR #149 ${clipTitle(PRT)} for #140 Configurable menu position.`);
  assert.equal(describeJob({ kind: 'review', status: 'completed', issue: 149 }, { names: NM, rec: { kind: 'review', pr: 149 }, verdict: { verdict: 'CHANGES', findings: ['a', 'b'] } }),
    `Reviewer requested changes on PR #149 ${clipTitle(PRT)}: 2 findings.`);
  assert.equal(describeJob({ kind: 'review', status: 'completed', issue: 149 }, { names: NM, rec: { kind: 'review', pr: 149 }, verdict: { verdict: 'PASS', findings: [] } }), `Reviewer approved PR #149 ${clipTitle(PRT)}.`);
});
test('description: failed and blocked name the reason; the agent\'s last summary line is appended when there is one', () => {
  const names = makeNamer({ pulls: [{ number: 137, title: 'Dashboard: watch a running job live', headRefName: 'codex/issue-9-x' }] });
  assert.equal(describeJob({ kind: 'rebase', status: 'failed', issue: 137 }, { names, rec: { kind: 'rebase', pr: 137, failure: 'conflict in tests/transcript.test.mjs' } }),
    'Rebase of PR #137 Dashboard: watch a running job live failed: conflict in tests/transcript.test.mjs.');
  assert.equal(describeJob({ kind: 'review', status: 'blocked', lastEvent: 'retry_exhausted', issue: 137 }, { names, rec: { kind: 'review', pr: 137 } }),
    'Reviewer review of PR #137 Dashboard: watch a running job live was blocked: retries exhausted.');
  assert.match(describeJob({ kind: 'fix', status: 'completed', issue: 137, summary: 'did a thing\nPushed the fix.' }, { names, rec: { kind: 'fix', pr: 137 } }), /Last note: Pushed the fix\.$/);
});

// ---- 2. every surface renders a known job through the formatter
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [104] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } }
};
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const cache = () => ({ tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, delivered: [], merged: [],
  pulls: [{ number: 146, title: PRT, headRefName: 'claude/issue-104-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green }],
  issues: [{ number: 104, title: TITLE, state: 'OPEN', labels: [], prerequisites: [] }, { number: 2, title: 'Two', state: 'OPEN', labels: [], prerequisites: [] }] });
const job = (id, over) => ({ id, provider: 'codex', kind: 'review', issue: 146, branch: 'codex/review-146', status: 'running', createdAt: NOW - 600000, updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 1, ...over });
const jobs = [job(RUNNING), job(BLOCKED, { status: 'blocked', lastEvent: 'retry_exhausted', updatedAt: NOW - 60000 })];
const events = [{ job: RUNNING, kind: 'started', at: NOW - 500000 }];
const state = { verdicts: { [`146:${H(1)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 5000, findings: [] } }, jobs: {}, mergeLog: [] };
const PRN = `PR #146 ${clipTitle(PRT)}`;
const known = () => `Reviewer · review · ${PRN}`;
const strip = html => html.replace(/<(script|style)[\s\S]*?<\/\1>/g, '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const build = (over = {}) => buildView({ config, root: tmpDir('nm-'), jobs, events, state, cache: cache(), snapshots: [], now: NOW, ...over });
const ROUTES = ['/', '/agents', '/agents/codex', '/agents/claude', '/work', '/work/pr/146', '/work/issue/104', '/work/job/3f2a91c0', '/work/job/9d8e7f60', '/activity', '/activity?group=issue', '/reviews', '/usage'];

test('Activity, Now, Inbox, Reviews and Work render the known job and PR through the formatter, linked', async () => {
  const v = await build();
  const page = name => renderRoute(v, matchRoute(name.split('?')[0]), { pathname: name.split('?')[0], query: new URLSearchParams(name.split('?')[1] || '') }).html;
  const overview = page('/'), activity = page('/activity'), reviews = page('/reviews'), work = page('/work');
  const now = overview.slice(overview.indexOf('data-card="now"'), overview.indexOf('data-card="next"'));
  const needs = overview.slice(overview.indexOf('data-card="needs"'), overview.indexOf('data-card="warnings"'));
  assert.ok(strip(now).replace(/\s+/g, ' ').includes(known()), 'Now panel');
  assert.match(now, /<a href="\/work\/job\/3f2a91c0"[^>]*>Reviewer · review · PR #146/, 'a job links to its job page');
  assert.ok(strip(needs).replace(/\s+/g, ' ').includes(known()), 'Inbox');
  assert.ok(strip(activity).replace(/\s+/g, ' ').includes(known()), 'Activity');
  assert.match(strip(reviews), /PR #146 Allow menu/, 'Reviews');
  assert.match(work, /<a href="\/work\/pr\/146"[^>]*>PR #146 Allow menu[^<]*<\/a>/, 'Work');
  assert.ok(page('/work/job/3f2a91c0').includes('3f2a91c0'), 'the job page exists');
  for (const html of [overview, activity, reviews, work]) assert.ok(!html.includes(RUNNING) || /data-copy="/.test(html), 'a full job id appears only as a copy value');
});
test('no page renders an issue, PR or job number without its title (DOM text check across pages)', async () => {
  const v = await build({ jobs: [...jobs, job('c0ffee00' + 'c'.repeat(24), { status: 'completed', createdAt: NOW - 900000 }), job('decaf000' + 'd'.repeat(24), { kind: 'implement', issue: 104, branch: 'claude/issue-104-x', status: 'failed', lastEvent: 'crash', createdAt: NOW - 800000 })] });
  for (const route of ROUTES) {
    const [pth, qs] = route.split('?');
    const out = renderRoute(v, matchRoute(pth), { pathname: pth, query: new URLSearchParams(qs || '') });
    assert.ok(out && out.html, `${route} renders`);
    const text = strip(out.html).replace(/\s+/g, ' ');
    // "PR #n" or "#n" must be followed by a title word, never by punctuation, a bracket or the end of a cell
    const bare = [...text.matchAll(/(?:PR )?#(\d+)(?!\d)(?! [A-Za-z(\[])/g)].map(m => text.slice(Math.max(0, m.index - 60), m.index + 90));
    assert.deepEqual(bare, [], `${route} shows a number without its title: ${route}`);
    assert.doesNotMatch(text, /\bjob [0-9a-f]{8}\b(?! ·)/, `${route} names a job by its bare id`);
  }
});
test('History keeps titles when GitHub is unreachable: the stored titles and the job record carry them', async () => {
  const offline = { tick: { at: NOW - 60000, status: 'error', error: 'gh failed', lastOkAt: NOW - 3600000 }, fetchedAt: NOW - 3600000, delivered: [], merged: [], pulls: [], issues: [] };
  const withTitles = { ...state, titles: { issue: { 104: TITLE }, pr: { 146: PRT } }, jobs: { [RUNNING]: { kind: 'review', agent: 'codex', pr: 146, prTitle: PRT, forIssue: 104, issueTitle: TITLE, ingested: false, at: 1 } } };
  const v = await build({ cache: offline, state: withTitles });
  const history = strip(renderRoute(v, matchRoute('/agents/codex'), { pathname: '/agents/codex', query: new URLSearchParams() }).html).replace(/\s+/g, ' ');
  assert.ok(history.includes(`Reviewer · review · ${PRN}`), history.slice(0, 400));
  // only the job record, with the stored titles missing too
  const v2 = await build({ cache: offline, state: { ...state, jobs: withTitles.jobs } });
  assert.ok(strip(renderRoute(v2, matchRoute('/agents/codex'), { pathname: '/agents/codex', query: new URLSearchParams() }).html).includes('PR #146 Allow menu'));
});
test('every finished job in History has a readable one-line description', async () => {
  const done = job('c0ffee00' + 'c'.repeat(24), { status: 'completed', createdAt: NOW - 900000 });
  const v = await build({ jobs: [...jobs, done], state: { ...state, verdicts: { [`146:${H(1)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 5000, findings: ['one', 'two'] } } } });
  const row = v.jobs.find(r => r.fullId === done.id), blocked = v.jobs.find(r => r.fullId === BLOCKED);
  assert.equal(row.desc, `Reviewer requested changes on ${PRN}: 2 findings.`);
  assert.match(blocked.desc, /^Reviewer review of PR #146 .* was blocked: retries exhausted\.$/);
  const html = renderRoute(v, matchRoute('/agents/codex'), { pathname: '/agents/codex', query: new URLSearchParams() }).html;
  assert.ok(html.includes('class="trunc"') && html.includes('requested changes on'), 'description shown, truncated by CSS, full text on hover');
});
test('Activity tells a story (time, description, job page) and groups by issue', async () => {
  const done = job('c0ffee00' + 'c'.repeat(24), { status: 'completed', createdAt: NOW - 900000 });
  const impl = job('feed0000' + 'f'.repeat(24), { kind: 'implement', provider: 'claude', issue: 104, branch: 'claude/issue-104-x', status: 'completed', createdAt: NOW - 2000000 });
  const st = { ...state, jobs: { [impl.id]: { kind: 'implement', agent: 'claude', issue: 104, pr: 146 } }, mergeLog: [{ pr: 146, issue: 104, agent: 'claude', mergedAt: NOW - 1000 }],
    verdicts: { [`146:${H(1)}`]: { verdict: 'PASS', reviewer: 'codex', at: NOW - 5000, findings: [] } } };
  const ev = [{ job: done.id, kind: 'completed', at: NOW - 700000 }];
  const v = await build({ jobs: [...jobs, done, impl], events: ev, state: st });
  const act = v.activity.find(r => r.text.includes('approved'));
  assert.ok(act, JSON.stringify(v.activity.map(r => r.text)));
  assert.equal(act.link.url, '/work/job/c0ffee00');
  const grouped = strip(renderRoute(v, matchRoute('/activity'), { pathname: '/activity', query: new URLSearchParams('group=issue') }).html).replace(/\s+/g, ' ');
  assert.ok(grouped.includes(`#104 ${TITLE}`));
  const story = grouped.slice(grouped.indexOf(`#104 ${TITLE}`));
  assert.ok(story.indexOf('Implementer opened') < story.indexOf('Merged PR #146'), story.slice(0, 500));
});
test('long titles truncate with the full title on hover', async () => {
  const c = cache(); c.pulls[0].title = LONG;
  const v = await build({ cache: c });
  const html = renderRoute(v, matchRoute('/work'), { pathname: '/work' }).html;
  assert.match(html, new RegExp(`<a href="/work/pr/146" title="PR #146 ${LONG}[^"]*">PR #146 A deliberately[^<]*…</a>`));
  assert.match(fs.readFileSync(new URL('../supervisor/dashui/style.css', import.meta.url), 'utf8'), /\.trunc\{[^}]*text-overflow:ellipsis/);
});
test('team status names the same job and PR with the same strings', async () => {
  const s = await buildStatus({ config: (await import('../supervisor/team.mjs')).validateTeamConfig(config), root: '/nonexistent', jobs, events, state, cache: cache(), snapshots: [], leases: [], now: NOW, tz: 'UTC' });
  const out = renderStatus(s);
  assert.ok(out.includes(`running: ${known()}`), out);
  assert.ok(out.includes(known()), 'Problems names the blocked job');
  assert.ok(out.includes(`${PRN} (for #104 ${TITLE}) ready`), 'Pull requests');
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
  assert.ok(comments[0][1].includes(`Supervised ${known()} (codex) stopped`), comments[0][1]);
  assert.ok(!comments[0][1].includes(`job \`${BLOCKED}\``) || comments[0][1].includes(`status ${BLOCKED}`), 'the full id appears only in the command to run');
  // the fix-limit alert names the PR the same way
  assert.equal(team.names().pr(146).text, `${PRN} (for #104 ${TITLE})`);
  // alert sender is unchanged: it delivers whatever text it is given
  assert.equal(typeof alertSender, 'function');
});

test('Foreman stores titles in its state and on the job record, and refreshes them on the next read of GitHub', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { validateTeamConfig } = await import('../supervisor/team.mjs');
  let pulls = cache().pulls, issues = cache().issues;
  const gh = { listPulls: async () => pulls, listIssues: async () => issues, listMergedPulls: async () => [] };
  const team = new Team({ config: validateTeamConfig(config), root: stateRoot(path.join(dir, 'state')), gh, jobs: { listActive: async () => [] }, git: null, register: '', clock: { now: () => NOW } });
  team.s.jobs[RUNNING] = { kind: 'review', agent: 'codex', pr: 146, at: 1 };
  await team.loadNames();
  assert.equal(team.s.titles.pr[146], PRT); assert.equal(team.s.titles.issue[104], TITLE);
  assert.equal(team.s.jobs[RUNNING].prTitle, PRT); assert.equal(team.s.jobs[RUNNING].issueTitle, TITLE); assert.equal(team.s.jobs[RUNNING].forIssue, 104);
  pulls = [{ ...pulls[0], title: 'Renamed PR' }];       // a rename is picked up on the next read
  await team.loadNames();
  assert.equal(team.s.jobs[RUNNING].prTitle, 'Renamed PR');
  issues = []; pulls = [];                              // GitHub gives nothing: the stored titles still name the work
  await team.loadNames();
  assert.equal(team.names().pr(146).text, 'PR #146 Renamed PR (for #104 ' + TITLE + ')');
});

// ---- issue #182 review follow-ups
test('a PR whose issue cannot be found is named by its own title everywhere', async () => {
  const names = makeNamer({ pulls: [{ number: 42, title: 'Stop adding AI credit lines', headRefName: 'claude/no-ai-attribution' }] });
  assert.equal(names.pr(42).text, 'PR #42 Stop adding AI credit lines');
  const c = cache(); c.pulls = [{ ...c.pulls[0], number: 42, title: 'Stop adding AI credit lines', headRefName: 'claude/no-ai-attribution', mergeable: 'CONFLICTING' }];
  const v = await build({ cache: c });
  const page = renderRoute(v, matchRoute('/work'), { pathname: '/work' }).html;
  assert.match(strip(page), /Stop adding AI credit lines/);
  assert.ok(v.prs.find(p => p.number === 42).title.includes('Stop adding AI credit lines'));
  const out = renderStatus(await buildStatus({ config: (await import('../supervisor/team.mjs')).validateTeamConfig(config), root: '/nonexistent', jobs, events, state, cache: c, snapshots: [], leases: [], now: NOW, tz: 'UTC' }));
  assert.match(out, /PR #42 Stop adding AI credit lines/);
});

test('a failed names read keeps the dashboard data and does not mark the tick as an error', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { validateTeamConfig } = await import('../supervisor/team.mjs');
  const gh = { listPulls: async () => { throw new Error('rate limited'); }, listIssues: async () => [], listMergedPulls: async () => [] };
  const team = new Team({ config: validateTeamConfig(config), root: stateRoot(path.join(dir, 'state')), gh, jobs: { listActive: async () => [] }, git: null, register: '', clock: { now: () => NOW } });
  team.view = { prs: [], issues: [] };
  await team.loadNames();                  // does not throw
  assert.equal(team.view, null, 'names data never counts as the dashboard view');
  assert.equal(team.nameView, null);
  gh.listPulls = async () => cache().pulls; gh.listIssues = async () => cache().issues;
  await team.loadNames();
  assert.equal(team.view, null, 'a successful names read fills nameView, not view');
  assert.equal(team.nameView.prs.length, 1);
  assert.equal(team.names().pr(146).text.startsWith('PR #146'), true);
});

test('public commit references show 7 characters and link the full SHA', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nm-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { validateTeamConfig } = await import('../supervisor/team.mjs');
  const team = new Team({ config: validateTeamConfig(config), root: stateRoot(path.join(dir, 'state')), gh: {}, jobs: { listActive: async () => [] }, git: null, register: '', clock: { now: () => NOW } });
  assert.equal(team.commitRef(H(1)), `[\`1111111\`](https://github.com/o/r/commit/${H(1)})`);
});

test('an older job (beyond the newest 300) has a job page, and a shared 8-character prefix gets a chooser', async () => {
  const many = Array.from({ length: 305 }, (_, i) => job(String(i).padStart(8, '0') + 'b'.repeat(24), { createdAt: NOW - 1000000 + i * 1000, status: 'completed' }));
  const dup = [job('12345678' + 'c'.repeat(24), { createdAt: NOW - 5000, status: 'completed' }), job('12345678' + 'd'.repeat(24), { createdAt: NOW - 4000, status: 'completed' })];
  const v = await build({ jobs: [...many, ...dup] });
  const get = id => renderRoute(v, matchRoute(`/work/job/${id}`), { pathname: `/work/job/${id}` });
  assert.equal(get('00000000').status, 200, 'the oldest job still resolves');
  assert.equal(get('99999999').status, 404, 'an unknown job is a 404');
  const amb = get('12345678');
  assert.equal(amb.status, 200); assert.match(amb.html, /More than one job starts with this id/);
  assert.match(amb.html, new RegExp('12345678' + 'c'.repeat(24))); assert.match(amb.html, new RegExp('12345678' + 'd'.repeat(24)));
  const one = get('12345678' + 'd'.repeat(24));
  assert.equal(one.status, 200); assert.doesNotMatch(one.html, /More than one job/);
});
