// Issue #455: the visual-evidence script must stage every dashboard file the pages load (it once missed legend.mjs, so the saved pages
// were captured without their chart legends and layout script), derive its page list from the routes, and let the caller select pages.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderRoute, PAGE_NAMES, matchRoute } from '../supervisor/dashrender.mjs';
import { STATIC } from '../supervisor/dashserver.mjs';
import { loadedFiles, pagePlan, readServed, refsInHtml, refsInModule, selectPages, stageDashui } from './helpers/dashui-stage.mjs';

const H = n => String(n).repeat(40).slice(0, 40);
const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] } } };
const job = { id: 'a'.repeat(32), provider: 'claude', kind: 'implement', issue: 30, branch: 'claude/issue-30-x', status: 'running', createdAt: NOW - 600000, updatedAt: NOW - 1000, lastProgress: NOW - 1000, attempts: 1 };
const cache = { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, delivered: [],
  pulls: [{ number: 41, title: 'PR', headRefName: 'claude/issue-30-x', headRefOid: H(1), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green }],
  issues: [{ number: 30, title: 'Thirty', state: 'OPEN', labels: [], prerequisites: [] }] };
const makeView = async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visstage-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'jobs')); fs.writeFileSync(path.join(root, 'jobs', `${job.id}.json`), JSON.stringify(job));
  const view = await buildView({ config: cfg, root, jobs: [job], events: [], state: {}, cache, snapshots: [], now: NOW });
  return { root, view };
};

test('every file a rendered page loads, and every script those load in turn, is a served file and is staged', async t => {
  const { root, view } = await makeView(t);
  const plan = pagePlan(view, { root });
  const htmls = plan.map(e => renderRoute(view, e.route, { pathname: e.path }).html);
  const loaded = loadedFiles(htmls, u => readServed(u));
  assert.ok(loaded.includes('/static/legend.mjs'), 'legend.mjs is loaded through app.js and was the file the old script missed');
  assert.ok(loaded.includes('/static/watch.mjs') && loaded.includes('/static/logic.mjs') && loaded.includes('/static/style.css'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'visstage-out-')); t.after(() => fs.rmSync(dest, { recursive: true, force: true }));
  const staged = stageDashui(dest);
  for (const url of loaded) {
    assert.ok(STATIC[url], `${url} is loaded by a page but the server does not serve it`);
    assert.ok(staged.includes(url) && fs.existsSync(path.join(dest, url)), `${url} is loaded by a page but was not staged`);
  }
  assert.deepEqual(fs.readdirSync(path.join(dest, 'static')).sort(), Object.values(STATIC).map(([f]) => f).sort(), 'the whole served set is staged');
});

test('the test fails if a loaded dashui file is not staged (negative)', () => {
  const html = '<script type="module" src="/static/app.js"></script><script src="/static/brand-new.js"></script>';
  const loaded = loadedFiles([html], u => (u === '/static/brand-new.js' ? "import './helper.mjs';" : readServed(u)));
  assert.ok(loaded.includes('/static/helper.mjs') && loaded.includes('/static/legend.mjs'));
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'visstage-neg-')); try {
    const staged = stageDashui(dest);
    const missing = loaded.filter(u => !staged.includes(u));
    assert.deepEqual(missing, ['/static/brand-new.js', '/static/helper.mjs'], 'a file the server does not serve is reported, not silently skipped');
  } finally { fs.rmSync(dest, { recursive: true, force: true }); }
  assert.deepEqual(refsInModule("import { a } from './logic.mjs'; const x = await import('./late.mjs'); import '/static/y.js';").sort(), ['/static/late.mjs', '/static/logic.mjs', '/static/y.js']);
  assert.deepEqual(refsInHtml('<a href="/work">x</a><link href="/static/style.css"><img src="data:x">'), ['/static/style.css']);
});

test('the page list covers every dashboard route and the page argument selects from it', async t => {
  const { root, view } = await makeView(t);
  const ev = fs.mkdtempSync(path.join(os.tmpdir(), 'visstage-ev-')); t.after(() => fs.rmSync(ev, { recursive: true, force: true }));
  fs.mkdirSync(path.join(ev, 'ui-review', 'r1'), { recursive: true }); fs.writeFileSync(path.join(ev, 'ui-review', 'r1', 'report.md'), '# r');
  const plan = pagePlan(view, { root, evidenceRoot: ev });
  const covered = new Set(plan.map(e => matchRoute(e.path).page));
  for (const page of PAGE_NAMES) assert.ok(covered.has(page), `no captured page for the "${page}" route`);
  for (const e of plan) assert.equal(renderRoute(view, e.route, { pathname: e.path }).status, 200, `${e.name} (${e.path}) renders`);
  assert.ok(plan.every(e => /^[a-z0-9][a-z0-9._-]{0,60}$/.test(e.name)), 'names are usable as capture file names');
  assert.deepEqual(selectPages(plan, undefined).map(e => e.name), plan.map(e => e.name));
  assert.deepEqual(selectPages(plan, 'work, overview,work').map(e => e.name), ['work', 'overview']);
  assert.throws(() => selectPages(plan, 'work,nope'), /unknown page\(s\) nope; available: overview/);
  assert.throws(() => selectPages(plan, ','), /unknown page/);
});
