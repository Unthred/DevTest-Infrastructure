#!/usr/bin/env node
// Tower-only browser check of the Overseer direct control card (issue #1164), in the pinned Chromium container (same path as tests/lists-browser.mjs).
// Renders the real Supervisor page with a done and a refused audit record from a throwaway supervisor state (fake data), with the write proof a served page carries, stages the real static files and
// runs browser/direct-control-scenario.mjs at a laptop and a phone width. Results go to the directory in argv[2]. Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';
import { currentView } from '../supervisor/dashserver.mjs';
import { appendAudit } from '../supervisor/directstore.mjs';
import { withProof } from '../supervisor/dashwrite.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { stageDashui, freezeLivePanels } from './helpers/dashui-stage.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/direct-control-browser.mjs <output-dir>'); process.exit(2); }
const now = Date.now();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directcard-'));
for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls: [], issues: [] }));
fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: path.join(root, 'inbox') },
  github_app: { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
for (const d of ['items', 'status']) fs.mkdirSync(path.join(root, 'inbox', d), { recursive: true });
const inboxDir = path.join(root, 'inbox');
appendAudit(inboxDir, { at: now - 120000, by: 'overseer', action: 'park', target: '21', reason: 'not this week', outcome: 'done', changed: true, before: { parked: false }, after: { parked: true }, text: 'issue #21 is parked.', undo: { op: 'unpark', n: 21 } });
appendAudit(inboxDir, { at: now - 60000, by: 'overseer', action: 'merge', target: '22', reason: 'ship it', outcome: 'refused', changed: false, before: null, after: null, text: 'merge is not a direct control: merging is the homeowner\'s decision', undo: null });
const view = await currentView({ root, config, now, tz: 'UTC' });
const html = withProof(freezeLivePanels(renderRoute(view, { page: 'supervisor' }, { query: new URLSearchParams(), pathname: '/supervisor' }).html).replace(/<meta http-equiv="refresh"[^>]*>/, ''), root);
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/directcard', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const site = fs.mkdtempSync('/mnt/cache/appdata/devtest-infrastructure/directcard-site-');
fs.mkdirSync(path.join(site, 'static'), { recursive: true }); stageDashui(site, path.join(here, 'supervisor', 'dashui'));
fs.writeFileSync(path.join(site, 'card.html'), html);
for (const f of fs.readdirSync(site, { recursive: true })) { const p = path.join(site, f); fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o755 : 0o644); }
fs.chmodSync(site, 0o755);
const failures = [];
const run = async (name, spec, dir) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: dir ? ['fixture'] : [] }, cfg);
  const server = dir ? await listenOnSocket(createStaticServer(dir), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup }));
    if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (dir) for (const f of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await server?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true });
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390'])
    await run(profile, { phase: 'test', command: ['node', '/src/browser/direct-control-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `direct-${profile}`] }, site);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(site, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`DIRECT CONTROL CARD BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('DIRECT CONTROL CARD BROWSER CHECK OK');
