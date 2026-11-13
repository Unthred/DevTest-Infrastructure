// Issue #1227: the Files: line, the avoid-sentence fallback, the open-PR overlap hold and the Files-line drift item.
// The planner tests drive Team.tick() with the pull request file list in the shape gh.listPullFiles returns (an array of paths).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, expectedFiles, driftItemsOf } from '../supervisor/team.mjs';
import { filesLineRefusal, parseFilesLine } from '../supervisor/fileslist.mjs';
import { validateItem } from '../supervisor/inbox.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { recordTick, readCache } from '../supervisor/dashdata.mjs';
import { buildView } from '../supervisor/dashboard.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n\n## D-021 — y\n- Status: homeowner-approved\n- Date: 2026-10-31\n';
const manifest = { claude: { aliases: ['opus', 'sonnet'], efforts: ['low', 'high'] }, codex: { aliases: ['big', 'mid'], efforts: ['low', 'high'] } };
const config = issues => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' }, out_of_allowance: { weekly_at: 0.95 },
  limits: { roles: { implementer: 2, reviewer: 1 }, max_review_attempts: 2, max_fix_attempts: 2 },
  models: { agents: { claude: { implement: { model: 'sonnet', effort: 'high' }, review: { model: 'opus', effort: 'low' } }, codex: { implement: { model: 'big', effort: 'high' }, review: { model: 'mid', effort: 'low' } } } },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
const pr = (n, extra = {}) => ({ number: n, title: `t${n}`, headRefName: `codex/issue-${n}-x`, headRefOid: H(n % 9 + 1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, ...extra });
const issue = (n, body = '') => ({ number: n, title: `Issue ${n} title here`, state: 'OPEN', body, labels: [] });

function world(t, { issues, pulls = [], files = {} }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const created = [];
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => issues, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, hasComment: async () => false, board: async () => {},
    listPullFiles: async n => files[n] || [] };
  const jobs = { seq: 0, states: {}, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const team = new Team({ config: config(issues.map(i => i.number)), root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: REGISTER, clock: { now: () => 1_800_000_000_000 }, providerModels: manifest });
  return { team, implemented: () => created.filter(s => s.kind === 'implement').map(s => s.issue).sort((a, b) => a - b) };
}

test('a Files line alone defines the expected files; prose is not scanned', () => {
  const body = 'Edit supervisor/team.mjs and docs/x.md.\nFiles: supervisor/fileslist.mjs, tests/a.test.mjs\n';
  assert.deepEqual([...expectedFiles({ title: 'See docs/y.md', body })].sort(), ['supervisor/fileslist.mjs', 'tests/a.test.mjs']);
  assert.deepEqual(parseFilesLine('Files: ./a/b.mjs'), { present: true, paths: ['a/b.mjs'] });
  assert.deepEqual([...expectedFiles({ title: 'x', body: 'Files:' })], [], 'an empty Files line claims nothing');
});

test('without a Files line a path that appears only in an avoid, not, never or except sentence is ignored', () => {
  const body = 'Change supervisor/a.mjs. Do not touch supervisor/b.mjs. Never edit c/d.md. Avoid e/f.md.\nExcept g/h.md, all is fine.\nThen see supervisor/b.mjs for the pattern.';
  assert.deepEqual([...expectedFiles({ title: 'x', body })].sort(), ['supervisor/a.mjs', 'supervisor/b.mjs'], 'b.mjs is also named in a plain sentence, so it stays');
  assert.deepEqual([...expectedFiles({ title: 'x', body: 'Do not edit a/b.mjs' })], []);
});

test('the real bodies of issues 1217 and 1219 as posted: which files each claims before and after', () => {
  const read = n => JSON.parse(fs.readFileSync(new URL(`./fixtures/issue-${n}-as-posted.json`, import.meta.url), 'utf8'));
  const a = read(1217), b = read(1219);
  // Before this change every path named anywhere counted, including the ones the body says to keep out of.
  const before = i => new Set(`${i.title}\n${i.body}`.match(/(?<![\w./-])(?:[\w.-]+\/)+[\w.-]*\w(?![\w/])|(?<![\w./-])[\w-]+\.(?:mjs|js|json|md|yml|yaml|cs|sh|html|css)\b/g).filter(f => /\.\w+$/.test(f)));
  assert.ok(before(a).has('dashrender.mjs') && before(a).has('team.mjs') && before(a).has('dashserver.mjs'), '1217 claimed the files it says to keep out of');
  assert.ok(before(b).has('dashrender.mjs'));
  const afterA = expectedFiles(a), afterB = expectedFiles(b);
  for (const f of ['dashrender.mjs', 'team.mjs', 'dashserver.mjs']) assert.ok(!afterA.has(f), `1217 no longer claims ${f}`);
  assert.ok(afterA.has('docs/dashboard.md'), 'a file it does name plainly is still claimed');
  for (const f of ['dashrender.mjs', 'team.mjs', 'dashserver.mjs']) assert.ok(afterB.has(f), `1219 names ${f} in a plain sentence and still claims it`);
  assert.equal(afterA.size < before(a).size, true);
});

test('draft validation accepts a Files line and refuses more than 8 paths, a glob, or a second line', () => {
  const draft = body => validateItem({ kind: 'issue_draft', title: 'A title', body });
  assert.equal(draft('Does a thing.\nFiles: a/b.mjs, c.md').ok, true);
  assert.equal(draft('No line at all').ok, true);
  const nine = Array.from({ length: 9 }, (_, i) => `a/f${i}.mjs`).join(', ');
  assert.match(draft(`Files: ${nine}`).reason, /at most 8/);
  assert.equal(draft(`Files: ${nine.split(', ').slice(0, 8).join(', ')}`).ok, true);
  assert.match(draft('Files: supervisor/*.mjs').reason, /not a glob/);
  assert.match(draft('Files: a.md\nFiles: b.md').reason, /at most one/);
  assert.match(draft('Files: ../x.md').reason, /repository paths/);
  assert.match(draft('Files: a.md,, b.md').reason, /empty entry/);
  assert.equal(filesLineRefusal('Files: a/b.mjs'), null);
});

test('an open PR editing a file holds the item, names both by number, and the next eligible item is taken', async t => {
  const w = world(t, { issues: [issue(20, 'Files: supervisor/shared.mjs'), issue(21, 'Files: other/free.mjs')], pulls: [pr(5)], files: { 5: ['supervisor/shared.mjs'] } });
  await w.team.tick();
  assert.deepEqual(w.implemented(), [21], 'item 20 is skipped, item 21 starts');
  const why = JSON.stringify(w.team.held);
  assert.match(why, /issue #20 waits: it is expected to edit supervisor\/shared\.mjs, which open PR #5 also edits/);
});

test('a draft PR also holds; a merged or closed PR does not', async t => {
  const draft = world(t, { issues: [issue(20, 'Files: supervisor/shared.mjs')], pulls: [pr(5, { isDraft: true })], files: { 5: ['supervisor/shared.mjs'] } });
  await draft.team.tick();
  assert.deepEqual(draft.implemented(), []);
  for (const state of ['MERGED', 'CLOSED']) {
    const w = world(t, { issues: [issue(20, 'Files: supervisor/shared.mjs')], pulls: [pr(5, { state })], files: { 5: ['supervisor/shared.mjs'] } });
    await w.team.tick();
    assert.deepEqual(w.implemented(), [20], `${state} PR does not hold`);
  }
  const none = world(t, { issues: [issue(20, 'Files: supervisor/shared.mjs')], pulls: [], files: {} });
  await none.team.tick();
  assert.deepEqual(none.implemented(), [20]);
});

test("an item's own open PR does not hold it, and a PR on other files does not hold it", async t => {
  const w = world(t, { issues: [issue(20, 'Files: supervisor/shared.mjs')], pulls: [pr(20), pr(6)], files: { 20: ['supervisor/shared.mjs'], 6: ['docs/else.md'] } });
  await w.team.tick();
  assert.equal(JSON.stringify(w.team.held).includes('open PR'), false);
});

test('a PR changing 3 unlisted files raises an action item naming them; 2 does not; no Files line does not', async t => {
  const pulls = [pr(30), pr(31), pr(32)];
  const w = world(t, { issues: [issue(30, 'Files: a/one.mjs'), issue(31, 'Files: a/one.mjs'), issue(32, 'prose only a/one.mjs')],
    pulls, files: { 30: ['a/one.mjs', 'x/1.mjs', 'x/2.mjs', 'x/3.mjs'], 31: ['a/one.mjs', 'x/1.mjs', 'x/2.mjs'], 32: ['a/one.mjs', 'x/1.mjs', 'x/2.mjs', 'x/3.mjs'] } });
  await w.team.tick();
  const items = driftItemsOf(w.team);
  assert.equal(items.length, 1);
  assert.equal(items[0].severity, 'action');
  assert.deepEqual(items[0].ref, { kind: 'pull', n: 30 });
  for (const f of ['x/1.mjs', 'x/2.mjs', 'x/3.mjs']) assert.ok(items[0].text.includes(f), f);
  assert.ok(!items[0].text.includes('a/one.mjs,'), 'the listed file is not reported as extra');
});

test('a prose item that names a file by its bare name is held by an open PR on that file path', async t => {
  const held = world(t, { issues: [issue(20, 'Change the dashboard in dashrender.mjs to add buttons.')], pulls: [pr(5)], files: { 5: ['supervisor/dashrender.mjs'] } });
  await held.team.tick();
  assert.deepEqual(held.implemented(), [], 'dashrender.mjs matches supervisor/dashrender.mjs');
  assert.match(JSON.stringify(held.team.held), /issue #20 waits: .*dashrender\.mjs.*open PR #5/);
  const other = world(t, { issues: [issue(20, 'Change the dashboard in dashrender.mjs to add buttons.')], pulls: [pr(5)], files: { 5: ['supervisor/xdashrender.mjs'] } });
  await other.team.tick();
  assert.deepEqual(other.implemented(), [20], 'a different file whose name ends the same does not hold');
});

test('the drift item reaches the dashboard through the tick cache, which keeps no issue bodies', async t => {
  const w = world(t, { issues: [issue(30, 'Files: a/one.mjs')], pulls: [pr(30)], files: { 30: ['a/one.mjs', 'x/1.mjs', 'x/2.mjs', 'x/3.mjs'] } });
  await w.team.tick();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fl-cache-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  recordTick(root, { now: 1_800_000_000_000, status: 'ok', team: w.team, jobs: [] });
  const cache = readCache(root);
  assert.equal(cache.issues.some(i => 'body' in i), false, 'the cache keeps no issue body');
  const v = await buildView({ config: w.team.c, root, jobs: [], events: [], state: {}, cache, snapshots: [], now: 1_800_000_000_000 });
  const item = v.attention.find(a => a.id === 'files-drift-30');
  assert.ok(item, 'the Needs you list holds the drift item');
  assert.equal(item.severity, 'action');
  assert.ok(item.text.includes('x/3.mjs'));
});
