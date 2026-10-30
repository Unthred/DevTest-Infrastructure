#!/usr/bin/env node
// Tower-only gate for the responsive audit (issue #6). Real Docker, real browsers: the deliberately broken fixture must FAIL with
// the expected defects, the corrected fixture must PASS at every standard viewport, every profile must be genuinely rendered (PNG
// width = viewport x DPR), and nothing may be left behind. Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { STANDARD_PROFILES } from '../browser/capture.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/resp-smoke', crypto.randomBytes(6).toString('hex'));
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const config = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 180000, diskMb: 256, cacheMb: 64 } };
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout;
const state = () => ({ loops: sh('losetup', ['-a']).split('\n').filter(Boolean).length,
  mounts: fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter(l => l.includes(storageRoot)).length,
  containers: sh('docker', ['ps', '-a', '--filter', 'name=devtest-', '-q']).split('\n').filter(Boolean).length });
const baseline = state();
const pkg = lock.packages['playwright-core'];
const audit = (...a) => ['node', '/src/browser/responsive.mjs', '--target', 'fixture', ...a];
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
const pngWidth = (plan, f) => fs.readFileSync(path.join(plan.out, f)).readUInt32BE(16);

try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const restore = await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] }, { serve: false });
  check('restore', restore.result.subjectExit === 0);

  const broken = await run('broken-fixture', { phase: 'test', command: audit('--path', '/responsive/broken.html', '--name', 'broken', '--profiles', 'standard') }, {
    inspect: plan => ({ summary: read(plan, 'broken.summary.json'), widths: Object.fromEntries(STANDARD_PROFILES.map(p => [p, pngWidth(plan, `broken-${p}-chromium.png`)])), report: fs.readFileSync(path.join(plan.out, 'broken.report.md'), 'utf8'), files: fs.readdirSync(plan.out) }) });
  const kinds = new Set(broken.summary.failures.map(f => f.check));
  check('broken fixture fails (exit 15) at every standard profile', broken.result.subjectExit === 15 && !broken.summary.ok && broken.summary.profiles.length === 8 && broken.summary.profiles.every(p => !p.ok),
    { failuresByProfile: Object.fromEntries(broken.summary.profiles.map(p => [p.profile, p.failures])) });
  const expected = ['document-overflow', 'beyond-viewport', 'clipped', 'target-too-small', 'target-covered', 'chips-wrapped'];
  check('broken fixture is diagnosed with the seeded defects', expected.every(k => kinds.has(k)), { found: [...kinds].sort(), missing: expected.filter(k => !kinds.has(k)) });
  check('narrow profiles overflow sideways, wide ones do not', broken.summary.failures.some(f => f.profile === 'phone-360' && f.check === 'document-overflow') && !broken.summary.failures.some(f => f.profile === 'desktop-1920' && f.check === 'document-overflow'));
  check('human report and per-profile evidence are written', broken.report.includes('Result: **FAIL**') && broken.report.includes('layout heuristics') && STANDARD_PROFILES.every(p => broken.files.includes(`broken-${p}-chromium.png`) && broken.files.includes(`broken-${p}-chromium.layout.json`)));
  check('every profile is genuinely rendered; overflowing pages give wider-than-viewport PNGs', broken.summary.profiles.every(p => p.rendered && broken.widths[p.profile] >= p.viewport.width * p.deviceScaleFactor) && broken.widths['phone-360'] > 360 * 2, { widths: broken.widths });

  const fixed = await run('fixed-fixture', { phase: 'test', command: audit('--path', '/responsive/fixed.html', '--name', 'fixed', '--profiles', 'standard') }, {
    inspect: plan => ({ summary: read(plan, 'fixed.summary.json'), widths: STANDARD_PROFILES.map(p => pngWidth(plan, `fixed-${p}-chromium.png`)), report: fs.readFileSync(path.join(plan.out, 'fixed.report.md'), 'utf8') }) });
  check('corrected fixture passes at all 8 standard profiles', fixed.result.subjectExit === 0 && fixed.summary.ok && fixed.summary.profiles.length === 8 && fixed.summary.profiles.every(p => p.ok && p.rendered && p.failures === 0), { failures: fixed.summary.failures });
  check('the corrected page renders at exactly viewport x DPR (no sideways overflow)', fixed.widths.join() === [360, 390, 430, 768, 1024, 1280, 1440, 1920].map(w => w * (w < 1280 ? 2 : 1)).join(), { widths: fixed.widths });
  check('passing report states its limits', fixed.report.includes('Result: **PASS**') && fixed.report.includes('not that a person has accepted'));

  const variants = await run('variants', { phase: 'test', command: audit('--path', '/responsive/fixed.html', '--name', 'variants', '--profiles', 'phone-390-landscape,tablet-1024-portrait,desktop-1280-hidpi,desktop-1280-touch') }, { inspect: plan => ({ summary: read(plan, 'variants.summary.json') }) });
  check('orientation, DPR and touch variants render and pass', variants.result.subjectExit === 0 && variants.summary.profiles.length === 4 && variants.summary.profiles.every(p => p.ok && p.rendered), { widths: variants.summary.profiles.map(p => p.screenshot?.width) });

  for (const engine of ['firefox', 'webkit']) {
    const other = await run(`broken-${engine}`, { phase: 'test', command: audit('--path', '/responsive/broken.html', '--name', 'b', '--profiles', 'phone-390,desktop-1280', '--browser', engine) }, { inspect: plan => ({ summary: read(plan, 'b.summary.json') }) });
    check(`${engine} also detects the broken fixture`, other.result.subjectExit === 15 && other.summary.profiles.every(p => !p.ok && p.rendered), { found: [...new Set(other.summary.failures.map(f => f.check))].sort() });
  }
  const ext = await run('undeclared-destination', { phase: 'test', command: audit('--path', '/external.html', '--name', 'x', '--profiles', 'phone-390') }, { inspect: plan => ({ summary: read(plan, 'x.summary.json') }) });
  check('a page reaching outside is blocked, exit 12 outranks layout', ext.result.subjectExit === 12 && ext.summary.blockedRequests.length >= 3);
} catch (error) { console.error(`responsive-smoke: ${error.name}: ${error.message}`); failed = true; }
finally { fs.rmSync(storageRoot, { recursive: true, force: true }); }
const after = state();
check('cleanup returned to baseline (loops, mounts, containers)', JSON.stringify(after) === JSON.stringify(baseline), { baseline, after });
console.log(failed ? 'RESPONSIVE SMOKE FAILED' : 'RESPONSIVE SMOKE OK');
process.exitCode = failed ? 1 : 0;
