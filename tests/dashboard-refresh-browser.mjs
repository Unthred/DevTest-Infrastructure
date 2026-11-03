#!/usr/bin/env node
// Tower-only browser gate (issue #431): a periodic refresh must not reload, move or blank the dashboard. Renders the real overview and
// work pages from a COPY of the supervisor state, serves them with the real static files and a 1-second refresh, and runs
// browser/refresh-shift.mjs in the pinned Chromium container. Fails above MAX_SHIFT_PX, on a document reload, a collapsed expanded
// card, a moved scroll position, or a saved layout not applied at the first animation frame. Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';
import { currentView } from '../supervisor/dashserver.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';

const sourceProject = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stateRoot = process.env.DASH_STATE_COPY, outDir = path.resolve(process.argv[2] || '');
if (!stateRoot || !process.argv[2]) { console.error('usage: DASH_STATE_COPY=<copy of supervisor state> node tests/dashboard-refresh-browser.mjs <out-dir>'); process.exit(2); }
const config = JSON.parse(fs.readFileSync(path.join(sourceProject, 'supervisor', 'team.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/vis431', crypto.randomBytes(6).toString('hex'));
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(sourceProject, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const view = await currentView({ root: stateRoot, config });
const prs = (view.pulls || view.prs || []).map(p => p.number);
const pages = [['overview', '/'], ['work', '/work']];
const site = fs.mkdtempSync(path.join('/mnt/cache/appdata/devtest-infrastructure/vis431-', ''));
const { matchRoute } = await import('../supervisor/dashrender.mjs');
const dir = path.join(site, 'site'); fs.mkdirSync(path.join(dir, 'static'), { recursive: true });
for (const f of ['style.css', 'app.js', 'logic.mjs', 'legend.mjs', 'early.js', 'layout-early.js']) fs.copyFileSync(path.join(sourceProject, 'supervisor', 'dashui', f), path.join(dir, 'static', f));
for (const [name, p] of pages) fs.writeFileSync(path.join(dir, `${name}.html`), renderRoute(view, matchRoute(p), { pathname: p }).html.replace(/<meta name="refresh-seconds" content="\d+">/, '<meta name="refresh-seconds" content="1">'));
fs.chmodSync(site, 0o755); fs.chmodSync(dir, 0o755);
const failures = [];
const run = async (name, spec, serve) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: serve ? ['fixture'] : [] }, cfg);
  const server = serve ? await listenOnSocket(createStaticServer(dir), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try { const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup })); if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`); }
  finally { await server?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true });
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const [name] of pages) await run(`refresh-${name}`, { phase: 'test', command: ['node', '/src/browser/refresh-shift.mjs', '--target', 'fixture', '--path', `/${name}.html`] }, true);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(site, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`REFRESH GATE FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('REFRESH GATE OK');
