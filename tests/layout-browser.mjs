#!/usr/bin/env node
// Tower-only browser check for the dashboard layout editor, in the pinned Chromium container (same path as tests/lists-browser.mjs).
// Renders Overview, Usage, Reviews and Agents from the test fixture (fake data, no supervisor state), stages the real static files and
// runs browser/layout-scenario.mjs at a desktop and a tablet width. Results (JSON, screenshots) go to the directory in argv[2].
// Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/layout-browser.mjs <output-dir>'); process.exit(2); }
const { overviewView } = await import(pathToFileURL(path.join(here, 'tests/helpers/lists-fixture.mjs')).href);
const { renderRoute } = await import(pathToFileURL(path.join(here, 'supervisor/dashrender.mjs')).href);
const view = await overviewView({ needs: 6, warnings: 4, later: 3, next: 3, watching: 2, since: 4 });
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/layout', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 420000, diskMb: 256, cacheMb: 64 } };
const site = fs.mkdtempSync('/mnt/cache/appdata/devtest-infrastructure/layout-site-');
fs.mkdirSync(path.join(site, 'static'), { recursive: true });
for (const f of fs.readdirSync(path.join(here, 'supervisor/dashui'))) if (/\.(m?js|css)$/.test(f)) fs.copyFileSync(path.join(here, 'supervisor/dashui', f), path.join(site, 'static', f));
const page = (route, pathname, secs) => renderRoute(view, route, { query: new URLSearchParams(), pathname }).html.replace(/<noscript><meta http-equiv="refresh"[^>]*><\/noscript>/, '').replace(/(<meta name="refresh-seconds" content=")\d+/, `$1${secs}`);
for (const p of ['overview', 'usage', 'reviews', 'agents']) fs.writeFileSync(path.join(site, `${p}.html`), page({ page: p }, p === 'overview' ? '/' : `/${p}`, 3600));
fs.writeFileSync(path.join(site, 'overview-fast.html'), page({ page: 'overview' }, '/', 2));
fs.chmodSync(site, 0o755); fs.chmodSync(path.join(site, 'static'), 0o755); for (const f of fs.readdirSync(site, { recursive: true })) { const p = path.join(site, f); fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o755 : 0o644); }
const failures = [];
const run = async (name, spec, dir) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: dir ? ['fixture'] : [] }, cfg);
  const server = dir ? await listenOnSocket(createStaticServer(dir), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup }));
    if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (dir) for (const f of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await server?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true });
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'tablet-768'])
    await run(profile, { phase: 'test', command: ['node', '/src/browser/layout-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `layout-${profile}`] }, site);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(site, { recursive: true, force: true }); stage.cleanup(); }
for (const f of fs.readdirSync(outDir).filter(f => /^layout-.*\.json$/.test(f))) { const r = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8')); console.log(`${f}: ${r.checks.filter(c => c.ok).length}/${r.checks.length} checks passed`); for (const c of r.failed) { failures.push(`${f}: ${c.name} (${c.detail})`); } }
if (failures.length) { console.error(`LAYOUT BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('LAYOUT BROWSER CHECK PASSED');
