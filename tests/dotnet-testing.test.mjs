import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCommand, DotnetCommandError } from '../dotnet/commands.mjs';
import { dotnetRunSpec } from '../dotnet/run.mjs';
import { buildPlanForVerifiedPaths } from '../docker/runner.mjs';
import crypto from 'node:crypto';
import { parseTrx, trxToJunit, classify, pruneRuns, runDotnetTests, collectArtifacts, failureReason, sanitizeTrx } from '../dotnet/testing.mjs';

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-dt-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const TRX = (failed) => `<?xml version="1.0"?><TestRun><Results>
<UnitTestResult testName="A.Passes" outcome="Passed" duration="00:00:00.01" />
<UnitTestResult testName="A.Fails &lt;x&gt;" outcome="${failed ? 'Failed' : 'Passed'}" duration="00:00:00.02"><Output><ErrorInfo><Message>Assert.Equal() Failure &amp; more</Message></ErrorInfo></Output></UnitTestResult>
</Results><ResultSummary outcome="Completed"><Counters total="2" executed="2" passed="${failed ? 1 : 2}" failed="${failed ? 1 : 0}" /></ResultSummary></TestRun>`;
// Real argv/mount planning, minus only the host-path boundary checks that need /mnt/user/projects and /mnt/cache.
const planner = (options, config) => { const { spec, command } = dotnetRunSpec(options); return { ...buildPlanForVerifiedPaths(spec, config, options.projectRoot, config.storageRoot), dotnet: command }; };
const COV = '<?xml version="1.0"?><coverage line-rate="0.8125" branch-rate="0"></coverage>';

test('test command adds fixed result flags, optional coverage and a validated filter, for every SDK', () => {
  for (const sdk of ['8', '9', '10']) {
    const c = buildCommand({ sdk, operation: 'test', project: '/src/T.csproj', coverage: true, filter: 'FullyQualifiedName~Counter&Category!=Slow' }).command;
    assert.deepEqual(c.slice(-8), ['--results-directory', '/out/results', '--logger', 'trx;LogFileName=results.trx', '--collect', 'XPlat Code Coverage', '--filter', 'FullyQualifiedName~Counter&Category!=Slow']);
    assert.ok(c.includes(`-p:RestorePackagesPath=/cache/${sdk}`));
  }
  assert.ok(!buildCommand({ sdk: '8', operation: 'test', project: '/src/T.csproj' }).command.includes('--collect'));
});

test('unsafe test options are refused', () => {
  for (const extra of [{ filter: 'x; rm -rf /' }, { filter: '$(id)' }, { filter: 'a\nb' }, { filter: 'a'.repeat(300) }, { coverage: 'yes' }])
    assert.throws(() => buildCommand({ sdk: '8', operation: 'test', project: '/src/T.csproj', ...extra }), DotnetCommandError);
  assert.throws(() => buildCommand({ sdk: '8', operation: 'build', project: '/src/T.csproj', coverage: true }), /only to test/);
});

test('TRX parsing keeps only identifier names and constant failure reasons; JUnit mirrors them', () => {
  const s = parseTrx(TRX(true));
  assert.deepEqual([s.total, s.passed, s.failed], [2, 1, 1]);
  assert.deepEqual(s.results.map(r => r.name), ['A.Passes', 'test-2']);   // 'A.Fails <x>' is not a code identifier
  const bad = s.results.find(r => r.outcome === 'Failed');
  assert.equal(bad.message, 'assertion failed: Assert.Equal');
  const junit = trxToJunit(s, 'T');
  assert.match(junit, /tests="2" failures="1"/);
  assert.match(junit, /<failure message="assertion failed: Assert.Equal"\/>/);
  assert.equal(parseTrx('<nothing/>'), null);
  // Names come from TestDefinitions when present; theory arguments are dropped and repeated names are numbered.
  const defs = '<?xml version="1.0"?><TestRun><Results>' +
    '<UnitTestResult testId="t1" testName="Ns.C.Th(value: &quot;x&quot;)" outcome="Failed" duration="00:00:00.5"><Output><ErrorInfo><Message>Expected: 1\nBut was: 2</Message></ErrorInfo></Output></UnitTestResult>' +
    '<UnitTestResult testId="t1" testName="Ns.C.Th(value: &quot;y&quot;)" outcome="Passed" duration="bogus" />' +
    '<UnitTestResult testName="Ns.C.Plain(a: 1)" outcome="Weird" />' +
    '</Results><TestDefinitions><UnitTest name="x" id="t1"><Execution id="e1" /><TestMethod className="Ns.C" name="Th" /></UnitTest></TestDefinitions>' +
    '<ResultSummary outcome="Failed"><Counters total="3" executed="3" passed="1" failed="1" /></ResultSummary></TestRun>';
  const d = parseTrx(defs);
  assert.deepEqual(d.results.map(r => [r.name, r.outcome, r.duration, r.message]), [
    ['Ns.C.Th', 'Failed', '00:00:00.5', 'assertion failed'], ['Ns.C.Th#2', 'Passed', '', undefined], ['Ns.C.Plain', 'Unknown', '', undefined]]);
  // The rebuilt TRX parses back to the same data.
  assert.deepEqual(parseTrx(sanitizeTrx(defs)), d);
  assert.equal(sanitizeTrx('<nothing/>'), null);
});

test('failure reasons come from a closed vocabulary and never echo the message', () => {
  assert.equal(failureReason('Assert.Equal() Failure: Values differ\nExpected: 2\nActual: 1'), 'assertion failed: Assert.Equal');
  assert.equal(failureReason('Assert.AreEqual failed. Expected:<2>. Actual:<1>.'), 'assertion failed: Assert.AreEqual');
  assert.equal(failureReason('System.InvalidOperationException : boom'), 'exception thrown: InvalidOperationException');
  assert.equal(failureReason('Test execution timed out after 1000 ms'), 'test timed out');
  assert.equal(failureReason(undefined), 'test failed (no message)');
  const canary = 'qz' + 'Canary' + crypto.randomBytes(6).toString('hex');
  const allowed = /^(?:test failed \((?:no message|message not persisted)\)|test timed out|assertion failed(?:: Assert\.[A-Za-z]+)?|exception thrown(?:: [A-Za-z]+Exception)?)$/;
  for (const raw of [canary, `Assert.${canary}() Failure`, `${canary}Exception: x`, `Ns.${canary}.${canary}Exception: x`, `Expected ${canary}\nActual: ${canary}`,
    `timeout ${canary}`, `password=${canary}`, `${canary}: Assert.Equal`]) {
    const r = failureReason(raw);
    assert.match(r, allowed, raw);
    assert.ok(!r.includes(canary), 'echoed ' + raw);
  }
});

test('classification separates subject failure from infrastructure faults', () => {
  const ok = { exitCode: 0, cleanup: 'complete' }, s = parseTrx(TRX(false)), f = parseTrx(TRX(true));
  assert.equal(classify(ok, s, true, true).exit_code, 0);
  assert.equal(classify(ok, s, true, false).exit_code, 1);
  assert.equal(classify(ok, null, false, false).exit_code, 1);
  assert.equal(classify(ok, { total: 0, results: [] }, false, false).exit_code, 1);
  assert.equal(classify({ exitCode: 1, cleanup: 'complete' }, f, false, false).exit_code, 1);
  assert.equal(classify({ exitCode: 1, cleanup: 'complete' }, null, false, false).exit_code, 1);
  assert.equal(classify({ exitCode: 5, cleanup: 'complete' }, null, false, false).status, 'timeout');
  assert.equal(classify({ exitCode: 6, cleanup: 'complete' }, null, false, false).exit_code, 6);
  assert.equal(classify({ exitCode: 0, cleanup: 'incomplete' }, s, false, false).exit_code, 7);
  assert.equal(classify({ exitCode: 130, cleanup: 'complete' }, null, false, false).exit_code, 130);
});

test('retention keeps the newest runs, never touches other entries, rejects bad limits', t => {
  const root = tmp(t);
  const names = [1, 2, 3, 4].map(i => `2026103${i}T000000Z-${'a'.repeat(15)}${i}`);
  for (const n of names) fs.mkdirSync(path.join(root, n));
  fs.mkdirSync(path.join(root, 'evidence-keep'));
  fs.writeFileSync(path.join(root, 'note.txt'), 'x');
  fs.symlinkSync(os.tmpdir(), path.join(root, '20260101T000000Z-' + 'b'.repeat(16)));
  assert.deepEqual(pruneRuns(root, 2), names.slice(0, 2));
  assert.deepEqual(fs.readdirSync(root).sort(), [...names.slice(2), 'evidence-keep', 'note.txt', '20260101T000000Z-' + 'b'.repeat(16)].sort());
  assert.throws(() => pruneRuns(root, 0), RangeError);
});

// Drive runDotnetTests with a fake runner that writes realistic result files into plan.out.
function harness(t, { failed = false, coverage = true, exitCode, cleanup = 'complete', noTrx = false } = {}) {
  const projectRoot = tmp(t), runsRoot = path.join(tmp(t), 'runs'), storage = tmp(t);
  fs.writeFileSync(path.join(projectRoot, 'T.csproj'), '<Project />');
  const fake = {
    plan: null,
    createPlan: null
  };
  return { projectRoot, runsRoot, storage, fake, exitCode: exitCode ?? (failed ? 1 : 0), failed, coverage, cleanup, noTrx };
}

test('end to end with a fake runner: passing, failing, and missing-coverage runs get artifacts, hashes and exit codes', async t => {
  const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
  const cases = [
    { name: 'pass', failed: false, coverage: true, want: [0, 'passed'] },
    { name: 'fail', failed: true, coverage: true, want: [1, 'failed'] },
    { name: 'nocov', failed: false, coverage: false, want: [1, 'failed'] },
    { name: 'notrx', failed: false, coverage: false, noTrx: true, want: [1, 'failed'] }
  ];
  for (const c of cases) {
    const h = harness(t, c);
    let seq = 0;
    // The runner's real path checks (allowlist, /mnt/user/projects, /mnt/cache) are exercised in docker tests; here
    // we substitute a plan builder by stubbing the runner and pointing storage at a temp dir via an injected plan.
    const { runDotnetTests: run } = await import('../dotnet/testing.mjs');
    const config = { allowedProjects: [h.projectRoot], storageRoot: h.storage, uid: 99, gid: 100, lock, limits: { cpus: 1, memoryMb: 512, pids: 64, shmMb: 64, timeoutMs: 60000, diskMb: 256, cacheMb: 128 } };
    let report;
    {
      report = await run({ sdk: '9', projectRoot: h.projectRoot, project: path.join(h.projectRoot, 'T.csproj'), runId: `abcdef01234567${String(++seq).padStart(2, '0')}`, coverage: c.coverage || c.name === 'nocov' },
        config, {
          runsRoot: h.runsRoot, keep: 2, now: () => new Date('2026-10-31T12:00:00Z'),
          runner: async plan => {
            const r = path.join(plan.out, 'results', 'guid');
            fs.mkdirSync(r, { recursive: true });
            if (!c.noTrx) fs.writeFileSync(path.join(plan.out, 'results', 'results.trx'), TRX(c.failed));
            if (c.coverage) fs.writeFileSync(path.join(r, 'coverage.cobertura.xml'), COV);
            return { exitCode: c.failed ? 1 : 0, cleanup: 'complete', logs: {} };
          },
          release: () => {}, planner
        });
    }
    assert.deepEqual([report.exit_code, report.status], c.want, c.name);
    assert.match(path.basename(report.workspace), /^20261031T120000Z-[a-f0-9]{16}/);
    for (const a of report.artifacts) {
      assert.match(a.sha256, /^[0-9a-f]{64}$/);
      assert.ok(fs.existsSync(path.join(report.workspace, a.path)));
    }
    assert.ok(fs.existsSync(path.join(report.workspace, 'result.json')));
    if (c.failed) assert.deepEqual(report.summary.failures, [{ name: 'test-2', message: 'assertion failed: Assert.Equal' }]);
    if (c.name === 'pass') assert.equal(report.summary.line_coverage_percent, 81.3);
  }
});

test('a run directory is never reused', async t => {
  const root = tmp(t), runsRoot = tmp(t), storage = tmp(t);
  fs.writeFileSync(path.join(root, 'T.csproj'), '<Project />');
  const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
  const config = { allowedProjects: [root], storageRoot: storage, uid: 99, gid: 100, lock, limits: { cpus: 1, memoryMb: 512, pids: 64, shmMb: 64, timeoutMs: 60000, diskMb: 256, cacheMb: 128 } };
  fs.mkdirSync(path.join(runsRoot, '20261031T120000Z-abcdef0123456789'));
  let ran = false;
  await assert.rejects(runDotnetTests({ sdk: '8', projectRoot: root, project: path.join(root, 'T.csproj'), runId: 'abcdef0123456789' }, config,
    { runsRoot, planner, runner: async () => { ran = true; }, now: () => new Date('2026-10-31T12:00:00Z') }), /EEXIST/);
  assert.equal(ran, false);
});

test('persisted TRX, JUnit and result.json carry no raw TRX text, including an unrecognised credential', async t => {
  // A generic canary matches no secret pattern, so only an allowlist rebuild keeps it out (PR #67 review).
  const canary = 'qz' + 'Canary' + crypto.randomBytes(8).toString('base64url').replace(/[^A-Za-z0-9]/g, 'x');
  const pw = 'hunter' + '2-sec' + 'ret', aws = 'AK' + 'IAABCDEFGHIJKL';
  const raw = `<?xml version="1.0"?><TestRun id="r" name="${canary}@host" runUser="${canary}"><Results>` +
    `<UnitTestResult testId="t1" testName="A.Fails(arg: &quot;${canary}&quot;)" computerName="${canary}" outcome="Failed" duration="00:00:01">` +
    `<Output><StdOut>${canary} token=${pw}</StdOut><StdErr>${canary}</StdErr><ErrorInfo><Message>${canary}</Message><StackTrace>at ${canary}.Stack</StackTrace></ErrorInfo></Output></UnitTestResult>` +
    `<UnitTestResult testId="t2" testName="B.Fails" outcome="Failed" duration="00:00:01"><Output><ErrorInfo><Message>Assert.Equal() Failure\nExpected: ${canary}\nActual: ${aws}</Message></ErrorInfo></Output></UnitTestResult>` +
    `<UnitTestResult testId="t3" testName="${canary} display name" outcome="${canary}" duration="${canary}"><Output><StdOut>${canary}</StdOut></Output></UnitTestResult>` +
    `</Results><TestDefinitions><UnitTest name="${canary}" storage="/src/${canary}.dll" id="t1"><Execution id="e1" /><TestMethod codeBase="/${canary}" className="A" name="Fails" /></UnitTest></TestDefinitions>` +
    `<ResultSummary outcome="Failed"><Counters total="3" executed="3" passed="0" failed="2" /><Output><StdOut>${canary}</StdOut></Output>` +
    `<RunInfos><RunInfo computerName="h" outcome="Warning"><Text>${canary}</Text></RunInfo></RunInfos></ResultSummary></TestRun>`;
  const projectRoot = tmp(t), runsRoot = path.join(tmp(t), 'runs'), storage = tmp(t);
  fs.writeFileSync(path.join(projectRoot, 'T.csproj'), '<Project />');
  const lock = JSON.parse(fs.readFileSync(new URL('../docker/images.lock.json', import.meta.url), 'utf8'));
  const config = { allowedProjects: [projectRoot], storageRoot: storage, uid: 99, gid: 100, lock, limits: { cpus: 1, memoryMb: 512, pids: 64, shmMb: 64, timeoutMs: 60000, diskMb: 256, cacheMb: 128 } };
  const report = await runDotnetTests({ sdk: '10', projectRoot, project: path.join(projectRoot, 'T.csproj'), runId: 'abcdef0123456789' }, config, {
    runsRoot, planner, release: () => {}, now: () => new Date('2026-10-31T12:00:00Z'),
    runner: async plan => {
      fs.mkdirSync(path.join(plan.out, 'results'), { recursive: true });
      fs.writeFileSync(path.join(plan.out, 'results', 'results.trx'), raw);
      return { exitCode: 1, cleanup: 'complete', logs: {} };
    }
  });
  assert.deepEqual([report.exit_code, report.status], [1, 'failed']);
  const files = ['result.json', ...report.artifacts.map(a => a.path)];
  assert.deepEqual(report.artifacts.map(a => a.kind).sort(), ['report', 'trx']);
  for (const f of files) {
    const text = fs.readFileSync(path.join(report.workspace, f), 'utf8');
    for (const secret of [canary, pw, aws]) assert.ok(!text.includes(secret), `${f} leaked ${secret === canary ? 'the canary' : 'a credential'}`);
  }
  assert.deepEqual(report.summary.failures, [{ name: 'A.Fails', message: 'test failed (message not persisted)' }, { name: 'B.Fails', message: 'assertion failed: Assert.Equal' }]);
  const trxFile = path.join(report.workspace, 'artifacts', 'results.trx');
  assert.deepEqual(parseTrx(fs.readFileSync(trxFile, 'utf8')).results.map(r => [r.name, r.outcome]), [['A.Fails', 'Failed'], ['B.Fails', 'Failed'], ['test-3', 'Unknown']]);
  assert.equal(report.artifacts.find(a => a.kind === 'trx').sha256, crypto.createHash('sha256').update(fs.readFileSync(trxFile)).digest('hex'));
});
