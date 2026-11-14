#!/usr/bin/env node
// Tower-only browser check for the live board screen (issue #1312), in the pinned Chromium container (same path as tests/ui-appbar-browser.mjs).
// Serves the REAL dashboard request handler and the real router on the target socket. The contract folder is a temporary one: the real routes,
// schemas, meta model and app bar model (symbolic links) and a fixture model named liveboard that returns the data below from a file this test
// rewrites between requests. Runs browser/ui-board-scenario.mjs at desktop 1280 and phone 390. Results go to argv[2].
// Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { listenOnSocket } from '../browser/static-server.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { append } from '../supervisor/api/routes/events.mjs';
import { stageProject } from './stage-project.mjs';
import { boardFixture } from './ui-board-fixture.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/ui-board-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const base = '/mnt/cache/appdata/devtest-infrastructure';
const storageRoot = path.join(base, 'ui-board', crypto.randomBytes(6).toString('hex'));
const stateRoot = fs.mkdtempSync(path.join(base, 'ui-board-state-'));
const apiDir = path.join(stateRoot, 'api');
const fixtureFile = path.join(stateRoot, 'liveboard-fixture.json');
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };

// routes/ and schemas/ link to the real files; models/ links the real meta and app bar models and holds the fixture liveboard model.
function makeApiDir() {
  const real = path.join(here, 'supervisor/api');
  for (const dir of ['models', 'routes', 'schemas']) fs.mkdirSync(path.join(apiDir, dir), { recursive: true });
  for (const dir of ['routes', 'schemas']) {
    for (const file of fs.readdirSync(path.join(real, dir))) fs.symlinkSync(path.join(real, dir, file), path.join(apiDir, dir, file));
  }
  for (const model of ['meta', 'appbar']) fs.symlinkSync(path.join(real, `models/${model}.mjs`), path.join(apiDir, `models/${model}.mjs`));
  fs.writeFileSync(path.join(apiDir, 'models/liveboard.mjs'), [
    "import fs from 'node:fs';",
    "export const name = 'liveboard';", "export const path = 'liveboard';", "export const schema = 'liveboard.schema.json';", 'export const usesView = false;',
    `export const build = () => JSON.parse(fs.readFileSync(${JSON.stringify(fixtureFile)}, 'utf8'));`, '',
  ].join('\n'));
}
function seedState() {
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(stateRoot, d), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(stateRoot, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  fs.writeFileSync(path.join(stateRoot, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls: [], issues: [], delivered: [] }));
  makeApiDir();
}

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

// The scenario asks for /__fixture/start (a waiting item starts running and the change event is sent), /__fixture/fail and /__fixture/recover.
function fixtureServer(dashboard, flags) {
  return http.createServer((req, res) => {
    req.headers.host = '127.0.0.1:8731';
    const step = req.url.startsWith('/__fixture/') ? req.url.slice('/__fixture/'.length) : null;
    if (step === 'start') {
      fs.writeFileSync(fixtureFile, JSON.stringify(boardFixture(Date.now(), 'started')));
      append(stateRoot, { type: 'model_changed', models: ['liveboard'] });
    } else if (step === 'fail' || step === 'recover') {
      flags.failing = step === 'fail';
      if (flags.failing) append(stateRoot, { type: 'model_changed', models: ['liveboard'] });
    }
    if (step) { res.writeHead(200).end('ok'); return; }
    if (flags.failing && req.url.startsWith('/api/v1/liveboard')) { res.writeHead(503, { 'content-type': 'application/json' }).end('{"error":"fixture failure"}'); return; }
    return dashboard(req, res);
  });
}
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true }); seedState();
  process.env.DEVTEST_API_DIR = apiDir;
  process.env.DEVTEST_EVENTS_POLL_MS = '100';
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390']) {
    fs.writeFileSync(fixtureFile, JSON.stringify(boardFixture(Date.now(), 'first')));
    const dashboard = handler({ wake: () => {}, root: stateRoot, config, host: '127.0.0.1', port: 8731 });
    await run(profile, { phase: 'test', command: ['node', '/src/browser/ui-board-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `ui-board-${profile}`] }, fixtureServer(dashboard, { failing: false }));
  }
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`UI BOARD BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('UI BOARD BROWSER CHECK DONE');
