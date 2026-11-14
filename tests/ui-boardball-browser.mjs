#!/usr/bin/env node
// Tower-only browser check for what a ball and a lane look like on the live board screen (issue #1317), in the pinned Chromium container
// (same path as tests/ui-boardstyles-browser.mjs). Serves the REAL dashboard request handler and the real router on the target socket, with
// the fixture liveboard model of tests/ui-boardmotion-fixture.mjs plus an icon route for claude only: the real route reads a made up star
// from the state folder (codex has none). The scenario asks for /__fixture/<step>, /__fixture/icons/fail (the icon route answers 500 and counts
// no file) and /__fixture/icons/ok, and reads /__fixture/icons/count (how many times the icon was asked for). Runs
// browser/ui-boardball-scenario.mjs at desktop 1280 and phone 390; the scenario itself does light and dark. Results go to argv[2].
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
import { motionFixture } from './ui-boardmotion-fixture.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/ui-boardball-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const base = '/mnt/cache/appdata/devtest-infrastructure';
const storageRoot = path.join(base, 'ui-boardball', crypto.randomBytes(6).toString('hex'));
const stateRoot = fs.mkdtempSync(path.join(base, 'ui-boardball-state-'));
const apiDir = path.join(stateRoot, 'api');
const fixtureFile = path.join(stateRoot, 'liveboard-fixture.json');
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
// A made up five point star: one colour on a transparent background, as the contract asks of an icon.
const STAR = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M12 1.5l3.1 7.2 7.8.7-5.9 5.2 1.8 7.6L12 18l-6.8 4.2 1.8-7.6L1.1 9.4l7.8-.7z"/></svg>';

const model = step => {
  const board = motionFixture(Date.now(), step);
  board.agents = board.agents.map(agent => ({ ...agent, icon: agent.id === 'claude' ? '/api/v1/agent-icon/claude' : null }));
  return board;
};

function makeApiDir() {
  const real = path.join(here, 'supervisor/api');
  for (const dir of ['models', 'routes', 'schemas']) fs.mkdirSync(path.join(apiDir, dir), { recursive: true });
  for (const dir of ['routes', 'schemas']) {
    for (const file of fs.readdirSync(path.join(real, dir))) fs.symlinkSync(path.join(real, dir, file), path.join(apiDir, dir, file));
  }
  for (const name of ['meta', 'appbar']) fs.symlinkSync(path.join(real, `models/${name}.mjs`), path.join(apiDir, `models/${name}.mjs`));
  fs.writeFileSync(path.join(apiDir, 'models/liveboard.mjs'), [
    "import fs from 'node:fs';",
    "export const name = 'liveboard';", "export const path = 'liveboard';", "export const schema = 'liveboard.schema.json';", 'export const usesView = false;',
    `export const build = () => JSON.parse(fs.readFileSync(${JSON.stringify(fixtureFile)}, 'utf8'));`, '',
  ].join('\n'));
}
function seedState() {
  for (const d of ['jobs', 'dashboard', 'team', 'agent-icons']) fs.mkdirSync(path.join(stateRoot, d), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(stateRoot, 'agent-icons', 'claude.svg'), STAR);
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

const STEPS = new Set(['base', 'start']);
let iconFails = false, iconAsked = 0;
function fixtureServer(dashboard) {
  return http.createServer((req, res) => {
    req.headers.host = '127.0.0.1:8731';
    if (req.url.startsWith('/__fixture/icons/')) {
      const what = req.url.slice('/__fixture/icons/'.length);
      if (what === 'fail') iconFails = true;
      if (what === 'ok') { iconFails = false; iconAsked = 0; }
      res.writeHead(200).end(what === 'count' ? String(iconAsked) : 'ok');
      return;
    }
    if (req.url.startsWith('/api/v1/agent-icon/')) {
      iconAsked += 1;
      if (iconFails) { res.writeHead(500).end('down'); return; }
    }
    const step = req.url.startsWith('/__fixture/') ? req.url.slice('/__fixture/'.length) : null;
    if (step !== null) {
      if (!STEPS.has(step)) { res.writeHead(404).end('no such step'); return; }
      fs.writeFileSync(fixtureFile, JSON.stringify(model(step)));
      append(stateRoot, { type: 'model_changed', models: ['liveboard'] });
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
    iconFails = false; iconAsked = 0;
    fs.writeFileSync(fixtureFile, JSON.stringify(model('base')));
    const dashboard = handler({ wake: () => {}, root: stateRoot, config, host: '127.0.0.1', port: 8731 });
    await run(profile, { phase: 'test', command: ['node', '/src/browser/ui-boardball-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `ui-boardball-${profile}`] }, fixtureServer(dashboard));
  }
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`UI BOARDBALL BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('UI BOARDBALL BROWSER CHECK DONE');
