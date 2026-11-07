#!/usr/bin/env node
// Tower-only browser check for the refresh in place (issue #930), in the pinned Chromium container (same path as tests/lists-browser.mjs).
// Renders the Overview twice from the test fixture (fake data, no supervisor state): /a.html, and /b.html with one more Needs you row and
// changed values in a plain card; the real static files are staged and browser/refresh-scenario.mjs scrolls, searches, types and opens
// things, then triggers several refreshes with changed data and asserts nothing moved, closed or cleared and the new values showed.
// Results (JSON, one screenshot) go to the directory in argv[2]. Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/refresh-browser.mjs <output-dir>'); process.exit(2); }
const { overviewView } = await import(pathToFileURL(path.join(here, 'tests/helpers/lists-fixture.mjs')).href);
const { renderRoute } = await import(pathToFileURL(path.join(here, 'supervisor/dashrender.mjs')).href);
const rest = { warnings: 12, later: 8, next: 7, watching: 3, since: 6 };
const page = v => renderRoute(v, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
// A plain card (not a list) with a nested scroller, a details, a text field and a value that changes between versions.
const plain = value => `<div class="x-scroll" style="height:60px;overflow:auto"><div style="height:400px">scroller</div></div><details class="x-d"><summary>More</summary><p>detail</p></details><input class="x-q" type="search" aria-label="Test field"><p class="x-val">${value}</p>`;
const inject = (html, value) => { const i = html.indexOf('data-card="c-jobs"'), j = html.indexOf('</section>', i); if (i < 0 || j < 0) throw new Error('c-jobs card not found'); return html.slice(0, j) + plain(value) + html.slice(j); };
const fast = html => html.replace('<meta name="refresh-seconds" content="60">', '<meta name="refresh-seconds" content="3">');
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/refresh', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const site = fs.mkdtempSync('/mnt/cache/appdata/devtest-infrastructure/refresh-site-');
fs.mkdirSync(path.join(site, 'static'), { recursive: true });
for (const f of fs.readdirSync(path.join(here, 'supervisor/dashui'))) if (/\.(m?js|css)$/.test(f)) fs.copyFileSync(path.join(here, 'supervisor/dashui', f), path.join(site, 'static', f));
fs.writeFileSync(path.join(site, 'a.html'), fast(inject(page(await overviewView({ needs: 50, ...rest })), 'VALUE-A')));
fs.writeFileSync(path.join(site, 'b.html'), fast(inject(page(await overviewView({ needs: 51, ...rest })), 'VALUE-B')));
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
  for (const profile of ['desktop-1280', 'phone-390'])
    await run(profile, { phase: 'test', command: ['node', '/src/browser/refresh-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `refresh-${profile}`] }, site);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(site, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`REFRESH BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('REFRESH BROWSER CHECK DONE');
