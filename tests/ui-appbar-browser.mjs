#!/usr/bin/env node
// Tower-only browser check for the web shell and its app bar (issue #1266), in the pinned Chromium container (same path as tests/inbox-filter-browser.mjs).
// Serves the REAL dashboard request handler (supervisor/dashserver.mjs) and the real router on the target socket. The contract folder is a temporary one:
// the real routes and schemas and the real meta model (symbolic links, so their imports resolve), and a fixture model named appbar that returns
// the data below from a file this test rewrites. Runs browser/ui-appbar-scenario.mjs at desktop 1280 and phone 390. Results go to argv[2].
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

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/ui-appbar-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const base = '/mnt/cache/appdata/devtest-infrastructure';
const storageRoot = path.join(base, 'ui-appbar', crypto.randomBytes(6).toString('hex'));
const stateRoot = fs.mkdtempSync(path.join(base, 'ui-appbar-state-'));
const apiDir = path.join(stateRoot, 'api');
const fixtureFile = path.join(stateRoot, 'appbar-fixture.json');
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };

// The real data of 12 Nov: system stalled with attention fault; the first agent idle, weekly 0.14, 5 hour 0.01, a reading 360 seconds old;
// the second paused with weekly 0.31 and an unknown 5 hour window, a reading 32,520 seconds old and stale; slots 0 of 4.
const condition = (state, attention, code, text, since) => ({ state, attention, reason_code: code, reason_text: text, since });
const known = (fraction, resetsAt, seconds) => ({ state: 'known', used_fraction: fraction, level: 'normal', resets_at: resetsAt, window_seconds: seconds, reason_code: null, reason_text: null });
const fixtureData = weekly => ({
  system: condition('stalled', 'fault', 'idle_with_planned_work', 'All 4 slots are idle and 4 planned actions are held. Nothing has started for 3 hours 23 minutes.', '2026-11-12T18:41:00Z'),
  counts: { needs_you: 6, faults: 4, stalled_agents: 2, planned_held: 4, running_jobs: 0, inbox_waiting: 12 },
  slots: { max: 4, in_use: 0 },
  tick: { state: 'scheduled', last_at: '2026-11-12T22:00:07Z', next_at: '2026-11-12T22:05:00Z', interval_seconds: 300 },
  agents: [
    { id: 'claude', display_name: 'claude', provider: 'claude', roles: ['implementer', 'reviewer', 'rebaser'],
      condition: condition('idle', 'fault', 'unrecorded', 'Idle with 2 planned actions held.', '2026-11-12T18:41:00Z'),
      weekly: known(weekly, '2026-11-19T04:00:00Z', 604800), short: known(0.01, '2026-11-13T02:10:00Z', 18000),
      reading: { read_at: '2026-11-12T21:58:00Z', age_seconds: 360, stale: false, max_age_seconds: 3600 }, running_jobs: 0 },
    { id: 'codex', display_name: 'codex', provider: 'codex', roles: ['implementer'],
      condition: condition('paused', 'fault', 'file_overlap_hold', 'Paused with 2 planned actions held by a file overlap hold.', '2026-11-12T18:52:00Z'),
      weekly: known(0.31, '2026-11-16T09:00:00Z', 604800),
      short: { state: 'unknown', used_fraction: null, level: null, resets_at: null, window_seconds: 18000, reason_code: 'window_expired_no_reading', reason_text: '5 hour window has reset; no new reading yet' },
      reading: { read_at: '2026-11-12T13:02:00Z', age_seconds: 32520, stale: true, max_age_seconds: 3600 }, running_jobs: 0 },
  ],
  breaker: condition('clear', 'none', null, null, null),
  direct_control: null,
  version: { installed: '82806c99', running: '82806c99', main: '82806c99', behind_commits: 0, latched: false },
});

// The temporary contract folder. routes/ and schemas/ link to the real files; models/ holds the real meta model and the fixture appbar model.
function makeApiDir() {
  const real = path.join(here, 'supervisor/api');
  for (const dir of ['models', 'routes', 'schemas']) fs.mkdirSync(path.join(apiDir, dir), { recursive: true });
  for (const dir of ['routes', 'schemas']) {
    for (const file of fs.readdirSync(path.join(real, dir))) fs.symlinkSync(path.join(real, dir, file), path.join(apiDir, dir, file));
  }
  fs.symlinkSync(path.join(real, 'models/meta.mjs'), path.join(apiDir, 'models/meta.mjs'));
  fs.writeFileSync(path.join(apiDir, 'models/appbar.mjs'), [
    "import fs from 'node:fs';",
    "export const name = 'appbar';", "export const path = 'appbar';", "export const schema = 'appbar.schema.json';", 'export const usesView = false;',
    `export const build = () => JSON.parse(fs.readFileSync(${JSON.stringify(fixtureFile)}, 'utf8'));`, '',
  ].join('\n'));
}
function seedState() {
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(stateRoot, d), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(stateRoot, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  fs.writeFileSync(path.join(stateRoot, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls: [], issues: [], delivered: [] }));
  fs.writeFileSync(fixtureFile, JSON.stringify(fixtureData(0.14)));
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
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true }); seedState();
  process.env.DEVTEST_API_DIR = apiDir;
  process.env.DEVTEST_EVENTS_POLL_MS = '100';
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390']) {
    fs.writeFileSync(fixtureFile, JSON.stringify(fixtureData(0.14)));
    const dashboard = handler({ wake: () => {}, root: stateRoot, config, host: '127.0.0.1', port: 8731 });
    // The scenario asks for /__fixture/first-weekly-015: this wrapper rewrites the fixture file and appends the event, then every other request goes to the dashboard.
    const server = http.createServer((req, res) => {
      req.headers.host = '127.0.0.1:8731';
      if (req.url === '/__fixture/first-weekly-015') {
        fs.writeFileSync(fixtureFile, JSON.stringify(fixtureData(0.15)));
        append(stateRoot, { type: 'model_changed', models: ['appbar'] });
        res.writeHead(200).end('changed');
        return;
      }
      return dashboard(req, res);
    });
    await run(profile, { phase: 'test', command: ['node', '/src/browser/ui-appbar-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `ui-appbar-${profile}`] }, server);
  }
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`UI APP BAR BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('UI APP BAR BROWSER CHECK DONE');
