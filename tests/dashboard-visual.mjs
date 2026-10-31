#!/usr/bin/env node
// Tower-only visual-evidence gate for the dashboard (issue #58). Renders the real pages and the real static files from a COPY of the
// supervisor state into a static directory (data-theme set per theme), then captures them in the pinned Chromium container at
// desktop, tablet and phone sizes, light and dark. Screenshots go to the directory given as argv[2] (not committed).
// Run `node browser/prepare-cache.mjs` first. A person must still look at the images; this script only produces them.
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
if (!stateRoot || !process.argv[2]) { console.error('usage: DASH_STATE_COPY=<copy of supervisor state> node tests/dashboard-visual.mjs <screenshot-dir>'); process.exit(2); }
const config = JSON.parse(fs.readFileSync(path.join(sourceProject, 'supervisor', 'team.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/vis58', crypto.randomBytes(6).toString('hex'));
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(sourceProject, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const view = await currentView({ root: stateRoot, config });
const prs = (view.pulls || view.prs || []).map(p => p.number);
const pages = [['overview', '/'], ['work', '/work'], ['system', '/system'], ...(prs[0] ? [['pr', `/work/pr/${prs[0]}`]] : [])];
const site = fs.mkdtempSync(path.join('/mnt/cache/appdata/devtest-infrastructure/vis58-', ''));
const { matchRoute } = await import('../supervisor/dashrender.mjs');
for (const theme of ['light', 'dark']) {
  const dir = path.join(site, theme); fs.mkdirSync(path.join(dir, 'static'), { recursive: true });
  for (const f of ['style.css', 'app.js', 'logic.mjs', 'early.js']) fs.copyFileSync(path.join(sourceProject, 'supervisor', 'dashui', f), path.join(dir, 'static', f));
  for (const [name, p] of pages) fs.writeFileSync(path.join(dir, `${name}.html`), renderRoute(view, matchRoute(p), { pathname: p }).html.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`).replace(/<meta http-equiv="refresh"[^>]*>/, ''));
}
fs.chmodSync(site, 0o755); for (const t of ['light', 'dark']) fs.chmodSync(path.join(site, t), 0o755);
const failures = [];
const run = async (name, spec, dir) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: dir ? ['fixture'] : [] }, cfg);
  const server = dir ? await listenOnSocket(createStaticServer(dir), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try { const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup })); if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`); if (dir) for (const f of fs.readdirSync(plan.out)) if (f.endsWith('.png')) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f)); return r; }
  finally { await server?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true });
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const theme of ['light', 'dark']) for (const profile of ['desktop-1440', 'tablet-768', 'phone-390']) for (const [name] of pages)
    await run(`${theme}-${profile}-${name}`, { phase: 'test', command: ['node', '/src/browser/capture.mjs', '--target', 'fixture', '--path', `/${name}.html`, '--profile', profile, '--name', `${theme}-${name}`, '--wait', 'networkidle', '--full-page'] }, path.join(site, theme));
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(site, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`VISUAL CAPTURE FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('VISUAL CAPTURE OK');
