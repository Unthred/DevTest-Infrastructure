import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCommand, discoverProject, DotnetCommandError } from '../dotnet/commands.mjs';

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-dotnet-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('discover one project or prefer a single solution in the selected directory', t => {
  const root = project(t);
  fs.writeFileSync(path.join(root, 'App.csproj'), '<Project />');
  assert.equal(discoverProject(root), path.join(root, 'App.csproj'));
  fs.writeFileSync(path.join(root, 'App.sln'), '');
  assert.equal(discoverProject(root), path.join(root, 'App.sln'));
});

test('discovery rejects missing or ambiguous project inputs', t => {
  const root = project(t);
  assert.throws(() => discoverProject(root), /no solution or project/);
  fs.writeFileSync(path.join(root, 'A.csproj'), '');
  fs.writeFileSync(path.join(root, 'B.csproj'), '');
  assert.throws(() => discoverProject(root), /multiple projects/);
  fs.writeFileSync(path.join(root, 'A.sln'), '');
  fs.writeFileSync(path.join(root, 'B.slnx'), '');
  assert.throws(() => discoverProject(root), /multiple solutions/);
  const outside = project(t);
  fs.writeFileSync(path.join(outside, 'Outside.csproj'), '');
  fs.symlinkSync(outside, path.join(root, 'escape'));
  assert.throws(() => discoverProject(root, 'escape'), /resolves outside/);
});

test('commands pin SDK selector and pass project paths as argv elements', t => {
  const root = project(t), csproj = path.join(root, 'App.csproj');
  fs.writeFileSync(csproj, '');
  assert.deepEqual(buildCommand({ sdk: '9', operation: 'build', projectRoot: root, configuration: 'Release', framework: 'net9.0' }), {
    sdk: '9', phase: 'build', command: ['dotnet', 'build', '/src/App.csproj', '--verbosity', 'minimal', '-p:RestorePackagesPath=/cache/9', '--source', '/work/empty-feed', '--artifacts-path', '/work/artifacts', '--configuration', 'Release', '--framework', 'net9.0'], workingDirectory: '/src'
  });
  assert.deepEqual(buildCommand({ sdk: 8, operation: 'test', project: '/src/A.csproj' }).command,
    ['dotnet', 'test', '/src/A.csproj', '--verbosity', 'minimal', '-p:RestorePackagesPath=/cache/8', '--source', '/work/empty-feed', '--artifacts-path', '/work/artifacts']);
  assert.deepEqual(buildCommand({ sdk: 10, operation: 'restore', project: '/src/A.csproj' }).command,
    ['dotnet', 'restore', '/src/A.csproj', '--verbosity', 'minimal', '--packages', '/cache/10', '--artifacts-path', '/work/artifacts']);
});

test('all SDK versions use isolated writable restore caches and read-only build phases', t => {
  const root = project(t), csproj = path.join(root, 'App.csproj');
  fs.writeFileSync(csproj, '');
  for (const sdk of ['8', '9', '10']) {
    const restore = buildCommand({ sdk, operation: 'restore', project: csproj, projectRoot: root });
    const build = buildCommand({ sdk, operation: 'build', project: csproj, projectRoot: root });
    assert.ok(restore.command.includes(`/cache/${sdk}`));
    assert.ok(build.command.includes('--source'));
    assert.ok(build.command.includes('/work/artifacts'));
    assert.ok(build.command.includes(`-p:RestorePackagesPath=/cache/${sdk}`));
  }
  const outside = project(t);
  fs.symlinkSync(outside, path.join(root, 'outside-feed'));
  assert.throws(() => buildCommand({ sdk: '8', operation: 'restore', project: csproj, projectRoot: root, packageSource: path.join(root, 'outside-feed') }), /inside the mounted source/);
});

test('unsafe or unsupported SDK/build options fail closed', t => {
  const root = project(t), projectFile = path.join(root, 'App.csproj');
  fs.writeFileSync(projectFile, '');
  for (const options of [
    { sdk: 7, operation: 'build', project: projectFile },
    { sdk: 8, operation: 'publish', project: projectFile },
    { sdk: 8, operation: 'build', project: `${root}/../outside.csproj`, projectRoot: root },
    { sdk: 8, operation: 'build', project: '/src/../../etc/passwd' },
    { sdk: 8, operation: 'build', project: projectFile, configuration: 'Production' },
    { sdk: 8, operation: 'build', project: projectFile, framework: 'net8.0;rm -rf /' },
    { sdk: 8, operation: 'restore', project: projectFile, noRestore: true }
  ]) assert.throws(() => buildCommand(options), DotnetCommandError);
});
