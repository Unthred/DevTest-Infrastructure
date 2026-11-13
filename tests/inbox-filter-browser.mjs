#!/usr/bin/env node
// Tower-only browser check for the Inbox quick filters (issue #1217), in the pinned Chromium container (same path as tests/lists-browser.mjs).
// Serves the REAL dashboard request handler (supervisor/dashserver.mjs) on the target socket, over a throwaway state and an inbox of four
// real items (a prompt done, an issue draft done, a waiting proposal, a failed prompt), and runs browser/inbox-filter-scenario.mjs at
// desktop 1280 and phone 390. Results (JSON, screenshots) go to the directory in argv[2]. Run `node browser/prepare-cache.mjs` first.
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
if (!process.argv[2]) { console.error('usage: node tests/inbox-filter-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const base = '/mnt/cache/appdata/devtest-infrastructure';
const storageRoot = path.join(base, 'inbox-filter', crypto.randomBytes(6).toString('hex'));
const stateRoot = fs.mkdtempSync(path.join(base, 'inbox-filter-state-'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } },
  inbox: { dir: path.join(stateRoot, 'inbox') } };

// Four items with the real shape, made through the inbox store: scan picks them up pending, finish() ends two of them.
function seedInbox() {
  const dir = config.inbox.dir;
  fs.mkdirSync(path.join(dir, 'items'), { recursive: true }); fs.mkdirSync(path.join(dir, 'status'), { recursive: true });
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(stateRoot, d), { recursive: true });
  const now = Date.now();
  fs.writeFileSync(path.join(stateRoot, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }] }));
  const drop = item => { const id = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item)); return id; };
  const done = drop({ kind: 'prompt', title: 'Rules drift check read only Driftcheck', prompt: 'Check the rules for drift. Read only.' });
  const draft = drop({ kind: 'issue_draft', title: 'Post-mortem: 3 jobs failed with cause deterministic', body: 'Three jobs failed with the same cause.' });
  drop({ kind: 'prompt', title: 'Waiting proposal', prompt: 'Tidy the docs.' });
  const failed = drop({ kind: 'prompt', title: 'Failed prompt', prompt: 'Run the thing that fails.' });
  inbox.scan(dir, now);
  for (const id of [done, draft, failed]) inbox.decide(dir, id, 'approve', now);
  inbox.finish(dir, done, { state: 'done' }, now); inbox.finish(dir, draft, { state: 'done' }, now); inbox.finish(dir, failed, { state: 'failed', result: 'It failed.' }, now);
}

const failures = [];
const run = async (name, spec, server) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: server ? ['fixture'] : [] }, cfg);
  const listening = server ? await listenOnSocket(server, targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup })); if (r.subjectExit && process.env.INBOX_FILTER_DEBUG) console.log(fs.existsSync(plan.out) ? fs.readdirSync(plan.out) : "no out", JSON.stringify(r).slice(0, 1500));
    if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (server) for (const f of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await listening?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true }); seedInbox();
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390']) {
    const dashboard = handler({ wake: () => {}, root: stateRoot, config, host: '127.0.0.1', port: 8731 });
    // The browser reaches the socket through a bridge on a port chosen inside the container, so the Host it sends is rewritten to the one the handler serves.
    const server = http.createServer((req, res) => { req.headers.host = '127.0.0.1:8731'; return dashboard(req, res); });
    await run(profile, { phase: 'test', command: ['node', '/src/browser/inbox-filter-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `inbox-filter-${profile}`] }, server);
  }
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`INBOX FILTER BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('INBOX FILTER BROWSER CHECK DONE');
