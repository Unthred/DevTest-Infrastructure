import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { main } from '../cli/main.mjs';
import { parseArgs, parseDuration, UsageError, COMMANDS } from '../cli/args.mjs';
import { REPO_ROOT } from '../cli/config.mjs';
import { shortMkdtemp } from './_short-tmp.mjs';
import { buildPlanForVerifiedPaths } from '../docker/runner.mjs';

const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
const limits = { cpus: 1, memoryMb: 1024, pids: 128, shmMb: 64, timeoutMs: 120000, diskMb: 128, cacheMb: 64 };
const sink = () => { const chunks = []; return { write: (c) => chunks.push(c), text: () => chunks.join('') }; };

function sandbox(t, extra = {}) {
  const root = fs.realpathSync(shortMkdtemp('dtc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const storage = path.join(root, 's'); fs.mkdirSync(storage, { mode: 0o700 });
  const project = path.join(root, 'proj'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'App.csproj'), '<Project />');
  fs.writeFileSync(path.join(project, 'page.html'), '<p>hi</p>');
  const configFile = path.join(root, 'runner.json');
  const config = { allowedProjects: [project, REPO_ROOT], storageRoot: storage, uid: 99, gid: 100, limits, ...extra };
  fs.writeFileSync(configFile, JSON.stringify(config));
  return { root, storage, project, config, env: { DEV_TEST_CONFIG: configFile } };
}

function markRestored(sb) {
  fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.restored.json'), JSON.stringify({ package: 'playwright-core', version: lock.packages['playwright-core'].version, axeCore: lock.packages['axe-core'].version }));
}

// Runs the CLI with fakes for Docker and the runner. `runner(plan, opts)` stands in for runContainer.
async function run(sb, argv, { runner, docker, files, startTarget } = {}) {
  const calls = { runs: [], docker: [], targets: [] };
  const deps = {
    docker: docker ?? ((args) => { calls.docker.push(args); return { status: 0, stdout: 'x', stderr: '' }; }),
    createPlan: (spec, cfg) => buildPlanForVerifiedPaths({ ...spec }, { ...cfg, lock }, spec.project, sb.storage),
    runContainer: async (plan, opts) => {
      calls.runs.push(plan);
      if (files) { fs.mkdirSync(plan.out, { recursive: true }); for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(plan.out, n), c); }
      return runner ? runner(plan, opts) : { runId: plan.runId, image: plan.image, exitCode: 0, subjectExit: 0, cleanup: 'complete', reason: null };
    },
    releaseVolumes: () => {}, sweep: () => ({}), mounts: () => '', commit: () => 'a'.repeat(40),
    startTarget: startTarget ?? (async (root, socket) => { calls.targets.push({ root, socket }); return { close: async () => {} }; }),
    health: async () => ({ reachable: true, initialized: true, sealed: false, version: '2' })
  };
  const stdout = sink(), stderr = sink();
  const code = await main(argv, { env: sb.env, deps, stdout, stderr, cwd: sb.root });
  let result = null; try { result = JSON.parse(stdout.text()); } catch { /* human mode */ }
  return { code, result, stdout: stdout.text(), stderr: stderr.text(), calls };
}

test('contract: CLI exit codes match contracts/cli.v1.json', async () => {
  const { EXIT } = await import('../cli/main.mjs');
  const contract = JSON.parse(fs.readFileSync(new URL('../contracts/cli.v1.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.values(EXIT).sort((a, b) => a - b), contract.exit_codes.map((c) => c.code).sort((a, b) => a - b));
  assert.deepEqual(Object.keys(COMMANDS).sort(), contract.commands.map((c) => c.name).sort());
});

test('arguments: positive parsing and global options', () => {
  const p = parseArgs(['dotnet', 'test', '--sdk', '9', '--project', 'a b/c d.csproj', '--coverage', '--json', '--timeout', '5m']);
  assert.equal(p.command, 'dotnet test');
  assert.equal(p.options['--project'], 'a b/c d.csproj');   // spaces survive: separate argv entries, no shell
  assert.equal(p.options['--coverage'], true);
  assert.equal(p.global.json, true);
  assert.equal(p.global.timeoutMs, 300000);
  assert.deepEqual(parseArgs(['web', 'responsive', '--url', 'u', '--profiles', 'standard', '--assert', 'clipped', '--assert', 'chips-wrapped']).options['--assert'], ['clipped', 'chips-wrapped']);
  assert.equal(parseArgs(['help', 'dotnet', 'build']).positionals.join(' '), 'dotnet build');
  assert.equal(parseDuration('2h'), 7200000);
});

test('arguments: negative cases are usage errors', () => {
  const bad = [
    [['frobnicate']], [['dotnet']], [['dotnet', 'build', '--sdk', '7', '--project', 'x']], [['dotnet', 'build', '--sdk', '8']],
    [['dotnet', 'build', '--sdk', '8', '--project']], [['dotnet', 'build', '--sdk', '8', '--project', '--json']], [['dotnet', 'build', '--sdk=8', '--project', 'x']],
    [['dotnet', 'build', '--sdk', '8', '--sdk', '9', '--project', 'x']], [['dotnet', 'build', '--sdk', '8', '--project', 'x', '--coverage']],
    [['web', 'screenshot', '--url', 'file:///x', '--profile', 'nope']], [['web', 'responsive', '--url', 'u', '--profiles', 'phone-360,phone-360']],
    [['web', 'responsive', '--url', 'u', '--profiles', 'standard', '--assert', 'made-up']], [['report']], [['report', 'a', 'b']],
    [['cleanup', '--run-id', 'not-hex']], [['cleanup', '--older-than', 'soon']], [['version', '--timeout', '0']], [['version', '--bogus']],
    [['dotnet', 'build', '--sdk', '8', '--project', 'a\nb']]
  ];
  for (const [argv] of bad.map((b) => [b[0]])) assert.throws(() => parseArgs(argv), UsageError, JSON.stringify(argv));
});

test('version, help and --json: one JSON object on stdout, human text on stderr', async (t) => {
  const sb = sandbox(t);
  const v = await run(sb, ['version', '--json']);
  assert.equal(v.code, 0);
  assert.equal(v.stdout.trim().split('\n').length, 1);
  for (const f of ['schema_version', 'run_id', 'command', 'status', 'exit_code', 'started_at', 'ended_at', 'workspace', 'artifacts', 'cleanup']) assert.ok(f in v.result, f);
  assert.match(v.stderr, /dev-test version: passed/);
  const human = await run(sb, ['version']);
  assert.equal(human.stdout, '');
  const h = await run(sb, ['help', 'web', 'responsive', '--json']);
  assert.equal(h.result.data.usage[0].command, 'web responsive');
  const bad = await run(sb, ['nope', '--json']);
  assert.equal(bad.code, 2); assert.equal(bad.result.status, 'error');
});

test('doctor: ok, then Docker missing, image missing and OpenBao states', async (t) => {
  const sb = sandbox(t);
  const ok = await run(sb, ['doctor', '--json']);
  assert.equal(ok.code, 0);
  assert.ok(ok.result.data.checks.some((c) => c.name === 'docker' && c.status === 'ok'));
  const noDocker = await run(sb, ['doctor', '--json'], { docker: () => ({ status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) }) });
  assert.equal(noDocker.code, 3);
  assert.match(noDocker.result.data.checks.find((c) => c.name === 'docker').detail, /not found/);
  const noImage = await run(sb, ['doctor', '--json'], { docker: (a) => ({ status: a[0] === 'image' ? 1 : 0, stdout: '' }) });
  assert.equal(noImage.code, 3);
  assert.ok(noImage.result.data.checks.some((c) => c.name === 'image playwright' && c.status === 'fail'));
  const bao = sandbox(t, { openbao: { address: 'http://127.0.0.1:8200' } });
  const withBao = await run(bao, ['doctor', '--json']);
  assert.equal(withBao.result.data.checks.find((c) => c.name === 'openbao').status, 'ok');
  assert.ok(!JSON.stringify(withBao.result).includes('token'));
  const noConfig = await run({ ...sb, env: { DEV_TEST_CONFIG: path.join(sb.root, 'missing.json') } }, ['doctor', '--json']);
  assert.equal(noConfig.code, 3);
});

test('dotnet build: pass, subject failure, timeout, runner fault, and the argv is never shell-built', async (t) => {
  const sb = sandbox(t);
  const ok = await run(sb, ['dotnet', 'build', '--sdk', '9', '--project', sb.project, '--json']);
  assert.equal(ok.code, 0);
  assert.equal(ok.result.status, 'passed');
  assert.match(ok.result.image.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(ok.result.source_commit, 'a'.repeat(40));
  const plan = ok.calls.runs[0];
  assert.equal(plan.image, lock.images['dotnet-9'].reference);
  assert.ok(plan.args.includes('--network=none') && plan.args.includes('--cap-drop=ALL') && !plan.args.some((a) => /docker\.sock|privileged/.test(a)));
  assert.ok(fs.existsSync(path.join(ok.result.workspace, 'result.json')));
  assert.equal(fs.existsSync(plan.workspace), false, 'run workspace removed');
  const mk = (exitCode, extra = {}) => ({ runner: (p) => ({ runId: p.runId, exitCode, subjectExit: 1, cleanup: 'complete', ...extra }) });
  assert.equal((await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--json'], mk(1))).code, 1);
  assert.equal((await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--json'], mk(5))).result.status, 'timeout');
  assert.equal((await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--json'], mk(6))).code, 6);
  assert.equal((await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--json'], mk(130))).result.status, 'interrupted');
  assert.equal((await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--json'], mk(7, { cleanup: 'incomplete' }))).code, 7);
  const both = await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--json'], mk(0));
  assert.notEqual(both.result.run_id, ok.result.run_id, 'every run has its own id and workspace');
});

test('dotnet: refusals and environment errors start nothing', async (t) => {
  const sb = sandbox(t);
  const outside = await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', os.tmpdir(), '--json']);
  assert.equal(outside.code, 4); assert.equal(outside.calls.runs.length, 0);
  assert.equal((await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', path.join(sb.project, 'missing.csproj'), '--json'])).code, 2);
  const noDocker = await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--json'], { docker: () => ({ status: 1, stderr: 'daemon' }) });
  assert.equal(noDocker.code, 3); assert.match(noDocker.result.message, /Docker is unavailable/); assert.equal(noDocker.calls.runs.length, 0);
  const noImage = await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--json'], { docker: (a) => ({ status: a[0] === 'image' ? 1 : 0 }) });
  assert.equal(noImage.code, 3); assert.match(noImage.result.message, /not present locally/);
  const tooLong = await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--timeout', '2h', '--json']);
  assert.equal(tooLong.code, 4);
  // A symlink inside the project that leaves the allowlist is not followed.
  fs.symlinkSync(os.tmpdir(), path.join(sb.project, 'escape'));
  assert.equal((await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', path.join(sb.project, 'escape'), '--json'])).code, 4);
  assert.equal(fs.existsSync(path.join(sb.storage, 'evidence')) ? fs.readdirSync(path.join(sb.storage, 'evidence')).length : 0, 0, 'no run directory for a refused request');
});

test('dotnet test: result carries TRX summary and exit mapping; timeout override reaches the plan', async (t) => {
  const sb = sandbox(t);
  const trx = `<?xml version="1.0"?><TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010"><ResultSummary outcome="Completed"><Counters total="2" executed="2" passed="1" failed="1"/></ResultSummary><Results><UnitTestResult testName="N.C.A" outcome="Passed" duration="00:00:00.1"/><UnitTestResult testName="N.C.B" outcome="Failed" duration="00:00:00.1"/></Results><TestDefinitions><UnitTest name="N.C.A"><TestMethod className="N.C" name="A"/></UnitTest><UnitTest name="N.C.B"><TestMethod className="N.C" name="B"/></UnitTest></TestDefinitions></TestRun>`;
  const r = await run(sb, ['dotnet', 'test', '--sdk', '8', '--project', sb.project, '--timeout', '90s', '--json'], {
    runner: (p) => { fs.mkdirSync(path.join(p.out, 'results'), { recursive: true }); fs.writeFileSync(path.join(p.out, 'results', 'x.trx'), trx); return { runId: p.runId, exitCode: 1, subjectExit: 1, cleanup: 'complete' }; }
  });
  assert.equal(r.code, 1);
  assert.equal(r.result.command, 'dotnet test');
  assert.ok(r.result.artifacts.some((a) => a.kind === 'trx' && /^[0-9a-f]{64}$/.test(a.sha256)));
  assert.equal(r.result.data.summary.tests.failed, 1);
  assert.equal(r.calls.runs[0].timeoutMs, 90000);
  assert.ok(r.calls.runs[0].args.includes('--results-directory') || r.calls.runs[0].args.includes('/out/results'));
  const stored = JSON.parse(fs.readFileSync(path.join(r.result.workspace, 'result.json'), 'utf8'));
  assert.equal(stored.source_commit, 'a'.repeat(40));
});

const REPORT_OK = JSON.stringify({ schema_version: 1, ok: true, problems: [] });
test('web screenshot: positive run, target served from the page directory, no .NET image involved', async (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.storage, 'cache')); fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.img'), ''); markRestored(sb);
  const url = pathToFileURL(path.join(sb.project, 'page.html')).href;
  const r = await run(sb, ['web', 'screenshot', '--url', url, '--profile', 'phone-390', '--browser', 'firefox', '--json'], { files: { 'shot-phone-390-firefox.png': 'PNG', 'shot-phone-390-firefox.report.json': REPORT_OK } });
  assert.equal(r.code, 0);
  assert.deepEqual(r.result.artifacts.map((a) => a.kind), ['screenshot', 'metadata']);
  const plan = r.calls.runs[0];
  assert.equal(plan.image, lock.images.playwright.reference);
  assert.ok(!plan.args.some((a) => /dotnet/i.test(a)), 'browser run does not involve the .NET SDK');
  assert.deepEqual(plan.targets.map((x) => x.name), ['page']);
  assert.equal(r.calls.targets[0].root, sb.project);
  const i = plan.args.indexOf('/src/browser/capture.mjs');
  assert.deepEqual(plan.args.slice(i - 1, i + 1), ['node', '/src/browser/capture.mjs']);
  assert.ok(plan.args.join(' ').includes('--path /page.html'));
});

test('web: policy refusals start nothing and leak no secret', async (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.storage, 'cache')); fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.img'), ''); markRestored(sb);
  const secret = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz012345'].join('_');
  const cases = [
    ['http://192.168.1.5:8123/', /not offered/],
    ['https://user:pw@example.test/', /credentials/],
    [`file://${sb.project}/page.html?access_token=${secret}`, /credential/],
    [`file://${sb.project}/page.html#id=${secret}`, /credential/],
    ['file:///etc/passwd', /allowlisted/]
  ];
  for (const [url, re] of cases) {
    const r = await run(sb, ['web', 'screenshot', '--url', url, '--profile', 'desktop', '--json']);
    assert.equal(r.code, 4, url); assert.match(r.result.message, re); assert.equal(r.calls.runs.length, 0);
    assert.ok(!r.stdout.includes(secret) && !r.stderr.includes(secret), 'the secret is not echoed');
  }
  assert.equal((await run(sb, ['web', 'screenshot', '--url', 'ftp://x/', '--profile', 'desktop', '--json'])).code, 2);
  assert.equal((await run(sb, ['web', 'screenshot', '--url', 'not a url', '--profile', 'desktop', '--json'])).code, 2);
  const symlink = path.join(sb.project, 'link.html'); fs.symlinkSync('/etc/passwd', symlink);
  assert.equal((await run(sb, ['web', 'screenshot', '--url', pathToFileURL(symlink).href, '--profile', 'desktop', '--json'])).code, 4, 'symlink to outside is resolved, then refused');
  const rootOut = await run(sb, ['web', 'screenshot', '--url', pathToFileURL(path.join(sb.project, 'page.html')).href, '--root', os.tmpdir(), '--profile', 'desktop', '--json']);
  assert.equal(rootOut.code, 4);
  const noCache = fs.rmSync(path.join(sb.storage, 'cache', 'playwright.img')) ?? await run(sb, ['web', 'screenshot', '--url', pathToFileURL(path.join(sb.project, 'page.html')).href, '--profile', 'desktop', '--json']);
  assert.equal(noCache.code, 3); assert.match(noCache.result.message, /Playwright cache/);
});

test('an unconfirmed Playwright restore is an environment fault (exit 3), in doctor and in web preflight', async (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.storage, 'cache')); fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.img'), '');
  const url = pathToFileURL(path.join(sb.project, 'page.html')).href;
  const shot = await run(sb, ['web', 'screenshot', '--url', url, '--profile', 'desktop', '--json']);
  assert.equal(shot.code, 3); assert.match(shot.result.message, /restore was never confirmed/); assert.equal(shot.calls.runs.length, 0);
  const doc = await run(sb, ['doctor', '--json']);
  assert.notEqual(doc.result.data.checks.find((c) => c.name === 'cache playwright').status, 'ok');
  fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.restored.json'), JSON.stringify({ package: 'playwright-core', version: '0.0.0' }));
  assert.equal((await run(sb, ['web', 'screenshot', '--url', url, '--profile', 'desktop', '--json'])).code, 3, 'a marker for another version is not ready');
  markRestored(sb);
  assert.equal((await run(sb, ['doctor', '--json'])).result.data.checks.find((c) => c.name === 'cache playwright').status, 'ok');
  // Defence in depth: a wrapper that crashed before testing the page is never reported as a page failure.
  const crashed = await run(sb, ['web', 'screenshot', '--url', url, '--profile', 'desktop', '--json'], { runner: (p) => ({ runId: p.runId, exitCode: 1, subjectExit: 10, cleanup: 'complete' }), files: { 'shot-desktop-chromium.png': 'PNG', 'shot-desktop-chromium.report.json': JSON.stringify({ problems: ['capture failed: Cannot find module /cache/package/index.mjs'] }) } });
  assert.equal(crashed.code, 6);
});

test('web exit mapping: page problems, blocked requests and wrapper faults', async (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.storage, 'cache')); fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.img'), ''); markRestored(sb);
  const url = pathToFileURL(path.join(sb.project, 'page.html')).href;
  const withWrapper = (subjectExit) => ({ runner: (p) => ({ runId: p.runId, exitCode: 1, subjectExit, cleanup: 'complete' }), files: { 'shot-desktop-chromium.png': 'PNG', 'shot-desktop-chromium.report.json': JSON.stringify({ problems: ['the page tried to reach an undeclared destination'], blockedRequests: ['http://x/y'] }) } });
  for (const [wrapper, code] of [[10, 1], [11, 1], [12, 1], [13, 1], [15, 1], [2, 6], [14, 6], [137, 6]]) {
    const r = await run(sb, ['web', 'screenshot', '--url', url, '--profile', 'desktop', '--json'], withWrapper(wrapper));
    assert.equal(r.code, code, `wrapper ${wrapper}`);
    assert.equal(r.result.data.wrapper_exit, wrapper);
  }
  const ok = await run(sb, ['web', 'screenshot', '--url', url, '--profile', 'desktop', '--json'], { files: {} });
  assert.equal(ok.code, 6, 'success without a screenshot is not a pass');
  const incomplete = await run(sb, ['web', 'screenshot', '--url', url, '--profile', 'desktop', '--json'], { runner: (p) => ({ runId: p.runId, exitCode: 7, cleanup: 'incomplete' }) });
  assert.equal(incomplete.code, 7);
});

test('web responsive: --assert limits which rules fail the run; unrendered profiles always fail', async (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.storage, 'cache')); fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.img'), ''); markRestored(sb);
  const url = pathToFileURL(path.join(sb.project, 'page.html')).href;
  const summary = (rendered = true) => JSON.stringify({ profiles: [{ profile: 'phone-360', rendered, failures: 2, warnings: 0 }], failures: [{ profile: 'phone-360', check: 'clipped', element: 'div[1]' }, { profile: 'phone-360', check: 'chips-wrapped', element: 'ul[2]' }], blockedRequests: [] });
  const fake = (rendered) => ({ runner: (p) => ({ runId: p.runId, exitCode: 1, subjectExit: 15, cleanup: 'complete' }), files: { 'audit.summary.json': summary(rendered), 'audit.report.md': '# r', 'audit-phone-360-chromium.png': 'PNG' } });
  const all = await run(sb, ['web', 'responsive', '--url', url, '--profiles', 'phone-360', '--json'], fake(true));
  assert.equal(all.code, 1); assert.equal(all.result.data.failures.length, 2);
  const one = await run(sb, ['web', 'responsive', '--url', url, '--profiles', 'phone-360', '--assert', 'clipped', '--json'], fake(true));
  assert.equal(one.code, 1); assert.deepEqual(one.result.data.failures.map((f) => f.check), ['clipped']); assert.equal(one.result.data.ignored_failures, 1);
  const none = await run(sb, ['web', 'responsive', '--url', url, '--profiles', 'phone-360', '--assert', 'truncated', '--json'], fake(true));
  assert.equal(none.code, 0); assert.equal(none.result.data.ignored_failures, 2);
  const unrendered = await run(sb, ['web', 'responsive', '--url', url, '--profiles', 'phone-360', '--assert', 'truncated', '--json'], fake(false));
  assert.equal(unrendered.code, 1, 'a profile that did not render cannot pass');
  assert.ok(none.calls.runs[0].args.includes('/src/browser/responsive.mjs'));
});

test('web ha: the fixture run maps summary, exit 16 and the read-only counts; no URL argument exists', async (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.storage, 'cache')); fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.img'), ''); markRestored(sb);
  const summary = (extra = {}) => JSON.stringify({ pageSet: 'fixture', pages: [{ page: 'dashboard', profiles: [{ profile: 'phone-390', rendered: true, failures: 0, warnings: 1 }], failures: [] }],
    readOnly: { blockedWrites: [], blockedFrames: [], blockedInteractions: ['click:button'] }, probe: { mode: 'clicks', attempted: 3, blocked: 3, mutated: 0 }, blockedRequests: [], ...extra });
  const files = (s) => ({ 'ha.summary.json': s, 'ha.report.md': '# r', 'ha-dashboard-phone-390-chromium.png': 'PNG' });
  const ok = await run(sb, ['web', 'ha', '--json'], { files: files(summary()) });
  assert.equal(ok.code, 0); assert.match(ok.result.message, /not the live Home Assistant/);
  { const a = ok.calls.runs[0].args; assert.equal(a[a.indexOf('--page-set') + 1], 'fixture'); }
  assert.ok(ok.calls.runs[0].args.includes('/src/browser/ha-readonly.mjs') && ok.calls.runs[0].args.includes('clicks'));
  assert.equal(ok.calls.targets[0].root, path.join(REPO_ROOT, 'browser', 'fixture', 'ha'), 'only the fixture directory is served');
  assert.equal(ok.result.data.read_only.blocked_interactions, 1);
  const wrote = await run(sb, ['web', 'ha', '--json'], { runner: (p) => ({ runId: p.runId, exitCode: 1, subjectExit: 16, cleanup: 'complete' }), files: files(summary({ readOnly: { blockedWrites: ['POST http://127.0.0.1:1/api/x'], blockedFrames: [], blockedInteractions: [] } })) });
  assert.equal(wrote.code, 1); assert.match(wrote.result.message, /tried to change state/); assert.equal(wrote.result.data.read_only.blocked_writes, 1);
  const layout = await run(sb, ['web', 'ha', '--json'], { runner: (p) => ({ runId: p.runId, exitCode: 1, subjectExit: 15, cleanup: 'complete' }), files: files(summary()) });
  assert.equal(layout.code, 1);
  assert.equal((await run(sb, ['web', 'ha', '--url', 'http://home.yeradonkey.com/', '--json'])).code, 2, 'no URL option: a live address cannot be passed in');
  assert.equal((await run(sb, ['web', 'ha', '--browser', 'ie', '--json'])).code, 2);
});

test('web ha --live: blocked with reasons, nothing started, nothing contacted', async (t) => {
  const sb = sandbox(t);
  const policy = path.join(sb.root, 'policy.json');
  fs.copyFileSync(new URL('../broker/policy.example.json', import.meta.url), policy);
  fs.writeFileSync(sb.env.DEV_TEST_CONFIG, JSON.stringify({ ...sb.config, openbao: { address: 'http://127.0.0.1:8200', policyFile: policy } }));
  const r = await run(sb, ['web', 'ha', '--live', '--json']);
  assert.equal(r.code, 4); assert.equal(r.result.status, 'refused');
  assert.equal(r.result.data.live.status, 'blocked'); assert.equal(r.result.data.live.host, 'home.yeradonkey.com');
  assert.ok(r.result.data.live.reasons.some((x) => /OQ-2/.test(x)) && r.result.data.live.reasons.some((x) => /devtest- identity/.test(x)));
  assert.deepEqual([r.calls.runs.length, r.calls.targets.length, r.calls.docker.length], [0, 0, 0]);
  assert.match(r.result.message, /BLOCKED/); assert.match(r.result.message, /no success is claimed/);
  // no policy configured, or an unreadable one, is also blocked and says so
  fs.writeFileSync(sb.env.DEV_TEST_CONFIG, JSON.stringify(sb.config));
  const none = await run(sb, ['web', 'ha', '--live', '--json']);
  assert.equal(none.code, 4); assert.ok(none.result.data.live.reasons.some((x) => /no OpenBao credential policy/.test(x)));
  fs.writeFileSync(sb.env.DEV_TEST_CONFIG, JSON.stringify({ ...sb.config, openbao: { policyFile: path.join(sb.root, 'missing.json') } }));
  assert.ok((await run(sb, ['web', 'ha', '--live', '--json'])).result.data.live.reasons.some((x) => /unreadable/.test(x)));
});

test('report: shows a stored result; unknown or malformed ids are errors', async (t) => {
  const sb = sandbox(t);
  const built = await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--json']);
  const rep = await run(sb, ['report', built.result.run_id, '--json']);
  assert.equal(rep.code, 0);
  assert.equal(rep.result.data.stored.run_id, built.result.run_id);
  assert.equal((await run(sb, ['report', 'f'.repeat(16), '--json'])).code, 2);
  assert.equal((await run(sb, ['report', '../../etc', '--json'])).code, 2);
  fs.writeFileSync(path.join(built.result.workspace, 'result.json'), '{broken');
  assert.equal((await run(sb, ['report', built.result.run_id, '--json'])).code, 6);
  const custom = path.join(sb.root, 'elsewhere');
  const moved = await run(sb, ['dotnet', 'build', '--sdk', '8', '--project', sb.project, '--run-dir', custom, '--json']);
  assert.ok(moved.result.workspace.startsWith(custom));
  assert.equal((await run(sb, ['report', moved.result.run_id, '--run-dir', custom, '--json'])).code, 0);
  assert.equal((await run(sb, ['report', moved.result.run_id, '--json'])).code, 2, 'looks only in the selected run directory');
});

test('cleanup: removes idle workspaces, never evidence unless named, skips busy ones, honours --dry-run', async (t) => {
  const sb = sandbox(t);
  const idle = { docker: (a) => ({ status: a[0] === 'container' ? 1 : 0, stdout: '' }) };
  const ids = ['1'.repeat(16), '2'.repeat(16), '3'.repeat(16)];
  for (const id of ids) fs.mkdirSync(path.join(sb.storage, 'runs', id, 'volume'), { recursive: true });
  const old = new Date(Date.now() - 3 * 86400000);
  fs.utimesSync(path.join(sb.storage, 'runs', ids[0]), old, old);
  fs.mkdirSync(path.join(sb.storage, 'runs', 'not-a-run'));
  const evidence = path.join(sb.storage, 'evidence', `20261101T000000Z-${ids[0]}`);
  fs.mkdirSync(evidence, { recursive: true });
  const dry = await run(sb, ['cleanup', '--dry-run', '--json'], idle);
  assert.equal(dry.result.data.entries.length, 3);
  assert.ok(dry.result.data.entries.every((e) => e.action === 'would_remove'));
  assert.ok(fs.existsSync(path.join(sb.storage, 'runs', ids[1])), 'dry run removes nothing');
  const older = await run(sb, ['cleanup', '--older-than', '1d', '--json'], idle);
  assert.deepEqual(older.result.data.entries.map((e) => e.run_id), [ids[0]]);
  assert.ok(fs.existsSync(evidence), 'evidence untouched by --older-than');
  // A container with the run id exists: the workspace is kept, and a named run that cannot be removed is exit 7.
  const busy = await run(sb, ['cleanup', '--run-id', ids[1], '--json'], { docker: (a) => ({ status: a[0] === 'container' && a.at(-1) === `devtest-${ids[1]}` ? 0 : a[0] === 'container' ? 1 : 0 }) });
  assert.equal(busy.code, 7);
  assert.ok(fs.existsSync(path.join(sb.storage, 'runs', ids[1])));
  // A volume that is still mounted is never deleted.
  const mounted = await run(sb, ['cleanup', '--run-id', ids[2], '--json'], idle);
  assert.equal(mounted.code, 0);
  const named = await run(sb, ['cleanup', '--run-id', ids[0], '--json'], idle);
  assert.equal(named.code, 0);
  assert.equal(fs.existsSync(evidence), false, 'named evidence removed');
  assert.ok(fs.existsSync(path.join(sb.storage, 'runs', 'not-a-run')), 'entries that are not run workspaces are left alone');
  const all = await run(sb, ['cleanup', '--json'], idle);
  assert.equal(all.code, 0);
  assert.ok(!fs.existsSync(path.join(sb.storage, 'runs', ids[1])));
});

test('cleanup never removes a workspace whose volume is mounted', async (t) => {
  const sb = sandbox(t);
  const id = 'b'.repeat(16);
  fs.mkdirSync(path.join(sb.storage, 'runs', id, 'volume'), { recursive: true });
  const mountLine = `/dev/loop9 ${path.join(sb.storage, 'runs', id, 'volume')} ext4 rw 0 0\n`;
  const r = await main(['cleanup', '--run-id', id, '--json'], { env: sb.env, cwd: sb.root, stdout: sink(), stderr: sink(),
    deps: { docker: (a) => ({ status: a[0] === 'container' ? 1 : 0 }), mounts: () => mountLine, sweep: () => {} } });
  assert.equal(r, 7);
  assert.ok(fs.existsSync(path.join(sb.storage, 'runs', id)));
});

test('cleanup without Docker cannot verify idle workspaces: environment error, nothing removed', async (t) => {
  const sb = sandbox(t);
  const id = 'a'.repeat(16);
  fs.mkdirSync(path.join(sb.storage, 'runs', id), { recursive: true });
  const r = await run(sb, ['cleanup', '--json'], { docker: () => ({ status: 1 }) });
  assert.equal(r.code, 3);
  assert.ok(fs.existsSync(path.join(sb.storage, 'runs', id)));
});

test('interrupt and timeout statuses come from the runner and reach the result', async (t) => {
  const sb = sandbox(t);
  const r = await run(sb, ['dotnet', 'test', '--sdk', '8', '--project', sb.project, '--json'], { runner: (p) => ({ runId: p.runId, exitCode: 130, cleanup: 'complete' }) });
  assert.equal(r.code, 130); assert.equal(r.result.status, 'interrupted');
  const t5 = await run(sb, ['dotnet', 'test', '--sdk', '8', '--project', sb.project, '--json'], { runner: (p) => ({ runId: p.runId, exitCode: 5, cleanup: 'complete' }) });
  assert.equal(t5.code, 5); assert.equal(t5.result.status, 'timeout');
});

// ---- web a11y (issue #455)
const a11ySummary = (over = {}) => JSON.stringify({ axe_version: '4.14.0', tags: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'], violation_nodes: 3, incomplete_nodes: 1, limitation: 'Automated checks (axe-core) find only some accessibility problems.',
  profiles: [{ profile: 'phone-390', scanned: true, violations: [{ id: 'image-alt', impact: 'critical', nodeCount: 2, nodes: ['body[0]>img[1]'] }, { id: 'label', impact: 'critical', nodeCount: 1, nodes: [] }], incomplete: [{ id: 'color-contrast', impact: 'serious', nodeCount: 1, nodes: [] }] }], ...over });
test('web a11y: needs --url and --profiles, rejects unknown profiles, and runs a11y.mjs with the profile list', async (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.storage, 'cache')); fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.img'), ''); markRestored(sb);
  const url = pathToFileURL(path.join(sb.project, 'page.html')).href;
  assert.equal((await run(sb, ['web', 'a11y', '--profiles', 'phone-390', '--json'])).code, 2);
  assert.equal((await run(sb, ['web', 'a11y', '--url', url, '--json'])).code, 2);
  assert.equal((await run(sb, ['web', 'a11y', '--url', url, '--profiles', 'nope', '--json'])).code, 2);
  const ok = await run(sb, ['web', 'a11y', '--url', url, '--profiles', 'phone-390,desktop-1440', '--json'], { files: { 'a11y.summary.json': a11ySummary({ violation_nodes: 0, profiles: [] }), 'a11y.report.md': '# r' } });
  assert.equal(ok.code, 0); assert.match(ok.result.message, /do not cover everything/);
  const args = ok.calls.runs[0].args;
  assert.ok(args.includes('/src/browser/a11y.mjs') && args.includes('--profiles') && args.includes('phone-390,desktop-1440') && args.includes('--network=none'));
  assert.equal((await run(sb, ['web', 'a11y', '--url', url, '--profiles', 'phone-390', '--json'], { files: {} })).code, 6, 'success without a scan summary is not a pass');
});
test('web a11y: violations exit 1 with counts, incomplete results and the limitation; browser failures are not page failures', async (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.storage, 'cache')); fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.img'), ''); markRestored(sb);
  const url = pathToFileURL(path.join(sb.project, 'page.html')).href;
  const wrapper = (subjectExit) => ({ runner: (p) => ({ runId: p.runId, exitCode: 1, subjectExit, cleanup: 'complete' }), files: { 'a11y.summary.json': a11ySummary(), 'a11y.report.md': '# r' } });
  const bad = await run(sb, ['web', 'a11y', '--url', url, '--profiles', 'phone-390', '--json'], wrapper(17));
  assert.equal(bad.code, 1); assert.equal(bad.result.data.wrapper_exit, 17); assert.equal(bad.result.data.violation_elements, 3); assert.equal(bad.result.data.incomplete_elements, 1);
  assert.deepEqual(bad.result.data.profiles[0].violations.map((v) => v.id), ['image-alt', 'label']); assert.deepEqual(bad.result.data.profiles[0].incomplete.map((v) => v.id), ['color-contrast']);
  assert.match(bad.result.message, /3 accessibility violation element\(s\)/); assert.match(bad.result.message, /find only some accessibility problems/);
  assert.equal(JSON.stringify(bad.result).includes('body[0]>img[1]'), false, 'element labels stay in the stored report, not in the CLI result');
  for (const [w, code] of [[12, 1], [14, 6], [2, 6]]) assert.equal((await run(sb, ['web', 'a11y', '--url', url, '--profiles', 'phone-390', '--json'], wrapper(w))).code, code, `wrapper ${w}`);
});
test('web a11y: a cache restored before axe-core was pinned is an environment fault (exit 3) and starts nothing', async (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(path.join(sb.storage, 'cache')); fs.writeFileSync(path.join(sb.storage, 'cache', 'playwright.img'), '');
  const marker = path.join(sb.storage, 'cache', 'playwright.restored.json');
  const url = pathToFileURL(path.join(sb.project, 'page.html')).href;
  fs.writeFileSync(marker, JSON.stringify({ package: 'playwright-core', version: lock.packages['playwright-core'].version }));
  const r = await run(sb, ['web', 'a11y', '--url', url, '--profiles', 'phone-390', '--json']);
  assert.equal(r.code, 3); assert.match(r.result.message, /axe-core/); assert.equal(r.calls.runs.length, 0);
  assert.equal((await run(sb, ['web', 'screenshot', '--url', url, '--profile', 'desktop', '--json'], { files: { 'shot-desktop-chromium.png': 'PNG' } })).code, 0, 'screenshots do not need axe-core');
  fs.writeFileSync(marker, JSON.stringify({ package: 'playwright-core', version: lock.packages['playwright-core'].version, axeCore: '0.0.1' }));
  assert.equal((await run(sb, ['web', 'a11y', '--url', url, '--profiles', 'phone-390', '--json'])).code, 3, 'another axe-core version is not ready');
});
