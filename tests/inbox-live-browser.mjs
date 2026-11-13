#!/usr/bin/env node
// Tower-only browser check that the open Inbox page shows a new card in place (issue #1287), in the pinned Chromium container (same path
// as tests/inbox-filter-browser.mjs). Serves the REAL dashboard request handler (supervisor/dashserver.mjs) over a temporary state root and
// Inbox folder, at desktop 1280 and phone 390, and runs browser/inbox-live-scenario.mjs. The handler is wrapped only to (a) set the Host
// it expects, (b) count the requests to /api/approvals/events, and (c) answer /__test/* calls that change the Inbox folder through the real
// inbox store while the page is open. Results go to the directory in argv[2]. Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { listenOnSocket } from '../browser/static-server.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import * as inbox from '../supervisor/inbox.mjs';
import { stageProject } from './stage-project.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/inbox-live-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const base = '/mnt/cache/appdata/devtest-infrastructure';
const storageRoot = path.join(base, 'inbox-live', crypto.randomBytes(6).toString('hex'));
const stateRoot = fs.mkdtempSync(path.join(base, 'inbox-live-state-'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const dir = path.join(stateRoot, 'inbox');
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } }, inbox: { dir } };
const NEW_TITLE = 'A command can record an already approved Inbox action that the next tick runs Actionbridge';

const drop = item => { const id = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item)); inbox.scan(dir, Date.now()); return id; };
// Starts every browser pass from one waiting card.
function resetInbox() {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ['items', 'status']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(stateRoot, d), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(stateRoot, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }] }));
  return drop({ kind: 'prompt', title: 'Waiting proposal one', prompt: 'Tidy the docs index.' });
}
let firstId = null, streamRequests = 0;
const testRoutes = {
  '/__test/reset': () => { firstId = resetInbox(); streamRequests = 0; return {}; },
  '/__test/add': () => { drop({ kind: 'prompt', title: NEW_TITLE, prompt: 'Read only: say what the next tick runs.' }); return {}; },
  '/__test/decide': () => inbox.decide(dir, firstId, 'reject', Date.now()),
  '/__test/streams': () => ({ count: streamRequests }),
};

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
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true }); resetInbox();
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390']) {
    const dashboard = handler({ wake: () => {}, root: stateRoot, config, host: '127.0.0.1', port: 8731 });
    const server = http.createServer((req, res) => {
      req.headers.host = '127.0.0.1:8731';
      const route = testRoutes[req.url.split('?')[0]];
      if (route) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(route())); }
      if (req.url.startsWith('/api/approvals/events')) streamRequests++;
      return dashboard(req, res);
    });
    await run(profile, { phase: 'test', command: ['node', '/src/browser/inbox-live-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `inbox-live-${profile}`] }, server);
  }
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`INBOX LIVE BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('INBOX LIVE BROWSER CHECK DONE');
