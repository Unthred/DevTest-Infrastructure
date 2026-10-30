#!/usr/bin/env node
// Tower gate for issue #7 (real Docker, dry-run mock backend, plus an unauthenticated OpenBao health probe). Proves: a secret file
// is readable by the container user and nowhere else, is read-only, is not in argv or the environment, is gone afterwards,
// and a container that copies it into /out is caught by the scan. No real credential is read or created.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, ownedContainer, releaseVolumes } from '../docker/runner.mjs';
import { withSecrets, DEFAULT_SECRET_ROOT } from '../broker/broker.mjs';
import { createMockBackend } from '../broker/mock.mjs';
import { checkHealth } from '../broker/openbao.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/smoke', crypto.randomBytes(8).toString('hex'));
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const policy = JSON.parse(fs.readFileSync(new URL('../broker/policy.example.json', import.meta.url), 'utf8'));
const uid = 99, gid = 100;
const config = { allowedProjects: [project], storageRoot, uid, gid, lock, secretRoot: DEFAULT_SECRET_ROOT,
  limits: { cpus: 1, memoryMb: 512, pids: 64, shmMb: 64, timeoutMs: 60000, diskMb: 64, cacheMb: 64 } };
const probes = [
  { name: 'secret-readable-readonly-not-leaked', expectLeak: false, command: ['sh', '-c', [
    'test -r /secrets/fixture-login || echo no-read >> /out/diag',
    'touch /secrets/x 2>/dev/null && echo wrote-dir >> /out/diag',
    'rm -f /secrets/fixture-login 2>/dev/null; test -e /secrets/fixture-login || echo removed >> /out/diag',
    'sh -c "echo x >> /secrets/fixture-login" 2>/dev/null && echo appended >> /out/diag',
    '(env; tr "\\0" " " < /proc/1/cmdline) | grep -q MOCK-NOT-A-SEC""RET && echo in-env-or-argv >> /out/diag',
    'test -e /out/diag || printf SECRET_OK > /out/marker'].join('; ')] },
  { name: 'deliberate-copy-into-out-is-caught', expectLeak: true, command: ['sh', '-c', 'cp /secrets/fixture-login /out/leak.txt'] }
];
try {
  const health = await checkHealth({ address: 'http://127.0.0.1:8200' });
  console.log(JSON.stringify({ probe: 'openbao-health', ...health }));
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  for (const probe of probes) {
    const runId = crypto.randomBytes(8).toString('hex');
    const plan = createPlan({ project, runId, image: 'dotnet-8', secrets: ['fixture-login'], command: probe.command }, config);
    let caught = false, run, ok = false, goneAfter = false;
    try {
      await withSecrets({ policy, names: ['fixture-login'], backend: createMockBackend(), runId, root: DEFAULT_SECRET_ROOT, uid, gid },
        async () => { run = await runContainer(plan, { keepVolume: true }); }, { outputRoots: [path.join(plan.out)] });
    } catch (error) { caught = error.exitCode === 8; }
    try {
      goneAfter = !fs.existsSync(path.join(DEFAULT_SECRET_ROOT, runId));
      ok = (probe.expectLeak ? caught && run?.subjectExit === 0 : !caught && run?.subjectExit === 0 && fs.readFileSync(path.join(plan.out, 'marker'), 'utf8') === 'SECRET_OK') && goneAfter;
      console.log(JSON.stringify({ probe: probe.name, runId, subjectExit: run?.subjectExit ?? null, leakDetected: caught, secretDirGone: goneAfter, containerGone: !ownedContainer(plan), ok }));
    } catch (error) { console.error(`broker-smoke probe: ${error.message}`); }
    finally {
      releaseVolumes(plan);   // always: a probe failure must not strand a loop mount
      if (fs.existsSync(plan.workspace)) fs.rmSync(plan.workspace, { recursive: true, force: true });
    }
    if (!ok) process.exitCode = 1;
  }
  const left = fs.existsSync(DEFAULT_SECRET_ROOT) ? fs.readdirSync(DEFAULT_SECRET_ROOT) : [];
  console.log(JSON.stringify({ probe: 'no-secret-directories-left', left: left.length }));
  if (left.length) process.exitCode = 1;
  console.log(process.exitCode ? 'BROKER SMOKE FAILED' : 'BROKER SMOKE OK');
} catch (error) {
  console.error(`broker-smoke: ${error.name}: ${error.message}`); process.exitCode = 1;
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); }
