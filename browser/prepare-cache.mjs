#!/usr/bin/env node
// Host side, run deliberately (it uses the network): downloads the playwright-core package named in docker/images.lock.json and
// refuses it unless its integrity matches the lock. The browser run itself has no network; a restore-phase run then unpacks this
// tarball into the read-only cache. The tarball is git-ignored.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'docker/images.lock.json'), 'utf8'));
const pkg = lock.packages?.['playwright-core'];
if (!pkg || !/^\d+\.\d+\.\d+$/.test(pkg.version) || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(pkg.integrity)) { process.stderr.write('lock file has no valid playwright-core entry\n'); process.exit(2); }
const vendor = path.join(root, 'browser', 'vendor');
const file = path.join(vendor, `playwright-core-${pkg.version}.tgz`);
const integrity = (p) => `sha512-${crypto.createHash('sha512').update(fs.readFileSync(p)).digest('base64')}`;
if (!(fs.existsSync(file) && integrity(file) === pkg.integrity)) {
  fs.rmSync(file, { force: true }); fs.mkdirSync(vendor, { recursive: true });
  const r = spawnSync('npm', ['pack', `playwright-core@${pkg.version}`, '--ignore-scripts', '--pack-destination', vendor], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0 || !fs.existsSync(file)) { process.stderr.write('npm pack failed\n'); process.exit(1); }
}
if (integrity(file) !== pkg.integrity) { fs.rmSync(file, { force: true }); process.stderr.write('integrity mismatch: tarball removed, nothing was used\n'); process.exit(1); }
process.stdout.write(`${path.relative(root, file)} verified (${pkg.integrity.slice(0, 22)}...)\n`);
