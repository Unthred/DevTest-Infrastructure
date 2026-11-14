#!/usr/bin/env node
// Tower-only browser check for the board styles and the switch on the live board screen (issue #1315), in the pinned Chromium container
// (same path as tests/ui-boardmotion-browser.mjs). Serves the REAL dashboard request handler and the real router on the target socket, with a
// fixture liveboard model (tests/ui-boardmotion-fixture.mjs). The second style is a fixture module (tests/boardstyle-marble-fixture.mjs) that
// this test serves as /api/v1/ui/boardstyle-marble.mjs only while the scenario has asked for it, so the real UI folder is not changed.
// Runs browser/ui-boardstyles-scenario.mjs at desktop 1280 and phone 390. Results go to argv[2]. Run `node browser/prepare-cache.mjs` first.
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
import { motionFixture } from './ui-boardmotion-fixture.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/ui-boardstyles-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const base = '/mnt/cache/appdata/devtest-infrastructure';
const storageRoot = path.join(base, 'ui-boardstyles', crypto.randomBytes(6).toString('hex'));
const stateRoot = fs.mkdtempSync(path.join(base, 'ui-boardstyles-state-'));
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

// The scenario asks for /__fixture/<step> (the model changes and the change event is sent) and /__fixture/styles/on or off (the second style is served or not).
const STEPS = new Set(['base', 'start']);
const STYLE_URL = '/api/v1/ui/boardstyle-marble.mjs';
let marbleServed = false;
function fixtureServer(dashboard) {
  return http.createServer((req, res) => {
    req.headers.host = '127.0.0.1:8731';
    const quiet = req.url.startsWith('/__fixture/quiet/');
    const step = req.url.startsWith('/__fixture/') ? req.url.slice(quiet ? '/__fixture/quiet/'.length : '/__fixture/'.length) : null;
    if (req.url.startsWith('/__fixture/styles/')) {
      marbleServed = req.url.endsWith('/on');
      res.writeHead(200).end('ok');
      return;
    }
    if (marbleServed && req.url.split('?')[0] === STYLE_URL) {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(fs.readFileSync(path.join(here, 'tests/boardstyle-marble-fixture.mjs')));
      return;
    }
    if (step !== null) {
      if (!STEPS.has(step)) { res.writeHead(404).end('no such step'); return; }
      fs.writeFileSync(fixtureFile, JSON.stringify(motionFixture(Date.now(), step)));
      if (!quiet) append(stateRoot, { type: 'model_changed', models: ['liveboard'] });
      res.writeHead(200).end('ok');
      return;
    }
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
    fs.writeFileSync(fixtureFile, JSON.stringify(motionFixture(Date.now(), 'base')));
    const dashboard = handler({ wake: () => {}, root: stateRoot, config, host: '127.0.0.1', port: 8731 });
    await run(profile, { phase: 'test', command: ['node', '/src/browser/ui-boardstyles-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `ui-boardstyles-${profile}`] }, fixtureServer(dashboard));
  }
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`UI BOARDSTYLES BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('UI BOARDSTYLES BROWSER CHECK DONE');
