#!/usr/bin/env node
// Tower-only browser check of Approve and Reject on Inbox Table and Compact rows (issue #1262), in the pinned Chromium container (same path as tests/lists-browser.mjs).
// The page is the real /inbox route: dashserver's handler serves it, with the real static scripts, over the declared Unix socket, from a
// fixture inbox built through the real store (tests/helpers/inbox-views-fixture.mjs). Only the Host and Origin headers are set to the ones the handler
// expects, because the container reaches the socket through a loopback port the host does not know. Results go to the directory in argv[2].
// Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { listenOnSocket } from '../browser/static-server.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { stageProject } from './stage-project.mjs';
import { buildInbox } from './helpers/inbox-views-fixture.mjs';
import { writeDecisionState } from './helpers/inbox-decision-fixture.mjs';
import { allStatuses } from '../supervisor/inbox.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/inbox-row-actions-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/ivrow', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ivbrowser-'));
for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [] }));
const inboxDir = path.join(root, 'inbox');
const freshInbox = () => { fs.rmSync(inboxDir, { recursive: true, force: true }); buildInbox(inboxDir); };   // each width starts from the same waiting items
freshInbox();
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inboxDir },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
const HOST = '127.0.0.1', PORT = 8080;
const dash = handler({ wake: () => {}, root, config, host: HOST, port: PORT });
// Issue #1477: a second dashboard whose Inbox also holds the four decision cards of 14 Nov 2026, raised from a saved cache and team state.
const droot = fs.mkdtempSync(path.join(os.tmpdir(), 'ivdecision-'));
fs.mkdirSync(path.join(droot, 'jobs'), { recursive: true });
const dInbox = path.join(droot, 'inbox');
const dconfig = { ...config, repository: 'o/r', ...writeDecisionState(droot), inbox: { dir: dInbox } };
const freshDecisionInbox = () => { fs.rmSync(dInbox, { recursive: true, force: true }); buildInbox(dInbox); };
const dashDecisions = handler({ wake: () => {}, root: droot, config: dconfig, host: HOST, port: PORT });
const failures = [];
// The click Reject split recorded for card split-stuck-1175, read from the inbox store after the page was driven.
const checkRecordedClick = name => {
  const clicks = allStatuses(dInbox).filter(x => x.click).map(x => `${x.click.card}:${x.click.action}`).sort().join();
  const want = 'homeowner-pr-1192:park,split-stuck-1175:reject_split';
  if (clicks !== want) failures.push(`${name}: recorded clicks ${clicks || 'none'}, wanted ${want}`);
};
const run = async (name, spec, serve, decisions = false) => {
  if (decisions) freshDecisionInbox();
  else if (serve) freshInbox();
  const app = decisions ? dashDecisions : dash;
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: serve ? ['fixture'] : [] }, cfg);
  const server = serve ? await listenOnSocket(http.createServer((req, res) => { req.headers.host = `${HOST}:${PORT}`; if (req.headers.origin) req.headers.origin = `http://${HOST}:${PORT}`; app(req, res); }), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup }));
    if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (decisions) checkRecordedClick(name);
    if (serve) for (const f of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await server?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true });
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390'])
    await run(profile, { phase: 'test', command: ['node', '/src/browser/inbox-row-actions-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `inbox-row-actions-${profile}`] }, true);
  for (const profile of ['desktop-1280', 'phone-390'])
    await run(`${profile}-decisions`, { phase: 'test', command: ['node', '/src/browser/inbox-row-actions-scenario.mjs', '--target', 'fixture', '--profile', profile, '--mode', 'decisions', '--name', `inbox-row-decisions-${profile}`] }, true, true);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(droot, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`INBOX ROW ACTIONS BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('INBOX ROW ACTIONS BROWSER CHECK DONE');
