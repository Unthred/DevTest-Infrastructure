#!/usr/bin/env node
// Tower-only browser check of the split card of a stuck pull request (issue #1240), in the pinned Chromium container (same path as tests/decision-inplace-browser.mjs).
// Renders the real Overview from a throwaway supervisor state holding the real data of PR 1139 (/a.html: split proposed, /b.html: split filed, /pr.html and /pr-proposed.html: the PR page), stages the real
// static files and runs browser/splitstuck-scenario.mjs at a laptop and a phone width. Results go to the directory in argv[2]. Run `node browser/prepare-cache.mjs` first.
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
if (!process.argv[2]) { console.error('usage: node tests/splitstuck-browser.mjs <output-dir>'); process.exit(2); }
const HEAD = 'a'.repeat(40), now = Date.now();
const config = root => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: path.join(root, 'inbox') },
  github_app: { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } });
// The Overview with PR 1139 parked: the split is proposed (/a.html) and, once the homeowner approved it, filed (/b.html). Real data from tests/fixtures/split-stuck.
const real = JSON.parse(fs.readFileSync(path.join(here, 'tests/fixtures/split-stuck/pr1139.json'), 'utf8'));
const ITEMS = [{ title: 'Capacity team', files: ['supervisor/capacityteam.mjs', 'tests/capacity-planner.test.mjs'] }, { title: 'Issue assignment', files: ['supervisor/issueassign.mjs', 'tests/overseer-control.test.mjs'] },
  { title: 'Inbox agent and pass speed', files: ['supervisor/inboxagent.mjs', 'tests/pass-speed.test.mjs', 'tests/test-resources.test.mjs'] }];
async function render(filed, route = { page: 'overview' }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'splitstuck-'));
  try {
    for (const d of ['jobs', 'dashboard', 'team', 'inbox/items', 'inbox/status']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const pr = real.pr, pulls = [{ number: pr.number, title: pr.title, state: 'OPEN', headRefName: pr.headRefName, headRefOid: pr.headRefOid, labels: ['parked'], statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }];
    fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls, issues: [] }));
    const stuckSplits = { [pr.number]: { status: filed ? 'filed' : 'proposed', cause: 'fix-limit', reason: '4 fix rounds (limit 4) have not cleared the review findings', issue: pr.sourceIssue, head: pr.headRefOid, parked: true, items: ITEMS.map(x => ({ ...x, scope: x.title, acceptance: [], tests: [] })), ...(filed ? { filed: [2000, 2001, 2002] } : {}) } };
    fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ fixAttempts: { [`${pr.number}:${pr.headRefOid}`]: 4 }, verdicts: {}, jobs: {}, stuckSplits }));
    const view = await currentView({ root, config: config(root), now, tz: 'UTC' });
    return freezeLivePanels(renderRoute(view, route, { query: new URLSearchParams(), pathname: '/' }).html).replace('<meta name="refresh-seconds" content="60">', '<meta name="refresh-seconds" content="3">');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const pageA = await render(false), pageB = await render(true), pagePr = await render(true, { page: 'pr', id: real.pr.number }), pagePrProposed = await render(false, { page: 'pr', id: real.pr.number });
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/splitstuck', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const site = fs.mkdtempSync('/mnt/cache/appdata/devtest-infrastructure/splitstuck-site-');
stageDashui(site, path.join(here, 'supervisor', 'dashui'));
fs.writeFileSync(path.join(site, 'a.html'), pageA);
fs.writeFileSync(path.join(site, 'b.html'), pageB);
fs.writeFileSync(path.join(site, 'pr.html'), pagePr);
fs.writeFileSync(path.join(site, 'pr-proposed.html'), pagePrProposed);
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
    await run(profile, { phase: 'test', command: ['node', '/src/browser/splitstuck-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `splitstuck-${profile}`] }, site);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(site, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`SPLIT STUCK BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('SPLIT STUCK BROWSER CHECK OK');
