#!/usr/bin/env node
// Tower-only browser check of the Overview summary cards (issue #1453), in the pinned Chromium container (same path as tests/jobs-browser.mjs).
// Serves the REAL dashboard request handler (supervisor/dashserver.mjs) on the target socket over a throwaway state whose cache, verdicts, jobs
// and history timeline file (tests/helpers/headline-cards-fixture.mjs) make the real headline view produce the real example: First review
// approval 41.2% against 34.1% and Rejects 84 against 92 at 14 Nov 2026 12:18 UTC. browser/headline-cards-scenario.mjs then runs at desktop 1280
// and phone 390, clicks the real period control and checks the page after the click, a refresh in place and a reload. Results (JSON, screenshots)
// go to the directory in argv[2]. Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { listenOnSocket } from '../browser/static-server.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { NOW, config, seedState } from './helpers/headline-cards-fixture.mjs';
import { stageProject } from './stage-project.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/headline-cards-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const base = '/mnt/cache/appdata/devtest-infrastructure';
const storageRoot = path.join(base, 'hlcards', crypto.randomBytes(6).toString('hex'));
const stateRoot = fs.mkdtempSync(path.join(base, 'hlcards-state-'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };

const failures = [];
const run = async (name, spec, server) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: server ? ['fixture'] : [] }, cfg);
  const listening = server ? await listenOnSocket(server, targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup }));
    if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (server) for (const f of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await listening?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true }); seedState(stateRoot);
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390']) {
    const dashboard = handler({ wake: () => {}, root: stateRoot, config: config(), host: '127.0.0.1', port: 8731, now: () => NOW });
    // The browser reaches the socket through a bridge on a port chosen inside the container, so the Host it sends is rewritten to the one the handler serves.
    const server = http.createServer((req, res) => { req.headers.host = '127.0.0.1:8731'; return dashboard(req, res); });
    await run(profile, { phase: 'test', command: ['node', '/src/browser/headline-cards-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `headline-cards-${profile}`] }, server);
  }
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`HEADLINE CARDS BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('HEADLINE CARDS BROWSER CHECK DONE');
