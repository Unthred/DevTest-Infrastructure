#!/usr/bin/env node
// Tower-only gate for issue #564: the app bar's /api/next swap runs in real Chromium (pinned Playwright container, no network), so
// DOMParser, the '[data-tick-state], .muted' selector, importNode and replaceWith are not the fakes of tests/dashboard-next-tick.test.mjs.
// The overview page is rendered with a scheduled tick whose slot has passed, so app.js asks /api/next at once; the fragments are the
// real nextTickHtml output (running) and the literal the server sends when no schedule exists (none). No production state is read.
// Prerequisite: `node browser/prepare-cache.mjs` (needs the network) makes browser/vendor/playwright-core-<version>.tgz; the smoke stops with a clear message when it is missing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { renderRoute, nextTickHtml } from '../supervisor/dashrender.mjs';
import { stageDashui } from './helpers/dashui-stage.mjs';

const sourceProject = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/nsw', crypto.randomBytes(6).toString('hex'));
const lock = JSON.parse(fs.readFileSync(path.join(sourceProject, 'docker', 'images.lock.json'), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(sourceProject, uid, gid), project = stage.project;
const config = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 180000, diskMb: 256, cacheMb: 64 } };
let failed = false;
const check = (name, ok, detail = {}) => { console.log(JSON.stringify({ check: name, ok: !!ok, ...detail })); if (!ok) failed = true; };

const NOW = Date.parse('2026-10-31T18:07:00Z'), MIN = 60000;
const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
async function buildSite(dir) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'next-swap-state-'));
  try {
    const view = await buildView({ config: cfg, root, jobs: [], events: [], state: { jobs: {} }, cache: { tick: { at: NOW - 2 * MIN, status: 'ok', lastOkAt: NOW - 2 * MIN }, pulls: [], issues: [] }, snapshots: [], now: NOW });
    const { html } = renderRoute(view, { page: 'overview' }, { query: new URLSearchParams(''), pathname: '/' });
    // app.js reloads every meta refresh-seconds (default 60 when the tag is absent), so push it out to an hour; refreshSeconds: 0 would drop the tag and leave the 60 s default.
    // The http-equiv refresh tag is relied on to sit inside <noscript> (Chromium with script on ignores it), so that is asserted rather than the tag removed.
    if (/<meta http-equiv="refresh"/.test(html.replace(/<noscript>[\s\S]*?<\/noscript>/g, ''))) throw new Error('a meta http-equiv refresh tag is outside <noscript>: it would reload the page under test, update buildSite');
    const quiet = html.replace('<meta name="refresh-seconds" content="60">', '<meta name="refresh-seconds" content="3600">');
    if (!quiet.includes('<meta name="refresh-seconds" content="3600">') || /refresh-seconds" content="60"/.test(quiet)) throw new Error('could not turn off the page reload: dashrender changed its refresh markup, update buildSite');
    fs.writeFileSync(path.join(dir, 'index.html'), quiet);
    stageDashui(dir);
    fs.mkdirSync(path.join(dir, 'fragments'));
    fs.writeFileSync(path.join(dir, 'fragments', 'none.html'), '<span class="muted">none</span>');   // what dashserver.mjs sends for /api/next without a schedule
    fs.writeFileSync(path.join(dir, 'fragments', 'running.html'), nextTickHtml({ nextTick: { state: 'running', since: NOW } }, NOW));
    for (const d of fs.readdirSync(dir, { recursive: true })) { const f = path.join(dir, d); fs.chmodSync(f, fs.statSync(f).isDirectory() ? 0o755 : 0o644); }
    fs.chmodSync(dir, 0o755);
    return html;
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

async function run(name, spec, site) {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: site ? ['fixture'] : [] }, config);
  const server = site ? await listenOnSocket(createStaticServer(site), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const result = await runContainer(plan, { keepVolume: true });
    console.log(JSON.stringify({ run: name, runId, exitCode: result.exitCode, subjectExit: result.subjectExit, cleanup: result.cleanup }));
    let summary = null; try { summary = JSON.parse(fs.readFileSync(path.join(plan.out, 'next-swap.summary.json'), 'utf8')); } catch { /* reported by the check */ }
    return { result, summary };
  } finally { await server?.close(); releaseVolumes(plan); }
}

const site = path.join(storageRoot, 'site');
try {
  fs.mkdirSync(site, { recursive: true, mode: 0o755 }); fs.chmodSync(storageRoot, 0o711);
  const pkg = lock.packages['playwright-core'];
  if (!fs.existsSync(path.join(sourceProject, 'browser', 'vendor', `playwright-core-${pkg.version}.tgz`))) throw new Error(`browser/vendor/playwright-core-${pkg.version}.tgz is missing: run \`node browser/prepare-cache.mjs\` first (it needs the network)`);
  const html = await buildSite(site);
  check('fixture page starts with a scheduled tick element', /data-tick-state="scheduled"><span data-countdown=/.test(html));
  const restore = await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] }, null);
  check('restore', restore.result.subjectExit === 0);
  const swap = await run('swap', { phase: 'test', command: ['node', '/src/browser/next-swap.mjs', '--target', 'fixture', '--page', '/index.html',
    '--case', 'scheduled-to-none=/fragments/none.html=none', '--case', 'scheduled-to-running=/fragments/running.html=running'] }, site);
  check('scheduled -> none: the element is replaced by the muted "none" and [data-tick-state] is gone', swap.summary?.cases?.find(c => c.name === 'scheduled-to-none')?.ok === true, { case: swap.summary?.cases?.[0] });
  check('scheduled -> running: the running element replaces the countdown', swap.summary?.cases?.find(c => c.name === 'scheduled-to-running')?.ok === true, { case: swap.summary?.cases?.[1] });
  check('no page errors, nothing blocked, wrapper exit 0', swap.result.subjectExit === 0 && swap.summary?.ok === true && swap.summary.blockedRequests.length === 0);
} catch (error) { console.error(`next-swap-smoke: ${error.name}: ${error.message}`); failed = true; }
finally { fs.rmSync(storageRoot, { recursive: true, force: true }); stage.cleanup(); }
console.log(failed ? 'NEXT SWAP SMOKE FAILED' : 'NEXT SWAP SMOKE OK');
process.exitCode = failed ? 1 : 0;
