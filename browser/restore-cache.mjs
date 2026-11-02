#!/usr/bin/env node
// Host side, deliberate: the restore phase for the Playwright cache (docs/browser-runner.md). Unpacks the verified playwright-core
// tarball from browser/prepare-cache.mjs into the cache image, proves /cache/package/index.mjs exists, and only then writes the
// marker that `dev-test doctor` and the web commands require.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createPlan, runContainer } from '../docker/runner.mjs';
import { loadConfig, REPO_ROOT, PLAYWRIGHT_MARKER } from '../cli/config.mjs';

const { config } = loadConfig();
const pkg = config.lock.packages['playwright-core'];
const tgz = path.join(REPO_ROOT, 'browser', 'vendor', `playwright-core-${pkg.version}.tgz`);
if (!fs.existsSync(tgz)) { process.stderr.write('run "node browser/prepare-cache.mjs" first\n'); process.exit(3); }
const plan = createPlan({ project: REPO_ROOT, runId: crypto.randomBytes(8).toString('hex'), image: 'playwright', phase: 'restore',
  command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] }, config);
const result = await runContainer(plan);
fs.rmSync(plan.workspace, { recursive: true, force: true });
if (result.exitCode !== 0 || result.subjectExit !== 0) { process.stderr.write(`restore failed (exit ${result.exitCode}); no marker written\n`); process.exit(1); }
fs.writeFileSync(path.join(config.storageRoot, 'cache', PLAYWRIGHT_MARKER), `${JSON.stringify({ package: 'playwright-core', version: pkg.version, restoredAt: new Date().toISOString() })}\n`, { mode: 0o600 });
process.stdout.write(`playwright-core ${pkg.version} restored\n`);
