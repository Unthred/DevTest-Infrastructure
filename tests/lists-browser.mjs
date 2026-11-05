#!/usr/bin/env node
// Tower-only browser check for the shared Overview lists, in the pinned Chromium container (same path as tests/dashboard-visual.mjs).
// Renders the Overview with 50 / 5 / 0 Needs you rows from the test fixture (fake data, no supervisor state), stages the real static files,
// and runs browser/lists-scenario.mjs at a laptop and a phone width. Results (JSON, one screenshot) go to the directory in argv[2].
// LISTS_SRC=<dir> renders from another checkout (to measure the page height before a change) and only records heights.
// Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.resolve(process.env.LISTS_SRC || here), headsOnly = !!process.env.LISTS_SRC, outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: [LISTS_SRC=<checkout>] node tests/lists-browser.mjs <output-dir>'); process.exit(2); }
const { overviewView } = await import(pathToFileURL(path.join(here, 'tests/helpers/lists-fixture.mjs')).href);
const { renderRoute } = await import(pathToFileURL(path.join(src, 'supervisor/dashrender.mjs')).href);
const rest = { warnings: 12, later: 8, next: 7, watching: 3, since: 6 };
const views = { many: await overviewView({ needs: 50, ...rest }), few: await overviewView({ needs: 5, ...rest }), empty: await overviewView({}) };
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/lists', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const site = fs.mkdtempSync('/mnt/cache/appdata/devtest-infrastructure/lists-site-');
fs.mkdirSync(path.join(site, 'static'), { recursive: true });
for (const f of fs.readdirSync(path.join(src, 'supervisor/dashui'))) if (/\.(m?js|css)$/.test(f)) fs.copyFileSync(path.join(src, 'supervisor/dashui', f), path.join(site, 'static', f));
for (const [k, v] of Object.entries(views)) fs.writeFileSync(path.join(site, `${k}.html`), renderRoute(v, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html.replace(/<meta http-equiv="refresh"[^>]*>/, ''));
fs.chmodSync(site, 0o755); fs.chmodSync(path.join(site, 'static'), 0o755); for (const f of fs.readdirSync(site, { recursive: true })) { const p = path.join(site, f); fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o755 : 0o644); }
const failures = [];
const run = async (name, spec, dir) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: dir ? ['fixture'] : [] }, cfg);
  const server = dir ? await listenOnSocket(createStaticServer(dir), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup }));
    if (!headsOnly && (r.subjectExit !== 0 || r.cleanup !== 'complete')) failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (dir) for (const f of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await server?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true });
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390'])
    await run(profile, { phase: 'test', command: ['node', '/src/browser/lists-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `${headsOnly ? 'before' : 'after'}-${profile}`, ...(headsOnly ? ['--heights-only', '1'] : [])] }, site);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(site, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`LISTS BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('LISTS BROWSER CHECK DONE');
