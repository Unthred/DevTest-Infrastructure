#!/usr/bin/env node
// Tower-only visual evidence for the "dashboard unreachable" page (issue #432). Captures the first message and the 5-minute message at
// desktop and phone width in the pinned Chromium container. The 5-minute variant is the same file with the wait shortened to 0 so the
// text switches on its first one-second tick; the polling start is pushed out so no request is made while capturing.
// Usage: node tests/unreachable-visual.mjs <screenshot-dir>   (run `node browser/prepare-cache.mjs` first)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';

const sourceProject = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) { console.error('usage: node tests/unreachable-visual.mjs <screenshot-dir>'); process.exit(2); }
const outDir = path.resolve(process.argv[2]);
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/vis432', crypto.randomBytes(6).toString('hex'));
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(sourceProject, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const page = fs.readFileSync(path.join(sourceProject, 'supervisor', 'dashui', 'unreachable.html'), 'utf8');
const site = fs.mkdtempSync('/mnt/cache/appdata/devtest-infrastructure/vis432-');
fs.writeFileSync(path.join(site, 'first.html'), page.replace('EVERY_MS = 4000', 'EVERY_MS = 3600000'));
fs.writeFileSync(path.join(site, 'long.html'), page.replace('EVERY_MS = 4000', 'EVERY_MS = 3600000').replace('LONG_MS = 5 * 60 * 1000', 'LONG_MS = 0').replace('setInterval(tick, 1000)', 'tick()'));
fs.chmodSync(site, 0o755); for (const f of fs.readdirSync(site)) fs.chmodSync(path.join(site, f), 0o644);
const failures = [];
const run = async (name, spec, dir) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: dir ? ['fixture'] : [] }, cfg);
  const server = dir ? await listenOnSocket(createStaticServer(dir), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true });
    console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup }));
    if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (dir) for (const f of fs.readdirSync(plan.out)) if (f.endsWith('.png')) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await server?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true });
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1440', 'phone-390']) for (const name of ['first', 'long'])
    await run(`${name}-${profile}`, { phase: 'test', command: ['node', '/src/browser/capture.mjs', '--target', 'fixture', '--path', `/${name}.html`, '--profile', profile, '--name', `${name}-${profile}`, '--wait', 'networkidle', '--full-page'] }, site);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(site, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`VISUAL CAPTURE FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('VISUAL CAPTURE OK');
