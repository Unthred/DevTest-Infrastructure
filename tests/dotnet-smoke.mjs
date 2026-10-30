#!/usr/bin/env node
// Tower-only real SDK build/cache smoke. All .NET work runs through docker/runner.mjs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createDotnetPlan } from '../dotnet/run.mjs';
import { createPlan, runContainer, releaseVolumes } from '../docker/runner.mjs';

const projectParent = '/mnt/user/projects';
const storageParent = '/mnt/cache/appdata/devtest-infrastructure/issue3-smoke';
const smokeId = crypto.randomBytes(8).toString('hex');
const projectRoot = path.join(projectParent, `.devtest-issue3-${smokeId}`);
const storageRoot = path.join(storageParent, smokeId);
const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const uid = process.getuid() === 0 ? 99 : process.getuid();
const gid = process.getgid() === 0 ? 100 : process.getgid();
const config = {
  allowedProjects: [projectRoot], storageRoot, uid, gid, lock,
  limits: { cpus: 1, memoryMb: 768, pids: 96, shmMb: 64, timeoutMs: 300000, diskMb: 512, cacheMb: 128 }
};
let projectCreated = false;
let storageCreated = false;

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, value, { mode: 0o644 });
}

function prepareFixture() {
  if (fs.existsSync(projectRoot) || fs.existsSync(storageRoot)) throw new Error('generated smoke path already exists');
  fs.mkdirSync(projectRoot, { mode: 0o755 });
  projectCreated = true;
  const feed = path.join(projectRoot, 'feed');
  const emptyFeed = path.join(projectRoot, 'empty-feed');
  const packageRoot = path.join(projectRoot, 'package');
  fs.mkdirSync(feed); fs.mkdirSync(emptyFeed);
  write(path.join(packageRoot, 'package.nuspec'), `<?xml version="1.0"?><package><metadata><id>DevTest.CacheProbe</id><version>1.0.0</version><authors>DevTest</authors><description>Local cache smoke fixture</description></metadata></package>`);
  write(path.join(packageRoot, 'lib/net8.0/_._'), 'placeholder');
  const packed = spawnSync('zip', ['-q', '-r', path.join(feed, 'DevTest.CacheProbe.1.0.0.nupkg'), 'package.nuspec', 'lib'], { cwd: packageRoot, encoding: 'utf8' });
  if (packed.error || packed.status !== 0) throw new Error('could not create local NuGet fixture package');
  write(path.join(projectRoot, 'Program.cs'), 'using System;\nConsole.WriteLine("SDK fixture built");\n');
}

async function execute(sdk, operation, extra = {}) {
  const runId = crypto.randomBytes(8).toString('hex');
  const dotnet = createDotnetPlan({ sdk, operation, projectRoot, project: path.join(projectRoot, 'App.csproj'), runId, ...extra }, config);
  const wrapped = createPlan({ project: projectRoot, runId, image: `dotnet-${sdk}`, phase: operation, cacheName: `nuget-sdk-${sdk}`,
    command: ['sh', '-c', 'find /src -maxdepth 2 -type f -print > /out/source-files; dotnet "$@" > /out/subject.log 2>&1; code=$?; echo "$code" > /out/subject.exit; exit "$code"', 'dotnet-smoke', ...dotnet.dotnet.command.slice(1)] }, config);
  let result, output = '', sourceFiles = '';
  try {
    result = await runContainer(wrapped, { keepVolume: true });
    output = fs.readFileSync(path.join(wrapped.out, 'subject.log'), 'utf8');
    sourceFiles = fs.readFileSync(path.join(wrapped.out, 'source-files'), 'utf8');
  } finally {
    if (result) releaseVolumes(wrapped);
    fs.rmSync(wrapped.workspace, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ sdk, operation, phase: wrapped.phase, image: wrapped.image, runId, cache: path.basename(wrapped.cache), exitCode: result.exitCode, subjectExit: result.subjectExit, cleanup: result.cleanup,
    sourceFiles: sourceFiles.trim().split('\n').map(line => line.replaceAll('/src', '<src>')), output: output.trim().split('\n').map(line => line.replaceAll(projectRoot, '<fixture>')) }));
  if (result.exitCode !== 0 || result.cleanup !== 'complete') throw new Error(`${operation} failed for SDK ${sdk} (runner exit ${result.exitCode})`);
}

async function preflight() {
  const command = ['sh', '-c', 'ulimit -a > /out/debug; command -v dotnet >> /out/debug 2>&1; dotnet --version >> /out/debug 2>&1; echo "dotnet_exit=$?" >> /out/debug; find /work /tmp -type f -printf "%s %p\\n" >> /out/debug 2>&1; exit 0'];
  const plan = createPlan({ project: projectRoot, runId: crypto.randomBytes(8).toString('hex'), image: 'dotnet-8', command }, config);
  let result, debug = '';
  try {
    result = await runContainer(plan, { keepVolume: true });
    debug = fs.readFileSync(path.join(plan.out, 'debug'), 'utf8');
  } finally {
    if (result) releaseVolumes(plan);
    fs.rmSync(plan.workspace, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ sdk: '8', operation: 'preflight', image: plan.image, runnerExit: result.exitCode, cleanup: result.cleanup, evidence: debug.trim().split('\n') }));
  if (result.exitCode !== 0 || result.cleanup !== 'complete' || !debug.includes('dotnet_exit=0')) throw new Error(`SDK preflight failed (runner exit ${result.exitCode})`);
}

let passed = false;
try {
  fs.mkdirSync(storageParent, { recursive: true, mode: 0o700 });
  prepareFixture();
  fs.mkdirSync(storageRoot, { mode: 0o700 });
  storageCreated = true;
  await preflight();
  for (const sdk of ['8', '9', '10']) {
    write(path.join(projectRoot, 'App.csproj'), `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup><TargetFramework>net${sdk}.0</TargetFramework><OutputType>Exe</OutputType><NuGetAudit>false</NuGetAudit></PropertyGroup>
  <ItemGroup><PackageReference Include="DevTest.CacheProbe" Version="1.0.0" /></ItemGroup>
</Project>
`);
    // Populate only from the generated local feed, then prove cache reuse with an empty feed.
    await execute(sdk, 'restore', { packageSource: path.join(projectRoot, 'feed') });
    await execute(sdk, 'restore', { packageSource: path.join(projectRoot, 'empty-feed') });
    await execute(sdk, 'build');
  }
  passed = true;
} finally {
  if (projectCreated) fs.rmSync(projectRoot, { recursive: true, force: true });
  if (storageCreated) fs.rmSync(storageRoot, { recursive: true, force: true });
}
console.log(passed ? 'DOTNET SDK 8/9/10 CACHE SMOKE OK' : 'DOTNET SDK CACHE SMOKE FAIL');
