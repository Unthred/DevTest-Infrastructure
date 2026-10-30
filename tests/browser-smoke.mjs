#!/usr/bin/env node
// Tower-only gate for the browser track (issue #5). Runs the pinned Playwright image through the real runner against a static
// page served from the HOST over a Unix socket. Proves: screenshots at phone and desktop, a broken page and an external
// request are detected, the container has no network interface, and nothing (loop, mount, container, socket) is left behind.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, ownedContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/browser-smoke', crypto.randomBytes(6).toString('hex'));
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const config = { allowedProjects: [project], storageRoot, uid, gid, lock,
  limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 120000, diskMb: 128, cacheMb: 64 } };
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout;
const state = () => ({
  loops: sh('losetup', ['-a']).split('\n').filter(Boolean).length,
  mounts: fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter(l => l.includes(storageRoot)).length,
  containers: sh('docker', ['ps', '-a', '--filter', 'name=devtest-', '-q']).split('\n').filter(Boolean).length
});
const baseline = state();
const png = file => { const b = fs.readFileSync(file); return b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length } : null; };
const pkg = lock.packages['playwright-core'];
const capture = (...a) => ['node', '/src/browser/capture.mjs', '--target', 'fixture', ...a];
let failed = false, socketsLeft = true;
const check = (name, ok, detail = {}) => { console.log(JSON.stringify({ check: name, ok: !!ok, ...detail })); if (!ok) failed = true; };

async function run(name, spec, { serve = true, inspect = () => ({}) } = {}) {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: serve ? ['fixture'] : [] }, config);
  const server = serve ? await listenOnSocket(createStaticServer(path.join(project, 'browser', 'fixture')), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const result = await runContainer(plan, { keepVolume: true });
    const extra = inspect(plan, result);
    console.log(JSON.stringify({ run: name, runId, exitCode: result.exitCode, subjectExit: result.subjectExit, cleanup: result.cleanup, containerGone: !ownedContainer(plan), network: plan.args.find(a => a.startsWith('--network')) }));
    return { plan, result, ...extra };
  } finally {
    await server?.close();
    releaseVolumes(plan);
  }
}
const report = (plan, name) => JSON.parse(fs.readFileSync(path.join(plan.out, name), 'utf8'));

try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const restore = await run('restore-playwright-core', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] }, { serve: false });
  check('restore', restore.result.exitCode === 0 && restore.result.subjectExit === 0);

  const probe = await run('no-network-interface', { phase: 'test', command: ['sh', '-c', 'test "$(wc -l < /proc/net/route)" = 1 && node -e "require(\'net\').connect({host:\'1.1.1.1\',port:443}).on(\'connect\',()=>process.exit(1)).on(\'error\',e=>process.exit(e.code===\'ENETUNREACH\'?0:2))"'] }, { serve: false });
  check('container has no route and cannot reach an external address', probe.result.subjectExit === 0);

  const desktop = await run('index-desktop-chromium', { phase: 'test', command: capture('--path', '/', '--name', 'index', '--profile', 'desktop', '--full-page', '--trace') }, {
    inspect: plan => ({ shot: png(path.join(plan.out, 'index-desktop-chromium.png')), rep: report(plan, 'index-desktop-chromium.report.json'), trace: fs.existsSync(path.join(plan.out, 'index-desktop-chromium.trace.zip')) }) });
  check('desktop screenshot', desktop.result.subjectExit === 0 && desktop.shot?.width === 1280 && desktop.shot.bytes > 1000 && desktop.rep.ok && desktop.trace, { shot: desktop.shot, browserVersion: desktop.rep.browserVersion });

  const phone = await run('index-phone-chromium', { phase: 'test', command: capture('--path', '/', '--name', 'index', '--profile', 'phone') }, {
    inspect: plan => ({ shot: png(path.join(plan.out, 'index-phone-chromium.png')), rep: report(plan, 'index-phone-chromium.report.json') }) });
  check('phone screenshot', phone.result.subjectExit === 0 && phone.shot?.width === 780 && phone.shot.height === 1688 && phone.rep.ok, { shot: phone.shot });

  const broken = await run('broken-page', { phase: 'test', command: capture('--path', '/broken.html', '--name', 'broken') }, { inspect: plan => ({ rep: report(plan, 'broken-desktop-chromium.report.json') }) });
  check('broken page detected', broken.result.subjectExit === 10 && !broken.rep.ok && broken.rep.consoleErrors.length >= 1 && broken.rep.pageErrors.length >= 1 && broken.rep.httpErrors.some(e => e.status === 404), { problems: broken.rep.problems });

  const external = await run('external-requests', { phase: 'test', command: capture('--path', '/external.html', '--name', 'external') }, {
    inspect: plan => ({ text: fs.readFileSync(path.join(plan.out, 'external-desktop-chromium.report.json'), 'utf8') }) });
  const ext = JSON.parse(external.text);
  check('external requests refused and recorded', external.result.subjectExit === 12 && ext.blockedRequests.length >= 3 && !external.text.includes('SHOULD_NOT_APPEAR'), { blocked: ext.blockedRequests });

  for (const engine of ['firefox', 'webkit']) {
    const other = await run(`index-desktop-${engine}`, { phase: 'test', command: capture('--path', '/', '--name', 'index', '--browser', engine) }, {
      inspect: plan => ({ shot: png(path.join(plan.out, `index-desktop-${engine}.png`)) }) });
    check(`${engine} screenshot`, other.result.subjectExit === 0 && other.shot?.width === 1280, { shot: other.shot });
  }
  const late = await run('navigation-failure', { phase: 'test', command: capture('--path', '/', '--name', 'late', '--target', 'missing') }, { inspect: () => ({}) });
  check('an undeclared target is a usage error, not a network attempt', late.result.subjectExit === 2);
} catch (error) {
  console.error(`browser-smoke: ${error.name}: ${error.message}`); failed = true;
} finally {
  socketsLeft = fs.existsSync(path.join(storageRoot, 'sockets')) && fs.readdirSync(path.join(storageRoot, 'sockets')).length > 0;
  fs.rmSync(storageRoot, { recursive: true, force: true });
}
const after = state();
const back = JSON.stringify(after) === JSON.stringify(baseline);
check('cleanup returned to baseline (loops, mounts, containers)', back, { baseline, after });
check('no sockets left behind', !socketsLeft);
console.log(failed ? 'BROWSER SMOKE FAILED' : 'BROWSER SMOKE OK');
process.exitCode = failed ? 1 : 0;
