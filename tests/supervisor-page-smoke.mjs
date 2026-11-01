#!/usr/bin/env node
// Tower-only gate for the dashboard Supervisor area (issue #72). Renders the new pages from a realistic fixture (the redacted
// reconcile-log shapes in tests/fixtures/dashboard plus a stale lease, a blocked job, upgrade records and local-repo drift), serves
// them as static files on a host Unix socket, and runs the project's responsive layout audit (issue #6) in the pinned Playwright
// container at every standard width. The page script runs, so the copy buttons are visible and measured. No production state is
// read or written; screenshots stay under the evidence directory, never in Git (D-005). Run `node browser/prepare-cache.mjs` first.
//
// Staging note: browser/static-server.mjs has no MIME type for `.mjs`, and browsers refuse a module script served as
// application/octet-stream. The staged copy therefore serves dashui/logic.mjs as /static/logic.js and rewrites the one import in
// app.js. The real dashboard server (supervisor/dashserver.mjs) serves logic.mjs with a JavaScript type.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sourceProject = path.resolve(here, '..');
const runTag = crypto.randomBytes(6).toString('hex');
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/sup-smoke', runTag);
const evidence = path.join('/mnt/cache/appdata/devtest-infrastructure/evidence/issue-72', runTag);
const lock = JSON.parse(fs.readFileSync(path.join(sourceProject, 'docker', 'images.lock.json'), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(sourceProject, uid, gid);
const project = stage.project;
const config = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
let failed = false;
const check = (name, ok, detail = {}) => { console.log(JSON.stringify({ check: name, ok: !!ok, ...detail })); if (!ok) failed = true; };

// ---- fixture state root (temporary), rendered to static pages
const NOW = Date.parse('2026-10-31T18:07:00Z'), MIN = 60000, H = n => String(n).repeat(40).slice(0, 40);
async function fixtureSite(dir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sup-smoke-state-'));
  try {
    for (const d of ['jobs', 'team', 'leases', 'dashboard', `versions/${H(1)}`]) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.symlinkSync(`versions/${H(1)}`, path.join(root, 'current')); fs.lutimesSync(path.join(root, 'current'), (NOW - 30 * 3600000) / 1000, (NOW - 30 * 3600000) / 1000);
    fs.copyFileSync(path.join(here, 'fixtures', 'dashboard', 'reconcile-sample.log'), path.join(root, 'reconcile.log'));
    const job = { id: 'b485512f78df4a50af28f7b192a30710', provider: 'codex', kind: 'review', issue: 41, status: 'blocked', attempts: 3, lastEvent: 'retry_exhausted', createdAt: NOW - 3 * 3600000, updatedAt: NOW - 20 * MIN, postcondition: { kind: 'verdict', pr: 41, head: H(4) } };
    fs.writeFileSync(path.join(root, 'jobs', `${job.id}.json`), JSON.stringify(job));
    fs.writeFileSync(path.join(root, 'leases', 'k1'), JSON.stringify({ job: job.id, at: NOW - 3 * 3600000 }));
    fs.writeFileSync(path.join(root, 'leases', 'k2'), JSON.stringify({ job: 'c'.repeat(32), at: NOW - 26 * 3600000 }));
    fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ verdicts: { [`41:${H(4)}`]: { verdict: 'CHANGES', reviewer: 'codex', at: NOW - 3600000, findings: [{ kind: 'blocking', summary: 'x' }] } }, jobs: {} }));
    fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify({ prechecked: { [H(2)]: NOW - 5 * 3600000 } }));
    fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), [{ at: NOW - 30 * 3600000, from: H(0), to: H(1), prs: [59, 28, 65], result: 'verified', checks: { eligibility: 'ok', liveTick: 'ok' } },
      { at: NOW - 5 * 3600000, from: H(1), to: H(2), prs: [70], result: 'precheck_failed', reason: 'tests: 1 failing (tests/dashboard.test.mjs)' }].map(r => JSON.stringify(r)).join('\n') + '\n');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git', 'refs', 'heads'), { recursive: true }); fs.mkdirSync(path.join(repo, '.git', 'refs', 'remotes', 'origin'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n'); fs.writeFileSync(path.join(repo, '.git', 'refs', 'heads', 'main'), `${H(1)}\n`); fs.writeFileSync(path.join(repo, '.git', 'refs', 'remotes', 'origin', 'main'), `${H(2)}\n`);
    const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: repo, worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
      agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [72] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [3] } } };
    const cache = { tick: { at: NOW - 2 * MIN, status: 'ok', error: null, lastOkAt: NOW - 2 * MIN }, fetchedAt: NOW - 2 * MIN, delivered: [], issues: [{ number: 72, title: 'Dashboard: Supervisor health area and copy buttons', state: 'OPEN', labels: [], prerequisites: [] }],
      pulls: [{ number: 41, title: 'OpenBao credentials', headRefName: 'claude/issue-7-07-openbao-credentials', headRefOid: H(4), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }] };
    const view = await buildView({ config: cfg, root, jobs: [job], events: [], state: JSON.parse(fs.readFileSync(path.join(root, 'team', 'state.json'), 'utf8')), cache, snapshots: [], now: NOW });
    {
      const pages = { overview: ['/', 'index.html'], supervisor: ['/supervisor', 'supervisor/index.html'], ticks: ['/supervisor/ticks', 'supervisor/ticks/index.html'], upgrades: ['/supervisor/upgrades', 'supervisor/upgrades/index.html'] };
      for (const [page, [pathname, file]] of Object.entries(pages)) {
        const { html } = renderRoute(view, { page }, { query: new URLSearchParams(page === 'ticks' ? `ticks.q=ENOENT&ticks.open=${Date.parse('2026-10-31T12:00:02Z')}` : ''), pathname });
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); fs.writeFileSync(path.join(dir, file), html.replace('<meta http-equiv="refresh" content="60">', ''));
      }
      const ui = path.join(sourceProject, 'supervisor', 'dashui');
      fs.mkdirSync(path.join(dir, 'static'));
      fs.copyFileSync(path.join(ui, 'style.css'), path.join(dir, 'static', 'style.css'));
      fs.copyFileSync(path.join(ui, 'logic.mjs'), path.join(dir, 'static', 'logic.js'));
      fs.writeFileSync(path.join(dir, 'static', 'app.js'), fs.readFileSync(path.join(ui, 'app.js'), 'utf8').replace("from './logic.mjs'", "from './logic.js'"));
      for (const d of fs.readdirSync(dir, { recursive: true })) { const f = path.join(dir, d); fs.chmodSync(f, fs.statSync(f).isDirectory() ? 0o755 : 0o644); }
      fs.chmodSync(dir, 0o755);
      return view;
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function run(name, spec, site) {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: site ? ['fixture'] : [] }, config);
  const server = site ? await listenOnSocket(createStaticServer(site), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const result = await runContainer(plan, { keepVolume: true });
    console.log(JSON.stringify({ run: name, runId, exitCode: result.exitCode, subjectExit: result.subjectExit, cleanup: result.cleanup }));
    const out = {};
    for (const f of fs.existsSync(plan.out) ? fs.readdirSync(plan.out) : []) { if (/\.(json|md|png)$/.test(f)) { fs.mkdirSync(evidence, { recursive: true, mode: 0o700 }); fs.copyFileSync(path.join(plan.out, f), path.join(evidence, f)); out[f] = true; } }
    return { result, files: Object.keys(out) };
  } finally { await server?.close(); releaseVolumes(plan); }
}

const site = path.join(storageRoot, 'site');
try {
  fs.mkdirSync(site, { recursive: true, mode: 0o755 }); fs.chmodSync(storageRoot, 0o711);
  const view = await fixtureSite(site);
  check('fixture renders all five health cards with the expected colours', view.supervisor.cards.map(c => `${c.id}:${c.severity}`).join(',') === 'version:warning,tick:ok,leases:action,errors:warning,drift:warning',
    { cards: view.supervisor.cards.map(c => `${c.id}:${c.severity}`) });
  const pkg = lock.packages['playwright-core'];
  const restore = await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] }, null);
  check('restore', restore.result.subjectExit === 0);
  for (const [name, p] of [['supervisor', '/supervisor/'], ['ticks', '/supervisor/ticks/'], ['upgrades', '/supervisor/upgrades/'], ['overview', '/']]) {
    const r = await run(name, { phase: 'test', command: ['node', '/src/browser/responsive.mjs', '--target', 'fixture', '--path', p, '--name', name, '--profiles', 'standard'] }, site);
    let summary = null; try { summary = JSON.parse(fs.readFileSync(path.join(evidence, `${name}.summary.json`), 'utf8')); } catch { /* reported below */ }
    check(`${name}: layout audit passes at every standard width`, r.result.subjectExit === 0 && summary?.ok === true,
      { subjectExit: r.result.subjectExit, failures: summary?.failures?.slice(0, 12), warnings: summary?.warnings?.length ?? null, blocked: summary?.blockedRequests?.length ?? null });
  }
  console.log(JSON.stringify({ evidence }));
} catch (error) { console.error(`supervisor-page-smoke: ${error.name}: ${error.message}`); failed = true; }
finally { fs.rmSync(storageRoot, { recursive: true, force: true }); stage.cleanup(); }
console.log(failed ? 'SUPERVISOR PAGE SMOKE FAILED' : 'SUPERVISOR PAGE SMOKE OK');
process.exitCode = failed ? 1 : 0;
