// Overview clarity (issue #76): per-agent header, why nothing is planned, idle-tick collapse, Activity filters, local time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderRoute, lt } from '../supervisor/dashrender.mjs';
import { buildStatus } from '../supervisor/teamstatus.mjs';
import { compactIssues } from '../supervisor/dashdata.mjs';
import { agentLine } from '../supervisor/agentline.mjs';
import { collapseIdle, filterActivity, formatLocal } from '../supervisor/dashui/logic.mjs';

const NOW = Date.parse('2026-11-02T20:00:00Z');
const MIN = 60000;
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30, 5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2, 3] } } });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `pr ${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = (n, state = 'OPEN', body = '', labels = []) => ({ number: n, title: `issue ${n}`, state, body, labels });
const job = (over = {}) => ({ id: 'a'.repeat(32), provider: 'claude', kind: 'implement', issue: 30, branch: 'claude/issue-30-x', status: 'running', createdAt: NOW - 600000, updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 1, ...over });
const paused = (over = {}) => job({ id: 'b'.repeat(32), provider: 'codex', kind: 'review', issue: 36, status: 'paused_limit', lastEvent: 'usage_limit', nextAttemptAt: NOW + 90 * MIN, ...over });
const tick = { at: NOW - MIN, status: 'ok', error: null, lastOkAt: NOW - MIN };
const tmp = t => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'ovc-')); t.after(() => fs.rmSync(r, { recursive: true, force: true })); fs.chmodSync(r, 0o700); return r; };
const build = (t, { jobs = [], cache = {}, snapshots = [], state = {}, events = [] } = {}) =>
  buildView({ config: config(), root: tmp(t), jobs, events, state, cache: { tick, fetchedAt: NOW - MIN, pulls: [], ...cache, issues: compactIssues(cache.issues || [issue(30), issue(5), issue(2), issue(3)]) }, snapshots, now: NOW, tz: 'UTC' });
const page = (v, route = { page: 'overview' }, qs = '') => renderRoute(v, route, { query: new URLSearchParams(qs), pathname: route.page === 'activity' ? '/activity' : route.page === 'work' ? '/work' : '/' }).html;
const esc = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const header = html => /<header class="statusbar"[\s\S]*?<\/header>/.exec(html)[0];
const lines = html => [...header(html).matchAll(/<li><a class="agent-badge[^"]*" href="([^"]+)" data-agent="(\w+)" data-state="(\w+)"[^>]*>[\s\S]*?<\/li>/g)].map(m => ({ href: m[1], agent: m[2], state: m[3], html: m[0], text: m[0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() }));

// ---- 1. header per agent: a compact badge (name, role, state), linking to the agent's page (issue #421)
test('header: both running shows two compact running badges that link to the agent pages', async t => {
  const v = await build(t, { jobs: [job(), job({ id: 'c'.repeat(32), provider: 'codex', kind: 'rebase', issue: 41, branch: 'codex/issue-3-x' })] });
  const l = lines(page(v));
  assert.deepEqual(l.map(x => [x.agent, x.state, x.href]), [['claude', 'running', '/agents/claude'], ['codex', 'running', '/agents/codex']]);
  assert.equal(l[0].text, 'claude Implementer Running'); assert.equal(l[1].text, 'codex Implementer Running');
  assert.match(l[0].html, /aria-label="claude · Implementer · Running"/);
  assert.doesNotMatch(header(page(v)), /title="Overall health"/);
});
test('header: a reviewer job shows the Reviewer role; a paused agent shows Paused and no restart text', async t => {
  const v = await build(t, { jobs: [job(), paused()] });
  const html = page(v), l = lines(html);
  assert.deepEqual(l.map(x => [x.agent, x.state, x.text]), [['claude', 'running', 'claude Implementer Running'], ['codex', 'paused', 'codex Reviewer Paused']]);
  assert.doesNotMatch(header(html), /restarts about|<time/);
});
test('header: an idle agent shows name and state only', async t => {
  const l = lines(page(await build(t, { jobs: [] })));
  assert.deepEqual(l.map(x => x.text), ['claude Idle', 'codex Idle']);
});
test('header: several jobs on one agent show a count, not a role or any description', async t => {
  const v = await build(t, { jobs: [job(), job({ id: 'e'.repeat(32), kind: 'review', issue: 36, branch: 'claude/issue-5-x' })] });
  const a = v.agents.find(x => x.name === 'claude');
  if ((a.jobs || []).length < 2) a.jobs = [a.job, { ...a.job, id: 'e'.repeat(32), role: 'reviewer' }]; // fixture limits may allow one job: force two
  const l = lines(page(v)).find(x => x.agent === 'claude');
  assert.equal(l.text, 'claude 2 jobs Running');
  assert.doesNotMatch(l.html, /Implementer|Reviewer/);
});
// The job description appears once, on the Now card: not in the bar, the agent's card or the Next card (issue #421).
test('description: a job description renders on the Now card only, not in the bar, the agent card or the Next card', async t => {
  const v = await build(t, { jobs: [job(), paused()] });
  const a = v.agents.find(x => x.name === 'claude'), desc = a.job.name;
  assert.ok(desc && desc.length > 5, 'fixture job has a description: ' + desc);
  const html = page(v), count = h => h.split(esc(desc)).length - 1;
  assert.equal(count(header(html)), 0, 'not in the app bar');
  const cardOf = id => new RegExp('data-card="' + id + '"[\\s\\S]*?(?=data-card=")').exec(html)[0];
  assert.equal(count(cardOf('now')), 1, 'exactly once, on the Now card');
  assert.equal(count(cardOf('next')), 0, 'not in the Next card');
  const agentsHtml = page(v, { page: 'agents' }, '');
  assert.equal(count(/data-card="a-claude"[\s\S]*?(?=data-card="a-codex")/.exec(agentsHtml)[0]), 0, 'not in the agent card');
});
test('header: the sentence is the one `team status` prints (same function, same words)', async t => {
  const jobs = [job(), paused()];
  const v = await build(t, { jobs });
  const status = await buildStatus({ config: config(), root: tmp(t), jobs, events: [], state: {}, snapshots: [], leases: [], now: NOW, tz: 'UTC', cache: { tick, fetchedAt: NOW - MIN, pulls: [], issues: [issue(30), issue(5), issue(2), issue(3)], merged: [] } });
  for (const a of v.agents) {
    assert.equal(status.agents.find(s => s.name === a.name).text, agentLine(a, ms => formatLocal(ms, 'UTC').slice(11, 16)), a.name);
  }
});
test('header: an unknown agent state is never described as idle', () => {
  assert.match(agentLine({ state: 'unknown', job: null }, String), /^unknown/);
  assert.match(agentLine({ state: 'idle', job: null, idleReason: { text: 'nothing to do' } }, String), /^idle: nothing to do/);
});

// ---- 2. Next card: why nothing is planned
test('next: nothing planned lists busy agents, paused agents with resume time, and linked blocked / waiting-for-review counts', async t => {
  const v = await build(t, {
    jobs: [job(), paused()],
    cache: { pulls: [pr(36, 'claude/issue-30-x', 'e'.repeat(40)), pr(37, 'claude/issue-5-x', 'f'.repeat(40))], issues: [issue(30), issue(5), issue(2, 'OPEN', 'Prerequisites: #9'), issue(3, 'OPEN', 'Prerequisites: #9'), issue(9)] }
  });
  assert.equal(v.plan.length, 0, 'fixture plans nothing');
  assert.equal(v.panels.nextWhy.blocked, 2); assert.ok(v.panels.nextWhy.waitingReview >= 1);
  const html = page(v), next = /data-card="next"[\s\S]*?(?=data-card="needs")/.exec(html)[0];
  assert.match(next, /Nothing is planned because/);
  assert.match(next, /claude<\/a> is busy with a running job \(see Now\)/); assert.match(next, /codex<\/a> is paused, resumes about <time[^>]*datetime="2026-11-02T21:30:00.000Z"/);
  assert.match(next, /<a href="\/work\?issues\.show=blocked">2 queued items blocked by dependencies<\/a>/);
  assert.match(next, new RegExp(`<a href="/work\\?prs\\.show=awaiting-review">${v.panels.nextWhy.waitingReview} waiting for review</a>`));
});
test('next: the reasons are absent while something is planned', async t => {
  const v = await build(t, {});
  assert.ok(v.plan.length > 0);
  assert.doesNotMatch(page(v), /Nothing is planned because/);
});
test('work: the count links filter the Work lists, and a chip clears the filter', async t => {
  const v = await build(t, { jobs: [job(), paused()], cache: { pulls: [pr(36, 'claude/issue-30-x', 'e'.repeat(40))], issues: [issue(30), issue(2, 'OPEN', 'Prerequisites: #9'), issue(9)] } });
  const blocked = page(v, { page: 'work' }, 'issues.show=blocked');
  assert.match(blocked, /Showing only open issues blocked by dependencies/);
  const rows = tbl(blocked, 'issues'); assert.ok(rows.includes('issue 2') && !rows.includes('issue 30'), rows);
  assert.doesNotMatch(page(v, { page: 'work' }), /Showing only/);
  const waiting = page(v, { page: 'work' }, 'prs.show=awaiting-review');
  assert.match(waiting, /Showing only pull requests waiting for review/);
});
const tbl = (html, id) => (new RegExp(`<table data-table="${id}">[\\s\\S]*?</table>`).exec(html) || [''])[0];

// ---- 3. idle collapse
const idle = at => ({ at, kind: 'tick', idle: true, outcome: 'idle', text: 'tick ok, nothing to dispatch' });
const busy = at => ({ at, kind: 'tick', idle: false, outcome: 'planned', text: 'tick ok, plan: claude implement #1' });
test('collapse: consecutive idle ticks become one row; a single idle tick stays a tick', () => {
  const rows = collapseIdle([idle(9), idle(8), idle(7), idle(6)]);
  assert.equal(rows.length, 1); assert.equal(rows[0].count, 4); assert.equal(rows[0].from, 6); assert.equal(rows[0].to, 9); assert.equal(rows[0].ticks.length, 4);
  assert.equal(collapseIdle([idle(9)]).length, 1); assert.equal(collapseIdle([idle(9)])[0].kind, 'tick');
  assert.deepEqual(collapseIdle([]), []);
});
test('collapse: a non-idle tick (or any event) between two idle runs gives two runs', () => {
  const rows = collapseIdle([idle(9), idle(8), busy(7), idle(6), idle(5), idle(4)]);
  assert.deepEqual(rows.map(r => r.kind === 'idle-run' ? `run${r.count}` : 'busy'), ['run2', 'busy', 'run3']);
  const withEvent = collapseIdle([idle(9), idle(8), { at: 7, kind: 'job', outcome: 'completed' }, idle(6), idle(5)]);
  assert.deepEqual(withEvent.map(r => r.kind), ['idle-run', 'job', 'idle-run']);
});
test('activity page: 14 idle ticks are one row, expandable (URL) to the ticks; an unexpanded page lists no single idle tick', async t => {
  const snapshots = Array.from({ length: 14 }, (_, i) => ({ at: NOW - (15 + i * 5) * MIN, status: 'ok', plan: [], ingested: 0 }));
  const v = await build(t, { snapshots });
  const html = page(v, { page: 'activity' });
  assert.match(html, /14 idle ticks, <time[^>]*>[^<]+<\/time> to <time/);
  assert.equal((html.match(/tick ok, nothing to dispatch/g) || []).length, 0);
  const at = Math.max(...snapshots.map(s => s.at));
  const open = page(v, { page: 'activity' }, `act.open=${at}`);
  assert.equal((open.match(/tick ok, nothing to dispatch/g) || []).length, 14);
  assert.match(open, /aria-expanded="true"/);
});
test('activity page: a tick that ingested something is not idle and splits the run', async t => {
  const snapshots = [[1, 0], [2, 0], [3, 1], [4, 0], [5, 0]].map(([i, ing]) => ({ at: NOW - i * 5 * MIN, status: 'ok', plan: [], ingested: ing }));
  const v = await build(t, { snapshots });
  const html = page(v, { page: 'activity' });
  assert.equal((html.match(/2 idle ticks/g) || []).length, 2, html.match(/\d idle ticks/g));
});

// ---- 4. columns and filters
test('activity: agent, duration, outcome and tokens columns for job events', async t => {
  const j = job({ id: 'c'.repeat(32), status: 'completed', kind: 'fix', issue: 27, createdAt: NOW - 20 * MIN, updatedAt: NOW - 5 * MIN, usage: { inputTokens: 1000, outputTokens: 234 } });
  const v = await build(t, { jobs: [j], events: [{ at: NOW - 5 * MIN, job: j.id, kind: 'completed' }] });
  const row = v.activity.find(r => r.kind === 'job');
  assert.deepEqual([row.agent, row.outcome, row.jobKind, row.durationMs, row.tokens], ['claude', 'completed', 'fix', 15 * MIN, 1234]);
  const html = page(v, { page: 'activity' });
  for (const col of ['Agent', 'Job kind', 'Outcome', 'Duration', 'Tokens']) assert.match(html, new RegExp(`<th[^>]*>(<a[^>]*>)?${col}`));
  assert.match(tbl(html, 'act'), /15m/); assert.match(tbl(html, 'act'), /1,234/);
});
test('filters combine, drop rows that do not match every filter, and live in the URL', async t => {
  const rows = [
    { at: 5, kind: 'job', agent: 'claude', outcome: 'completed', jobKind: 'fix', text: 'a' }, { at: 4, kind: 'job', agent: 'codex', outcome: 'completed', jobKind: 'review', text: 'b' },
    { at: 3, kind: 'job', agent: 'claude', outcome: 'blocked', jobKind: 'fix', text: 'c' }, { at: 2, kind: 'job', agent: 'claude', outcome: 'completed', jobKind: 'review', text: 'd' }];
  assert.deepEqual(filterActivity(rows, { agent: 'claude' }).map(r => r.text), ['a', 'c', 'd']);
  assert.deepEqual(filterActivity(rows, { agent: 'claude', outcome: 'completed' }).map(r => r.text), ['a', 'd']);
  assert.deepEqual(filterActivity(rows, { agent: 'claude', outcome: 'completed', kind: 'review' }).map(r => r.text), ['d']);
  assert.deepEqual(filterActivity(rows, { agent: 'codex', outcome: 'blocked' }), []);
  assert.equal(filterActivity(rows, {}).length, 4);
  const j1 = job({ id: 'c'.repeat(32), status: 'completed', kind: 'fix', issue: 27 }), j2 = job({ id: 'd'.repeat(32), provider: 'codex', status: 'completed', kind: 'review', issue: 28 });
  const v = await build(t, { jobs: [j1, j2], events: [{ at: NOW - 9 * MIN, job: j1.id, kind: 'completed' }, { at: NOW - 8 * MIN, job: j2.id, kind: 'completed' }] });
  const all = tbl(page(v, { page: 'activity' }), 'act');
  assert.match(all, /claude: Implementer fix of PR #27 completed/); assert.match(all, /codex: Reviewer reviewed PR #28/);
  const one = page(v, { page: 'activity' }, 'act.agent=codex&act.outcome=completed');
  assert.doesNotMatch(tbl(one, 'act'), /claude: Implementer fix of PR #27 completed/); assert.match(tbl(one, 'act'), /codex: Reviewer reviewed PR #28/);
  assert.match(one, /class="chip on" href="\/activity\?act\.outcome=completed"[^>]*>codex</, 'the active chip links to its own removal and keeps the other filter');
  assert.match(one, /class="chip" href="\/activity\?act\.agent=codex&amp;act\.outcome=completed&amp;act\.kind=review"/, 'an inactive chip adds its filter to the others');
  assert.match(one, /Clear filters/);
});
test('filters: a filter that hides a busy tick does not merge two idle runs', async t => {
  const snapshots = [[1, 0], [2, 0], [3, 1], [4, 0], [5, 0]].map(([i, ing]) => ({ at: NOW - i * 5 * MIN, status: 'ok', plan: [], ingested: ing }));
  const v = await build(t, { snapshots });
  const html = page(v, { page: 'activity' }, 'act.outcome=idle');
  assert.equal((html.match(/2 idle ticks/g) || []).length, 2);
});

// ---- 5. local time
test('time: every time is a <time> with its UTC instant; text falls back to UTC without script', () => {
  const h = lt(Date.parse('2026-11-02T21:30:00Z'));
  assert.equal(h, '<time class="lt" datetime="2026-11-02T21:30:00.000Z" data-local>2026-11-02 21:30 UTC</time>');
  assert.equal(lt(NaN), 'unknown');
});
test('time: formatLocal renders the same instant in two time zones, with the zone shown', () => {
  const ms = Date.parse('2026-11-02T21:30:00Z');
  assert.equal(formatLocal(ms, 'UTC'), '2026-11-02 21:30 UTC');
  assert.equal(formatLocal(ms, 'Europe/London'), '2026-11-02 21:30 GMT');
  assert.equal(formatLocal(ms, 'America/New_York'), '2026-11-02 16:30 GMT-5');
  assert.equal(formatLocal(ms, 'Asia/Tokyo').slice(0, 16), '2026-11-03 06:30');
  const summer = Date.parse('2026-07-01T12:00:00Z');
  assert.equal(formatLocal(summer, 'Europe/London').slice(11, 16), '13:00'); assert.match(formatLocal(summer, 'Europe/London'), /BST|GMT\+1/);
  assert.equal(formatLocal(ms, 'Not/AZone'), '2026-11-02 21:30 UTC', 'an unknown zone falls back to UTC');
  assert.equal(formatLocal(NaN, 'UTC'), 'unknown');
});
test('time: pages use <time> everywhere and carry a footer note; data in the view stays UTC milliseconds', async t => {
  const v = await build(t, { jobs: [job()], snapshots: [{ at: NOW - 5 * MIN, status: 'ok', plan: [{ agent: 'claude', type: 'implement', ref: 30 }] }] });
  for (const p of ['activity', 'work', 'agents', 'usage', 'reviews', 'supervisor']) {
    const html = page(v, { page: p });
    assert.doesNotMatch(html.replace(/<time[^>]*>[^<]*<\/time>/g, '').replace(/<title>[\s\S]*?<\/title>/g, '').replace(/data-copy="[^"]*"/g, ''), /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/, `${p}: a bare UTC time`);
    assert.match(html, /id="tznote"/);
  }
  assert.equal(typeof v.activity[0].at, 'number');
});
test('time: the browser script rewrites <time data-local> in the viewer zone and sets the footer note', () => {
  const src = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
  assert.match(src, /time\[data-local\]/); assert.match(src, /formatLocal\(ms, zone\)/); assert.match(src, /#tznote/);
});

// ---- 5b. no server-rendered time is left unlocalised or unlabelled (review of PR #217)
test('time: escT turns a labelled UTC stamp into <time data-local> and escapes the rest', async () => {
  const { escT } = await import('../supervisor/dashrender.mjs');
  const { tmark, localStamps } = await import('../supervisor/dashui/logic.mjs');
  const ms = Date.parse('2026-11-02T21:30:00Z');
  assert.equal(tmark(ms), '2026-11-02 21:30 UTC'); assert.equal(tmark(NaN), 'unknown');
  assert.equal(escT(`failed at ${tmark(ms)}: <b>`), `failed at ${lt(ms)}: &lt;b&gt;`);
  assert.equal(localStamps(`at ${tmark(ms)} and ${tmark(ms + 60000)}`, x => formatLocal(x, 'Europe/Paris')), 'at 2026-11-02 22:30 CET and 2026-11-02 22:31 CET');
});
// Review of PR #217 (head 2f285a4): the time in an attention text is plain, readable text in the view itself, so no
// internal marker reaches team status, its --json, /api/view.json or the overseer note.
test('time: warning texts are plain labelled UTC in the view and <time data-local> on every page that shows them', async t => {
  const root = tmp(t); fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify({ holding: { to: 'f'.repeat(40), since: NOW - 10 * MIN, jobs: 1 } }));
  const v = await buildView({ config: config(), root, jobs: [job()], events: [], state: {}, cache: { tick: { at: NOW - 3 * 3600000, status: 'error', error: 'boom' }, fetchedAt: NOW - MIN, pulls: [], issues: compactIssues([issue(30)]) }, snapshots: [], now: NOW, tz: 'UTC' });
  const json = JSON.stringify(v);
  assert.doesNotMatch(json, /\u27e6|\u27e7/, 'no internal marker in /api/view.json');
  const byId = id => v.attention.find(a => a.id === id).text;
  assert.match(byId('tick-failed'), /^Last tick failed at 2026-11-02 17:00 UTC: boom$/);
  assert.match(byId('tick-stale'), /\(last 2026-11-02 17:00 UTC\)/);
  assert.match(byId('upgrade-hold'), /^Install pending since 2026-11-02 19:50 UTC /);
  for (const p of ['overview', 'system']) {
    const html = page(v, { page: p });
    assert.ok(!/\u27e6|\u27e7/.test(html), `${p}: marker in HTML`);
    assert.ok(html.includes(`Last tick failed at ${lt(NOW - 3 * 3600000)}: boom`), `${p}: failed-tick time is a <time data-local>`);
  }
});
test('time: chart axis labels and tooltips are rewritten by the script from data-lms', async t => {
  const v = await build(t, { jobs: [job()], snapshots: [{ at: NOW - 5 * MIN, status: 'ok', plan: [] }] });
  const html = page(v, { page: 'usage' });
  for (const m of html.matchAll(/<text[^>]*class="ax"[^>]*>/g)) assert.match(m[0], /data-lms="\d+"/);
  for (const m of html.matchAll(/<title[^>]*>[^<]*(?:reset|at \d{4})[^<]*<\/title>/g)) assert.match(m[0], /data-lms="\d+"/);
  const src = fs.readFileSync(new URL('../supervisor/dashui/app.js', import.meta.url), 'utf8');
  assert.match(src, /\[data-lms\]/); assert.match(src, /timeOnly\(ms, zone\)/);
});
test('time: estimates name the zone they are computed in', async t => {
  const v = await build(t, { jobs: [job()], snapshots: [{ at: NOW - 5 * MIN, status: 'ok', plan: [{ agent: 'claude', type: 'implement', ref: 30 }] }] });
  assert.equal(v.tz, 'UTC');
  const html = page(v, { page: 'work' });
  if (/class="sub est"/.test(html)) assert.match(html, /class="sub est"[^>]*>[\s\S]*?<span class="tzl">\(UTC\)<\/span>/);
});

// Review of PR #217 (head 2d7d76a): the Since card and the Version health card's Next attempt must be <time data-local>,
// never plain server-rendered UTC text. Guard: no remaining esc(utc(...)) in a visible text outside a chart <title> that carries data-lms.
test('time: no visible timestamp is rendered as plain utc() text', () => {
  const src = fs.readFileSync(new URL('../supervisor/dashrender.mjs', import.meta.url), 'utf8');
  const bad = src.split('\n').filter(l => /esc\(utc\(/.test(l) && !/data-lms|lms\(|data-local/.test(l));
  assert.deepEqual(bad, []);
  assert.doesNotMatch(src, /\$\{when\}\)`/);
});

// Review of PR #217 (head a7294a5): the version badge's "next try" was plain `HH:MM UTC` text. Rendering guard: on every page, with the
// version drifting and rate-limited, a displayed time is a <time data-local> element (or a chart data-lms template); no `HH:MM UTC` stays
// as plain text. Attribute text (titles, templates) is not displayed text and is ignored.
const plainTimes = html => html
  .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, '')
  .replace(/<time\b[\s\S]*?<\/time>/g, '')
  .replace(/<title\b[^>]*data-lms[\s\S]*?<\/title>/g, '')
  .replace(/<text\b[^>]*data-lms[\s\S]*?<\/text>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .match(/\d{1,2}:\d{2}\s*UTC/g) || [];
test('time: the version badge next-try time is a local <time> and no page shows a plain UTC clock time', async t => {
  const v = await build(t, { jobs: [job(), paused()] });
  v.version = { installed: 'a'.repeat(40), main: 'b'.repeat(40), drift: true, behind: 2, nextTryAt: Date.parse('2026-07-01T12:34:00Z'), latched: false };
  const home = page(v);
  assert.match(header(home), /2 commits behind, next try <time class="lt" datetime="2026-07-01T12:34:00.000Z" data-local>2026-07-01 12:34 UTC<\/time>/);
  for (const p of ['overview', 'agents', 'work', 'activity', 'usage', 'reviews', 'supervisor', 'ticks', 'upgrades', 'system']) {
    const html = renderRoute(v, { page: p }, { query: new URLSearchParams(), pathname: `/${p}` }).html;
    assert.deepEqual(plainTimes(html), [], `page ${p} shows a plain UTC time: ${(html.replace(/<time\b[\s\S]*?<\/time>/g,'').match(/.{50}\d{1,2}:\d{2}\s*UTC.{10}/)||[''])[0]}`);
  }
});
test('time: the plain-time guard itself catches a bare UTC clock time', () => {
  assert.deepEqual(plainTimes('<p>next try 12:34 UTC</p>'), ['12:34 UTC']);
  assert.deepEqual(plainTimes('<p>next try <time data-local>2026-07-01 12:34 UTC</time></p>'), []);
});
