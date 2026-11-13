#!/usr/bin/env node
// Tower-only browser gate. The trusted runner owns image pinning, limits, isolation and cleanup.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, releaseVolumes, runContainer, targetSocketPath } from '../../../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../../../browser/static-server.mjs';
import { buildFixtureSite } from './fixture-site.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const lock = JSON.parse(fs.readFileSync(path.join(source, 'docker', 'images.lock.json'), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid();
const gid = process.getgid() === 0 ? 100 : process.getgid();
const tempRoot = process.env.TMPDIR;
if (!tempRoot) throw new Error('TMPDIR is required for the dashboard e2e scratch directory');
const storageRoot = path.join(tempRoot, 'e');
const config = {
  allowedProjects: [source], uid, gid, lock, storageRoot,
  limits: { cpus: 1, memoryMb: 1024, pids: 128, shmMb: 128, timeoutMs: 120000, diskMb: 128, cacheMb: 64 }
};
const fixturesRoot = fs.mkdtempSync(path.join(tempRoot, 'dashboard-e2e-'));
const failures = [];
const spec = (runId, phase, command, targets = []) => ({ project: source, runId, image: 'playwright', phase, command, targets });

async function execute(name, plan, site = null, variant = null) {
  const server = site ? await listenOnSocket(createStaticServer(site), targetSocketPath(storageRoot, plan.runId, 'fixture'), { uid, gid }) : null;
  let retained = false;
  try {
    const result = await runContainer(plan, { keepVolume: true });
    retained = true;
    const ok = result.subjectExit === 0 && result.cleanup === 'complete';
    console.log(JSON.stringify({ name, subjectExit: result.subjectExit, cleanup: result.cleanup }));
    if (!ok) {
      const file = variant ? path.join(plan.out, `dashboard-e2e-${variant}.json`) : null;
      const detail = file && fs.existsSync(file) ? ` (${JSON.parse(fs.readFileSync(file, 'utf8')).error || 'unknown failure'})` : '';
      failures.push(`${name}: subject exit ${result.subjectExit}, cleanup ${result.cleanup}${detail}`);
    }
  } finally {
    await server?.close();
    if (retained) releaseVolumes(plan);
  }
}

try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  const version = lock.packages['playwright-core'].version;
  const restoreCommand = [
    'sh',
    '-c',
    `tar -xzf /src/browser/vendor/playwright-core-${version}.tgz -C /cache && test -f /cache/package/index.mjs`
  ];
  const restore = createPlan(
    spec(crypto.randomBytes(8).toString('hex'), 'restore', restoreCommand),
    config
  );
  await execute('restore Playwright package cache', restore);
  for (const variant of ['valid', 'long', 'empty', 'malformed', 'best', 'best-none', 'best-beaten']) {
    const root = path.join(fixturesRoot, variant, 'state');
    const site = path.join(fixturesRoot, variant, 'site');
    fs.mkdirSync(site, { recursive: true });
    await buildFixtureSite({ root, site, variant });
    const command = ['node', '/src/tests/e2e/dashboard/scenario.mjs', 'fixture', variant];
    const plan = createPlan(
      spec(crypto.randomBytes(8).toString('hex'), 'test', command, ['fixture']),
      config
    );
    await execute(`dashboard ${variant} fixture`, plan, site, variant);
  }
} finally {
  fs.rmSync(storageRoot, { recursive: true, force: true });
  fs.rmSync(fixturesRoot, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`DASHBOARD E2E FAILED:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else console.log('DASHBOARD E2E PASSED');
