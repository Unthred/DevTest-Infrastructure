#!/usr/bin/env node
// Issue #11: end-to-end demonstration through the single `dev-test` CLI (D-001). Build the sample Blazor component library, optionally run
// its tests, serve the sample page over the runner's Unix-socket target, capture screenshots and responsive assertions, prove the
// artifacts sit at stable evidence paths, and prove nothing is left running. It never starts a container itself; every step is one
// `dev-test ... --json` child process. Project paths come from arguments/environment, never from this file (docs/blazor-demo.md).
//   node tools/blazor-demo.mjs [--project-root <dir>] [--sdk 8|9|10] [--require-tests] [--run-dir <dir>] [--cli <path>] [--no-docker-check]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function parseDemoArgs(argv) {
  const o = { projectRoot: REPO, sdk: '8', requireTests: false, runDir: undefined, cli: path.join(REPO, 'bin', 'dev-test'), dockerCheck: true };
  const need = (i, n) => { if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) throw new Error(`${n} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--project-root') o.projectRoot = path.resolve(need(i++, a));
    else if (a === '--sdk') o.sdk = need(i++, a);
    else if (a === '--run-dir') o.runDir = path.resolve(need(i++, a));
    else if (a === '--cli') o.cli = path.resolve(need(i++, a));
    else if (a === '--require-tests') o.requireTests = true;
    else if (a === '--no-docker-check') o.dockerCheck = false;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!['8', '9', '10'].includes(o.sdk)) throw new Error('--sdk must be 8, 9 or 10');
  return o;
}

export function spawnCli(cli, args) {
  const r = spawnSync(cli, [...args, '--json'], { encoding: 'utf8' });
  let result = null; try { result = JSON.parse(r.stdout); } catch { /* reported as a failed step */ }
  return { code: r.status, result };
}

function dockerState() {
  const sh = (c, a) => spawnSync(c, a, { encoding: 'utf8' }).stdout || '';
  return {
    containers: sh('docker', ['ps', '-a', '--filter', 'name=devtest-', '-q']).split('\n').filter(Boolean).length,
    loops: sh('losetup', ['-a']).split('\n').filter(Boolean).length
  };
}

// Runs the demonstration. `run(cliArgs)` -> { code, result }; injectable so tests can drive every branch without Docker.
export function runDemo(opts, { run = (args) => spawnCli(opts.cli, args), state = dockerState, exists = fs.existsSync } = {}) {
  const steps = [];
  const record = (name, ok, detail = {}) => { steps.push({ name, ok, ...detail }); return ok; };
  const runDirArgs = opts.runDir ? ['--run-dir', opts.runDir] : [];
  const fixtureSite = path.join(opts.projectRoot, 'tests', 'fixtures', 'blazor-demo', 'wwwroot');
  const page = (f) => pathToFileURL(path.join(fixtureSite, f)).href;
  const before = opts.dockerCheck ? state() : null;
  const artifacts = [];
  const keep = (r) => { for (const a of r?.artifacts || []) artifacts.push({ run_id: r.run_id, workspace: r.workspace, ...a }); };
  const stable = (r) => !!r && typeof r.workspace === 'string' && path.isAbsolute(r.workspace) && r.cleanup === 'complete';
  const present = (r) => (r.artifacts || []).every((a) => /^[0-9a-f]{64}$/.test(a.sha256) && a.bytes > 0 && exists(path.join(r.workspace, a.path)));

  // 1. Compile through the shared SDK runner (positive).
  const build = run(['dotnet', 'build', '--sdk', opts.sdk, '--project', path.join(opts.projectRoot, 'tests', 'fixtures', 'dotnet', 'Blazor'), ...runDirArgs]);
  record('dotnet build of the Blazor component library', build.code === 0 && build.result?.status === 'passed' && stable(build.result), { exit: build.code, message: build.result?.message });
  keep(build.result);

  // 2. Tests. Needs the xunit packages in the offline NuGet cache (docs/dotnet-testing.md); until then this is recorded as blocked, not passed.
  const test = run(['dotnet', 'test', '--sdk', opts.sdk, '--project', path.join(opts.projectRoot, 'tests', 'fixtures', 'dotnet', 'Tests'), ...runDirArgs]);
  const testOk = test.code === 0 && test.result?.status === 'passed' && test.result?.cleanup === 'complete';
  // Only the known offline-restore case is blocked: nothing ran (exit 1, failed, no test summary) and cleanup completed.
  // Real test failures, infrastructure/environment faults (exit 3/4/6/7) and incomplete cleanup are failures (D-017).
  const testBlocked = !testOk && test.code === 1 && test.result?.status === 'failed' && test.result?.data?.summary?.tests === null && test.result?.cleanup === 'complete';
  record('dotnet test of the component', testOk || (testBlocked && !opts.requireTests), { exit: test.code, result: testOk ? 'passed' : testBlocked ? 'blocked' : 'failed', required: opts.requireTests, message: test.result?.message });
  keep(test.result);

  // 3. Browser runner against the sample page: screenshots at two profiles (positive).
  const shots = [];
  for (const profile of ['desktop', 'phone']) {
    const s = run(['web', 'screenshot', '--url', page('index.html'), '--root', fixtureSite, '--profile', profile, ...runDirArgs]);
    const shot = (s.result?.artifacts || []).find((a) => a.kind === 'screenshot');
    record(`screenshot ${profile}`, s.code === 0 && stable(s.result) && !!shot && present(s.result), { exit: s.code, message: s.result?.message });
    keep(s.result); shots.push(s.result);
  }

  // 4. Responsive assertions across the standard profiles (positive).
  const resp = run(['web', 'responsive', '--url', page('index.html'), '--root', fixtureSite, '--profiles', 'standard', ...runDirArgs]);
  record('responsive assertions at the standard profiles', resp.code === 0 && stable(resp.result) && present(resp.result) && (resp.result?.artifacts || []).filter((a) => a.kind === 'screenshot').length === 8, { exit: resp.code, message: resp.result?.message });
  keep(resp.result);

  // 5. Negative cases: a page with real defects must fail as a subject failure (exit 1), not pass and not look like an infrastructure fault.
  const brokenSite = path.join(opts.projectRoot, 'browser', 'fixture');
  const broken = run(['web', 'screenshot', '--url', pathToFileURL(path.join(brokenSite, 'broken.html')).href, '--root', brokenSite, '--profile', 'desktop', ...runDirArgs]);
  record('negative: broken page is a subject failure (exit 1)', broken.code === 1 && broken.result?.status === 'failed', { exit: broken.code });
  const refused = run(['web', 'screenshot', '--url', 'http://127.0.0.1:5000/', '--profile', 'desktop', ...runDirArgs]);
  record('negative: a TCP/network URL is refused before anything starts (exit 4, OQ-2)', refused.code === 4 && refused.result?.status === 'refused', { exit: refused.code });

  // 6. Stable artifact locations: every artifact path is under its run's workspace, and run ids are unique.
  const ids = new Set(artifacts.map((a) => a.run_id));
  const all = [build, test, ...shots.map((r) => ({ result: r })), resp].map((x) => x.result).filter(Boolean);
  record('each run has its own evidence directory', new Set(all.map((r) => r.workspace)).size === all.length && ids.size >= 1, { runs: all.length });

  // 7. Nothing left running.
  if (opts.dockerCheck) {
    const after = state();
    record('no container or loop device left behind', after.containers === before.containers && after.loops === before.loops, { before, after });
  }
  const ok = steps.every((s) => s.ok);
  return { schema_version: 1, ok, steps, artifacts: artifacts.map(({ run_id, workspace, kind, path: p, sha256, bytes }) => ({ run_id, workspace, kind, path: p, sha256, bytes })) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let opts;
  try { opts = parseDemoArgs(process.argv.slice(2)); } catch (e) { console.error(`blazor-demo: ${e.message}`); process.exit(2); }
  const out = runDemo(opts);
  for (const s of out.steps) console.error(`${s.ok ? 'ok  ' : 'FAIL'} ${s.name}${s.result === 'blocked' ? ' (tests blocked, not claimed)' : ''}`);
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
