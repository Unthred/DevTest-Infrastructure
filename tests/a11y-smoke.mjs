#!/usr/bin/env node
// Tower-only gate for the axe-core accessibility scan (issue #455). Real Docker, real browser, no network: the deliberately broken
// fixture must FAIL with the seeded faults, the corrected fixture must PASS, axe-core must come from the restored cache (not the
// network), and nothing may be left behind. Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';

const sourceProject = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/a11y-smoke', crypto.randomBytes(6).toString('hex'));
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(sourceProject, uid, gid), project = stage.project;
const config = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 180000, diskMb: 256, cacheMb: 64 } };
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout;
const state = () => ({ loops: sh('losetup', ['-a']).split('\n').filter(Boolean).length,
  mounts: fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter(l => l.includes(storageRoot)).length,
  containers: sh('docker', ['ps', '-a', '--filter', 'name=devtest-', '-q']).split('\n').filter(Boolean).length });
const baseline = state();
const pw = lock.packages['playwright-core'], axe = lock.packages['axe-core'];
const scan = (...a) => ['node', '/src/browser/a11y.mjs', '--target', 'fixture', ...a];
let failed = false;
const check = (name, ok, detail = {}) => { console.log(JSON.stringify({ check: name, ok: !!ok, ...detail })); if (!ok) failed = true; };

async function run(name, spec, { serve = true, inspect = () => ({}) } = {}) {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: serve ? ['fixture'] : [] }, config);
  const server = serve ? await listenOnSocket(createStaticServer(path.join(project, 'browser', 'fixture')), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const result = await runContainer(plan, { keepVolume: true });
    console.log(JSON.stringify({ run: name, runId, exitCode: result.exitCode, subjectExit: result.subjectExit, cleanup: result.cleanup, network: plan.args.find(a => a.startsWith('--network')) }));
    return { plan, result, ...inspect(plan, result) };
  } finally { await server?.close(); releaseVolumes(plan); }
}
const read = (plan, f) => JSON.parse(fs.readFileSync(path.join(plan.out, f), 'utf8'));

try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const restore = await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pw.version}.tgz -C /cache && test -f /cache/package/index.mjs && mkdir -p /cache/axe-core && tar -xzf /src/browser/vendor/axe-core-${axe.version}.tgz -C /cache/axe-core && test -f /cache/axe-core/package/axe.min.js`] }, { serve: false });
  check('restore (playwright-core and axe-core from the verified tarballs)', restore.result.subjectExit === 0);

  const broken = await run('broken-fixture', { phase: 'test', command: scan('--path', '/a11y/broken.html', '--name', 'broken', '--profiles', 'desktop-1440,phone-390') }, {
    inspect: plan => ({ summary: read(plan, 'broken.summary.json'), report: fs.readFileSync(path.join(plan.out, 'broken.report.md'), 'utf8') }) });
  const ids = new Set(broken.summary.profiles.flatMap(p => p.violations.map(v => v.id)));
  const seeded = ['image-alt', 'color-contrast', 'label', 'button-name', 'link-name', 'html-has-lang'];
  check('broken fixture fails (wrapper exit 17)', broken.result.subjectExit === 17 && !broken.summary.ok);
  check('the seeded faults are all found at both profiles', seeded.every(id => broken.summary.profiles.every(p => p.violations.some(v => v.id === id))), { found: [...ids].sort(), missing: seeded.filter(id => !ids.has(id)) });
  check('WCAG 2.1 AA tags and the pinned axe version were used', broken.summary.tags.join() === 'wcag2a,wcag2aa,wcag21a,wcag21aa' && broken.summary.axe_version === axe.version, { axe: broken.summary.axe_version });
  check('report states that automated checks do not cover everything', /find only some accessibility problems/.test(broken.report) && /Incomplete/.test(broken.report));
  check('network-less: no request left the page', broken.summary.blockedRequests.length === 0 && broken.plan.args.includes('--network=none'));

  const fixed = await run('fixed-fixture', { phase: 'test', command: scan('--path', '/a11y/fixed.html', '--name', 'fixed', '--profiles', 'desktop-1440,phone-390') }, {
    inspect: plan => ({ summary: read(plan, 'fixed.summary.json'), report: fs.readFileSync(path.join(plan.out, 'fixed.report.md'), 'utf8') }) });
  check('corrected fixture passes (wrapper exit 0)', fixed.result.subjectExit === 0 && fixed.summary.ok && fixed.summary.violation_nodes === 0, { violations: fixed.summary.violation_nodes });
  check('a passing report still states the limit', /do not show the page is accessible|does not show the page is accessible/.test(fixed.report));

  const ext = await run('undeclared-destination', { phase: 'test', command: scan('--path', '/external.html', '--name', 'x', '--profiles', 'phone-390') }, { inspect: plan => ({ summary: read(plan, 'x.summary.json') }) });
  check('a page reaching outside is blocked, exit 12 outranks the scan', ext.result.subjectExit === 12 && ext.summary.blockedRequests.length >= 1);

  const noAxe = await run('no-axe-in-cache', { phase: 'test', command: scan('--path', '/a11y/fixed.html', '--name', 'n', '--profiles', 'phone-390', '--axe', '/cache/axe-core/package/missing.js') }, { inspect: plan => ({ summary: read(plan, 'n.summary.json') }) });
  check('a missing axe-core is a launch failure, never a pass', noAxe.result.subjectExit === 14 && noAxe.summary.ok === false);
} catch (error) { console.error(`a11y-smoke: ${error.name}: ${error.message}`); failed = true; }
finally { fs.rmSync(storageRoot, { recursive: true, force: true }); stage.cleanup(); }
const after = state();
check('cleanup returned to baseline (loops, mounts, containers)', JSON.stringify(after) === JSON.stringify(baseline), { baseline, after });
console.log(failed ? 'A11Y SMOKE FAILED' : 'A11Y SMOKE OK');
process.exitCode = failed ? 1 : 0;
