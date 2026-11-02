#!/usr/bin/env node
// Tower-only gate for the dev-test CLI (issue #8). Drives bin/dev-test as a child process against real Docker with an isolated storage
// root: browser screenshot and responsive runs, the policy refusals, missing Docker / missing image, report and cleanup, and proves
// that no loop device, mount or container is left behind. Needs `node browser/prepare-cache.mjs` once. Run niced.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPlan, runContainer } from '../docker/runner.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(repo, 'bin', 'dev-test');
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure', `cli-smoke-${crypto.randomBytes(4).toString('hex')}`);
const lock = JSON.parse(fs.readFileSync(path.join(repo, 'docker/images.lock.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-cli-smoke-'));
const limits = { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 120000, diskMb: 128, cacheMb: 64 };
const base = { allowedProjects: [repo], storageRoot, uid: 99, gid: 100, limits };
const write = (name, obj) => { const f = path.join(tmp, name); fs.writeFileSync(f, JSON.stringify(obj)); return f; };
const configFile = write('runner.json', base);
const sh = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' }).stdout;
const state = () => ({
  loops: sh('losetup', ['-a']).split('\n').filter(Boolean).length,
  mounts: fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter((l) => l.includes(storageRoot)).length,
  containers: sh('docker', ['ps', '-a', '--filter', 'name=devtest-', '-q']).split('\n').filter(Boolean).length
});
const baseline = state();
let failed = false;
const check = (name, ok, detail = {}) => { console.log(JSON.stringify({ check: name, ok: !!ok, ...detail })); if (!ok) failed = true; };
function cli(args, { config = configFile, env = {} } = {}) {
  const r = env.PATH ? spawnSync(process.execPath, [path.join(repo, 'cli/main.mjs'), ...args, '--json'], { encoding: 'utf8', env: { ...process.env, DEV_TEST_CONFIG: config, ...env } }) : spawnSync(bin, [...args, '--json'], { encoding: 'utf8', env: { ...process.env, DEV_TEST_CONFIG: config, ...env } });
  let result = null; try { result = JSON.parse(r.stdout); } catch { /* checked by callers */ }
  return { code: r.status, result, stdoutLines: r.stdout.split('\n').filter(Boolean).length, stderr: r.stderr };
}
const page = (rel) => pathToFileURL(path.join(repo, 'browser/fixture', rel)).href;
const root = ['--root', path.join(repo, 'browser/fixture')];

try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  // One restore run (no network) unpacks the pinned playwright-core into the cache, as docs/browser-runner.md describes.
  const pkg = lock.packages['playwright-core'];
  const plan = createPlan({ project: repo, runId: crypto.randomBytes(8).toString('hex'), image: 'playwright', phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] }, { ...base, lock });
  const restored = await runContainer(plan);
  fs.rmSync(plan.workspace, { recursive: true, force: true });
  check('restore playwright cache', restored.exitCode === 0);

  const doctor = cli(['doctor']);
  check('doctor: ready', doctor.code === 0 && doctor.result.data.checks.some((c) => c.name === 'image playwright' && c.status === 'ok'));

  const shot = cli(['web', 'screenshot', '--url', page('index.html'), '--profile', 'desktop', ...root]);
  check('screenshot passes; stdout is exactly one JSON line', shot.code === 0 && shot.stdoutLines === 1 && shot.result.artifacts.some((a) => a.kind === 'screenshot' && /^[0-9a-f]{64}$/.test(a.sha256) && a.bytes > 1000), { exit: shot.code, message: shot.result?.message, artifacts: shot.result?.artifacts.map((a) => a.path) });
  check('result carries image digest and exit/cleanup fields', /^sha256:[0-9a-f]{64}$/.test(shot.result.image?.digest) && shot.result.cleanup === 'complete' && fs.existsSync(path.join(shot.result.workspace, 'result.json')));
  const shotPngSize = fs.statSync(path.join(shot.result.workspace, shot.result.artifacts.find((a) => a.kind === 'screenshot').path)).size;
  check('stored screenshot hash matches', shotPngSize === shot.result.artifacts.find((a) => a.kind === 'screenshot').bytes);

  const broken = cli(['web', 'screenshot', '--url', page('broken.html'), '--profile', 'desktop']);
  check('broken page is a subject failure (exit 1)', broken.code === 1 && broken.result.status === 'failed' && broken.result.data.wrapper_exit === 10, { data: broken.result?.data });
  const external = cli(['web', 'screenshot', '--url', page('external.html'), '--profile', 'desktop']);
  check('undeclared destinations are blocked and fail the run (exit 1)', external.code === 1 && external.result.data.wrapper_exit === 12 && external.result.data.blocked_requests >= 3);

  const refused = cli(['web', 'screenshot', '--url', 'http://192.168.1.10:8123/', '--profile', 'desktop']);
  check('network URL refused before anything starts (exit 4)', refused.code === 4 && refused.result.status === 'refused');
  const secret = cli(['web', 'screenshot', '--url', 'file:///x?access_token=abcdefghijklmnopqrstuvwxyz0123', '--profile', 'desktop']);
  check('credential in URL refused (exit 4)', secret.code === 4 && !JSON.stringify(secret.result).includes('abcdefghijklmnop'));
  const outside = cli(['web', 'screenshot', '--url', 'file:///etc/passwd', '--profile', 'desktop']);
  check('page outside the allowlist refused (exit 4)', outside.code === 4);

  const rb = cli(['web', 'responsive', '--url', page('responsive/broken.html'), '--profiles', 'phone-360,desktop-1280', ...root]);
  check('responsive: broken page fails (exit 1) with findings', rb.code === 1 && rb.result.data.failures.length > 0, { failures: rb.result?.data?.failures?.length });
  const rbOnly = cli(['web', 'responsive', '--url', page('responsive/broken.html'), '--profiles', 'phone-360', '--assert', 'document-overflow', ...root]);
  check('responsive: --assert limits which rules fail the run', rbOnly.code === 1 && rbOnly.result.data.failures.every((f) => f.check === 'document-overflow') && rbOnly.result.data.ignored_failures > 0, { exit: rbOnly.code, msg: rbOnly.result?.message, data: rbOnly.result?.data });
  const rNone = cli(['web', 'responsive', '--url', page('responsive/broken.html'), '--profiles', 'phone-360', '--assert', 'truncated', ...root]);
  check('responsive: an asserted rule that did not fire passes (exit 0)', rNone.code === 0 && rNone.result.data.ignored_failures > 0);
  const rf = cli(['web', 'responsive', '--url', page('responsive/fixed.html'), '--profiles', 'standard', ...root]);
  check('responsive: corrected page passes at all 8 standard profiles (exit 0)', rf.code === 0 && rf.result.artifacts.filter((a) => a.kind === 'screenshot').length === 8, { exit: rf.code, msg: rf.result?.message, data: rf.result?.data });

  const rep = cli(['report', shot.result.run_id]);
  check('report shows the stored result', rep.code === 0 && rep.result.data.stored.run_id === shot.result.run_id);
  const dry = cli(['cleanup', '--run-id', shot.result.run_id, '--dry-run']);
  check('cleanup --dry-run removes nothing', dry.code === 0 && dry.result.data.entries.some((e) => e.kind === 'evidence' && e.action === 'would_remove') && fs.existsSync(shot.result.workspace));
  const older = cli(['cleanup', '--older-than', '1s']);
  check('cleanup --older-than never removes evidence', older.code === 0 && fs.existsSync(shot.result.workspace));
  const gone = cli(['cleanup', '--run-id', shot.result.run_id]);
  check('cleanup --run-id removes named evidence', gone.code === 0 && !fs.existsSync(shot.result.workspace));

  // .NET build through the CLI: a throwaway class library (needs no packages, so the offline build works), then a syntax error.
  const lib = fs.mkdtempSync('/mnt/user/projects/.cli-smoke-lib-');
  try {
    fs.chmodSync(lib, 0o755);
    fs.writeFileSync(path.join(lib, 'Lib.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n', { mode: 0o644 });
    fs.writeFileSync(path.join(lib, 'C.cs'), 'namespace L { public class C { public int N() => 1; } }\n', { mode: 0o644 });
    const dotnetConfig = write('dotnet.json', { ...base, allowedProjects: [repo, lib] });
    const ok = cli(['dotnet', 'build', '--sdk', '8', '--project', lib], { config: dotnetConfig });
    check('dotnet build passes (exit 0)', ok.code === 0 && ok.result.image.digest.startsWith('sha256:') && ok.result.cleanup === 'complete', { message: ok.result?.message });
    fs.writeFileSync(path.join(lib, 'C.cs'), 'namespace L { public class C { public int N() => ; } }\n', { mode: 0o644 });
    const bad = cli(['dotnet', 'build', '--sdk', '8', '--project', path.join(lib, 'Lib.csproj')], { config: dotnetConfig });
    check('dotnet build of broken code is a subject failure (exit 1)', bad.code === 1 && bad.result.status === 'failed');
    check('dotnet project outside the allowlist refused (exit 4)', cli(['dotnet', 'build', '--sdk', '8', '--project', '/etc'], { config: dotnetConfig }).code === 4);
  } finally { fs.rmSync(lib, { recursive: true, force: true }); }

  // Environment negatives, with real processes.
  const noDocker = cli(['web', 'screenshot', '--url', page('index.html'), '--profile', 'desktop'], { env: { PATH: '/nonexistent' } });
  check('Docker missing: exit 3 and nothing started', noDocker.code === 3 && /Docker is unavailable/.test(noDocker.result.message));
  const badLock = JSON.parse(JSON.stringify(lock)); badLock.images.playwright.reference = badLock.images.playwright.reference.replace(/sha256:.*/, `sha256:${'0'.repeat(64)}`);
  fs.writeFileSync(path.join(tmp, 'bad.lock.json'), JSON.stringify(badLock));
  const noImage = cli(['web', 'screenshot', '--url', page('index.html'), '--profile', 'desktop'], { config: write('bad.json', { ...base, lockFile: 'bad.lock.json' }) });
  check('pinned image absent: exit 3, no pull attempted', noImage.code === 3 && /not present locally/.test(noImage.result.message));
  check('usage error: exit 2', cli(['web', 'screenshot', '--url', page('index.html'), '--profile', 'nope']).code === 2);
  const doctorNoDocker = cli(['doctor'], { env: { PATH: '/nonexistent' } });
  check('doctor reports Docker missing: exit 3', doctorNoDocker.code === 3 && doctorNoDocker.result.data.checks.find((c) => c.name === 'docker').status === 'fail');
} finally {
  const after = state();
  check('no loop device, mount or container left behind', after.loops === baseline.loops && after.mounts === 0 && after.containers === baseline.containers, { baseline, after });
  fs.rmSync(storageRoot, { recursive: true, force: true });
  fs.rmSync(tmp, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
