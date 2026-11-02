#!/usr/bin/env node
// Tower-only gate for the Home Assistant read-only profile (issue #10) against the ANONYMISED LOCAL FIXTURE. Real Docker, real
// browsers. It never touches the live Home Assistant: that is blocked (OQ-2, no scoped identity) and reported as blocked.
// Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';

const sourceProject = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/ha-smoke', crypto.randomBytes(6).toString('hex'));
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(sourceProject, uid, gid);
const project = stage.project;
const config = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 180000, diskMb: 256, cacheMb: 64 } };
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout;
const state = () => ({ loops: sh('losetup', ['-a']).split('\n').filter(Boolean).length,
  mounts: fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter(l => l.includes(storageRoot)).length,
  containers: sh('docker', ['ps', '-a', '--filter', 'name=devtest-', '-q']).split('\n').filter(Boolean).length });
const baseline = state();
const pkg = lock.packages['playwright-core'];
const ha = (...a) => ['node', '/src/browser/ha-readonly.mjs', '--target', 'fixture', ...a];
let failed = false;
const check = (name, ok, detail = {}) => { console.log(JSON.stringify({ check: name, ok: !!ok, ...detail })); if (!ok) failed = true; };

async function run(name, spec, { serve = true, inspect = () => ({}) } = {}) {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: serve ? ['fixture'] : [] }, config);
  const server = serve ? await listenOnSocket(createStaticServer(path.join(project, 'browser', 'fixture', 'ha')), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const result = await runContainer(plan, { keepVolume: true });
    console.log(JSON.stringify({ run: name, runId, exitCode: result.exitCode, subjectExit: result.subjectExit, cleanup: result.cleanup, network: plan.args.find(a => a.startsWith('--network')) }));
    return { plan, result, ...inspect(plan, result) };
  } finally { await server?.close(); releaseVolumes(plan); }
}
const read = (plan, f) => JSON.parse(fs.readFileSync(path.join(plan.out, f), 'utf8'));
const png = (plan, f) => { const b = fs.readFileSync(path.join(plan.out, f)); return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }; };

try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const restore = await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] }, { serve: false });
  check('restore', restore.result.subjectExit === 0);

  for (const engine of ['chromium', 'firefox', 'webkit']) {
    const good = await run(`fixture-${engine}`, { phase: 'test', command: ha('--name', 'ha', '--probe', 'clicks', '--browser', engine) },
      { inspect: plan => ({ summary: read(plan, 'ha.summary.json'), files: fs.readdirSync(plan.out), sizes: Object.fromEntries(fs.readdirSync(plan.out).filter(f => f.endsWith('.png')).map(f => [f, png(plan, f)])), report: fs.readFileSync(path.join(plan.out, 'ha.report.md'), 'utf8') }) });
    const s = good.summary;
    check(`${engine}: fixture passes (exit 0) on 3 pages x phone-390 and desktop-1280`, good.result.subjectExit === 0 && s.ok && s.pages.length === 3 && s.pages.every(p => p.profiles.length === 2 && p.profiles.every(x => x.ok && x.rendered)), { failures: s.pages.flatMap(p => p.failures) });
    check(`${engine}: six screenshots saved, exactly viewport x DPR wide`, Object.keys(good.sizes).length === 6 && good.sizes[`ha-dashboard-phone-390-${engine}.png`]?.width === 780 && good.sizes[`ha-heating-season-desktop-1280-${engine}.png`]?.width === 1280, { sizes: good.sizes });
    check(`${engine}: every state-changing control was clicked, every click was blocked, no handler ran`, s.probe.attempted >= 20 && s.probe.blocked >= s.probe.attempted && s.probe.mutated === 0 && s.readOnly.blockedInteractions.length > 0, { probe: s.probe });
    check(`${engine}: report says fixture, not live`, good.report.includes('not the live Home Assistant') && good.report.includes('Result: **PASS**'));
  }

  const writer = await run('write-attempt', { phase: 'test', command: ha('--name', 'w', '--pages', 'attempt=/attempts-write.html', '--profiles', 'desktop-1280') }, { inspect: plan => ({ summary: read(plan, 'w.summary.json') }) });
  check('a page that POSTs and sends call_service fails with exit 16; both are recorded without payload', writer.result.subjectExit === 16 && writer.summary.readOnly.blockedWrites.some(w => /^POST /.test(w)) && writer.summary.readOnly.blockedFrames.some(f => f.startsWith('call_service')) && !JSON.stringify(writer.summary).includes('30'), { readOnly: writer.summary.readOnly });

  const broken = await run('broken-layout', { phase: 'test', command: ha('--name', 'b', '--pages', 'heating-settings=/broken-settings.html') }, { inspect: plan => ({ summary: read(plan, 'b.summary.json') }) });
  const kinds = new Set(broken.summary.pages[0].failures.map(f => `${f.profile}:${f.check}`));
  check('an overflowing page fails (exit 15) on the phone, not on the desktop', broken.result.subjectExit === 15 && kinds.has('phone-390:document-overflow') && ![...kinds].some(k => k.startsWith('desktop-1280:document-overflow')), { found: [...kinds] });
} catch (error) { console.error(`ha-readonly-smoke: ${error.name}: ${error.message}`); failed = true; }
finally { fs.rmSync(storageRoot, { recursive: true, force: true }); stage.cleanup(); }
const after = state();
check('cleanup returned to baseline (loops, mounts, containers)', JSON.stringify(after) === JSON.stringify(baseline), { baseline, after });
console.log(failed ? 'HA READONLY SMOKE FAILED' : 'HA READONLY SMOKE OK');
process.exitCode = failed ? 1 : 0;
