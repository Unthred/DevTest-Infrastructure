#!/usr/bin/env node
// Tower-only browser check of the refresh outcome sentence (issue #1330), in the pinned Chromium container (same path as tests/appbar-allowance-browser.mjs).
// Renders the real Usage page for the real case of 13 Nov 2026 (Codex reading of 12 Nov 23:29 UTC, weekly 46 percent, refresh asked 20:45 UTC) once plain and
// once per outcome, stages the real static files and runs browser/refresh-outcome-scenario.mjs at 1280 and a phone width. Results go to the directory in argv[2].
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';
import { currentView } from '../supervisor/dashserver.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { stageDashui, freezeLivePanels } from './helpers/dashui-stage.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/refresh-outcome-browser.mjs <output-dir>'); process.exit(2); }
const now = Date.parse('2026-11-13T20:45:00Z'), storedAt = Date.parse('2026-11-12T23:29:00Z');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'refreshoutcome-'));
for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
const reading = { provider: 'codex', status: 'allowed', observedAt: storedAt, source: 'session-log', billing: { usingOverage: false },
  windows: [{ type: 'primary', windowMinutes: 300, utilization: 0.04, resetsAt: Date.parse('2026-11-13T01:34:00Z'), status: 'unknown' },
    { type: 'secondary', windowMinutes: 10080, utilization: 0.46, resetsAt: Date.parse('2026-11-18T09:00:00Z'), status: 'unknown' }] };
fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, probes: { codex: reading }, pulls: [], issues: [] }));
fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: path.join(root, 'inbox') },
  github_app: { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } };
for (const d of ['items', 'status']) fs.mkdirSync(path.join(root, 'inbox', d), { recursive: true });
const view = await currentView({ root, config, now, tz: 'UTC' });
const pageFor = query => freezeLivePanels(renderRoute(view, { page: 'usage' }, { query: new URLSearchParams(query), pathname: '/usage' }).html).replace(/<meta http-equiv="refresh"[^>]*>/, '');
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/refreshoutcome', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const site = fs.mkdtempSync('/mnt/cache/appdata/devtest-infrastructure/refreshoutcome-site-');
fs.mkdirSync(path.join(site, 'static'), { recursive: true }); stageDashui(site, path.join(here, 'supervisor', 'dashui'));
fs.writeFileSync(path.join(site, 'usage-plain.html'), pageFor(''));
for (const o of ['new', 'nothing-newer', 'refused', 'failed']) fs.writeFileSync(path.join(site, `usage-${o}.html`), pageFor(`probe=${o}&agent=codex${o === 'failed' ? '&reason=session-failed' : ''}`));
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
    await run(profile, { phase: 'test', command: ['node', '/src/browser/refresh-outcome-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `refresh-outcome-${profile}`] }, site);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(site, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`REFRESH OUTCOME BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('REFRESH OUTCOME BROWSER CHECK OK');
