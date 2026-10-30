#!/usr/bin/env node
// Tower-only gate for the bounded-storage lifecycle (PR #19 review B1). It runs small niced probes through the real runner
// (success, subject failure, timeout, SIGINT, and a SIGKILLed runner that strands a mount for the next start-up sweep) and
// compares `losetup -a` and the DevTest mount count with the baseline after each. Exit 0 only if everything returns to it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, sweepStaleVolumes } from '../docker/runner.mjs';

const here = fileURLToPath(import.meta.url);
const project = path.resolve(path.dirname(here), '..');
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const storageRoot = process.env.DEVTEST_LIFECYCLE_ROOT || path.join('/mnt/cache/appdata/devtest-infrastructure/lifecycle', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const limits = timeoutMs => ({ cpus: 1, memoryMb: 256, pids: 64, shmMb: 64, timeoutMs, diskMb: 64, cacheMb: 64 });
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout;
const loops = () => sh('losetup', ['-a']).split('\n').filter(Boolean).length;
const mounts = () => fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter(l => l.includes(storageRoot)).length;
const containers = () => sh('docker', ['ps', '-a', '--filter', 'name=devtest-', '-q']).split('\n').filter(Boolean).length;
const state = () => ({ loops: loops(), mounts: mounts(), containers: containers() });
const planFor = (command, timeoutMs = 60000) => createPlan({ project, runId: crypto.randomBytes(8).toString('hex'), image: 'dotnet-8', command },
  { allowedProjects: [project], storageRoot, uid, gid, lock, limits: limits(timeoutMs) });

if (process.argv[2] === 'child') {           // a runner that announces itself and then runs a long container
  const plan = planFor(['sleep', '60']);
  console.log('READY', process.pid);
  const result = await runContainer(plan);
  console.log(JSON.stringify({ exitCode: result.exitCode, reason: result.reason, volume: result.volume }));
  process.exit(0);
}

fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
const baseline = state();
let failed = false;
const check = (name, extra = {}) => {
  const now = state();
  const ok = now.loops === baseline.loops && now.mounts === baseline.mounts && now.containers === baseline.containers;
  if (!ok) failed = true;
  console.log(JSON.stringify({ probe: name, ...extra, baseline, now, backToBaseline: ok }));
};
console.log(JSON.stringify({ baseline }));
for (const [name, command, timeout, expected] of [
  ['success', ['sh', '-c', 'echo ok > /out/marker'], 60000, 0],
  ['subject-failure', ['sh', '-c', 'exit 7'], 60000, 1],
  ['over-limit-write', ['sh', '-c', 'dd if=/dev/zero of=/out/big bs=1M count=96 2>/dev/null; exit 37'], 60000, 1],
  ['timeout', ['sleep', '30'], 2000, 5]
]) {
  const r = await runContainer(planFor(command, timeout));
  if (r.exitCode !== expected || r.cleanup !== 'complete') failed = true;
  check(name, { exitCode: r.exitCode, cleanup: r.cleanup, volume: r.volume });
}
// SIGINT to a runner mid-run
const child = spawn(process.execPath, [here, 'child'], { env: { ...process.env, DEVTEST_LIFECYCLE_ROOT: storageRoot }, stdio: ['ignore', 'pipe', 'inherit'] });
let out = ''; child.stdout.on('data', c => { out += c; });
await new Promise(r => { const t = setInterval(() => { if (out.includes('READY') && containers() > baseline.containers) { clearInterval(t); r(); } }, 200); });
child.kill('SIGINT');
await new Promise(r => child.on('close', r));
check('sigint', { runner: out.trim().split('\n').pop() });
// SIGKILL of a runner strands its mount; the next start-up sweep must remove only that
const victim = spawn(process.execPath, [here, 'child'], { env: { ...process.env, DEVTEST_LIFECYCLE_ROOT: storageRoot }, stdio: ['ignore', 'pipe', 'inherit'] });
let vout = ''; victim.stdout.on('data', c => { vout += c; });
await new Promise(r => { const t = setInterval(() => { if (vout.includes('READY') && containers() > baseline.containers) { clearInterval(t); r(); } }, 200); });
victim.kill('SIGKILL');
await new Promise(r => victim.on('close', r));
spawnSync('docker', ['rm', '-f', ...sh('docker', ['ps', '-a', '--filter', 'name=devtest-', '-q']).split('\n').filter(Boolean)]);   // the orphan container, as an operator would
const stranded = state();
const swept = sweepStaleVolumes(storageRoot);
console.log(JSON.stringify({ probe: 'sigkill-then-sweep', stranded, swept }));
check('after-sweep');
if (stranded.loops <= baseline.loops) { failed = true; console.log('note: nothing was stranded, so the sweep was not exercised'); }
fs.rmSync(storageRoot, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
console.log(failed ? 'LIFECYCLE FAIL' : 'LIFECYCLE OK');
