#!/usr/bin/env node
// Tower-only browser check for the Jobs table (issue #1220), in the pinned Chromium container (same path as tests/lists-browser.mjs).
// Serves the REAL dashboard request handler (supervisor/dashserver.mjs) on the target socket over a throwaway state holding the two real
// job records of PR #1180 (the blocked rebase 60b46719 and its review 91896f66, tests/fixtures/jobs-table/) and two made-up jobs, and runs
// browser/jobs-scenario.mjs at desktop 1280 and phone 390 on the real Work page. Results (JSON, screenshots) go to the directory in argv[2].
// Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { listenOnSocket } from '../browser/static-server.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { NOW, config as fixtureConfig, jobRecords, stateRecords } from './helpers/jobs-fixture.mjs';
import { stageProject } from './stage-project.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/jobs-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const base = '/mnt/cache/appdata/devtest-infrastructure';
const storageRoot = path.join(base, 'jobs', crypto.randomBytes(6).toString('hex'));
const stateRoot = fs.mkdtempSync(path.join(base, 'jobs-state-'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const config = fixtureConfig();

// The job records, the dispatcher state with the failure record, and a fresh dashboard cache, written where the dashboard reads them.
function seedState() {
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(stateRoot, d), { recursive: true });
  for (const j of jobRecords()) fs.writeFileSync(path.join(stateRoot, 'jobs', `${j.id}.json`), JSON.stringify(j));
  fs.writeFileSync(path.join(stateRoot, 'team', 'state.json'), JSON.stringify(stateRecords()));
  const at = NOW - 60000;
  fs.writeFileSync(path.join(stateRoot, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at, status: 'ok', lastOkAt: at }, fetchedAt: at, pulls: [], issues: [{ number: 30, title: 'Thirty', state: 'OPEN', labels: [] }] }));
}

const BUMP_ID = 'b1'.repeat(16);
function addRunningJob() {
  const job = { id: BUMP_ID, provider: 'claude', kind: 'implement', issue: 30, branch: 'claude/issue-30-y', status: 'running', createdAt: NOW - 120000, updatedAt: NOW - 60000, attempts: 1, role: 'devtest', model: 'sonnet', effort: 'low' };
  fs.writeFileSync(path.join(stateRoot, 'jobs', `${job.id}.json`), JSON.stringify(job));
}

const failures = [];
const run = async (name, spec, server) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: server ? ['fixture'] : [] }, cfg);
  const listening = server ? await listenOnSocket(server, targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup })); if (r.subjectExit && process.env.JOBS_BROWSER_DEBUG) console.log(fs.existsSync(plan.out) ? fs.readdirSync(plan.out) : "no out", JSON.stringify(r).slice(0, 1500));
    if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (server) for (const f of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await listening?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true }); seedState();
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390']) {
    fs.rmSync(path.join(stateRoot, 'jobs', `${BUMP_ID}.json`), { force: true });   // each profile starts from the same records
    const dashboard = handler({ wake: () => {}, root: stateRoot, config, host: '127.0.0.1', port: 8731, now: () => NOW });
    // The browser reaches the socket through a bridge on a port chosen inside the container, so the Host it sends is rewritten to the one the handler serves.
    // /__bump is the test's own hook: it adds one running job, so the Jobs card changes and the page's refresh in place has something to swap.
    const server = http.createServer((req, res) => {
      if (req.url === '/__bump') { addRunningJob(); res.end('ok'); return; }
      req.headers.host = '127.0.0.1:8731';
      return dashboard(req, res);
    });
    await run(profile, { phase: 'test', command: ['node', '/src/browser/jobs-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `jobs-${profile}`] }, server);
  }
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`JOBS BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('JOBS BROWSER CHECK DONE');
