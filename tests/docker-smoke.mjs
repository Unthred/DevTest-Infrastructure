#!/usr/bin/env node
// Read-only source and isolated cache-pool output smoke for the trusted runner.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, ownedContainer, releaseVolumes } from '../docker/runner.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/smoke', crypto.randomBytes(8).toString('hex'));
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid();
const gid = process.getgid() === 0 ? 100 : process.getgid();
const config = { allowedProjects: [project], storageRoot, uid, gid, lock,
  limits: { cpus: 1, memoryMb: 512, pids: 64, shmMb: 64, timeoutMs: 60000, diskMb: 64, cacheMb: 64 } };
const probes = [
  { name: 'success', expectedExit: 0, command: ['sh', '-c', 'test -r /src/README.md && ! touch /src/.devtest-smoke-denied 2>/dev/null && ! touch /cache/.devtest-smoke-denied 2>/dev/null && printf SMOKE_OK > /out/marker && test -w /work'] },
  { name: 'subject-failure', expectedExit: 1, command: ['sh', '-c', 'exit 7'] },
  { name: 'hard-disk-limit', expectedExit: 1, command: ['sh', '-c', 'dd if=/dev/zero of=/out/overfill bs=1M count=96 status=none 2>/dev/null && exit 88; exit 37'] },
  { name: 'hard-cache-limit', phase: 'restore', expectedExit: 1, command: ['sh', '-c', 'dd if=/dev/zero of=/cache/overfill bs=1M count=96 status=none 2>/dev/null && exit 88; exit 37'] }
];
let lastPlan;
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  for (const probe of probes) {
    const runId = crypto.randomBytes(8).toString('hex');
    const plan = createPlan({ project, runId, image: 'dotnet-8', phase: probe.phase, command: probe.command }, config);
    lastPlan = plan;
    try {
      const result = await runContainer(plan, { keepVolume: true });   // keep the run volume mounted to inspect the evidence, then release it below
      const marker = path.join(plan.out, 'marker');
      const markerOk = probe.name !== 'success' || fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === 'SMOKE_OK';
      const containerGone = !ownedContainer(plan);
      const hardLimitOk = probe.name === 'hard-disk-limit'
        ? result.subjectExit === 37 && fs.statSync(path.join(plan.out, 'overfill')).size < 64 * 1048576
        : probe.name === 'hard-cache-limit'
          ? result.subjectExit === 37 && fs.statSync(path.join(plan.cache, 'overfill')).size < 64 * 1048576
          : true;
      console.log(JSON.stringify({ probe: probe.name, runId, image: plan.image, exitCode: result.exitCode, subjectExit: result.subjectExit, cleanup: result.cleanup, markerOk, hardLimitOk, containerGone }));
      if (result.exitCode !== probe.expectedExit || !markerOk || !hardLimitOk || !containerGone) process.exitCode = 1;
    } finally {
      releaseVolumes(plan);
      if (fs.existsSync(plan.workspace)) fs.rmSync(plan.workspace, { recursive: true, force: true });
    }
  }
} catch (error) {
  console.error(`docker-smoke: ${error.name}: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (lastPlan) {
    try { fs.rmSync(storageRoot, { recursive: true, force: true }); }
    catch (error) { console.error(`docker-smoke cleanup: ${error.name}: ${error.message}`); process.exitCode = 1; }
  }
}
