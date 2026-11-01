import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDotnetPlan } from './run.mjs';
import { runContainer, releaseVolumes } from '../docker/runner.mjs';

// Issue #4: run `dotnet test` through the trusted runner, then collect TRX, JUnit and coverage into a
// timestamped run directory with hashes, an actionable summary, a contract exit code and bounded retention.
// Frameworks (xUnit, NUnit, MSTest) are all driven by `dotnet test`; the SDK (8/9/10) is chosen by the caller.

const RUN_DIR = /^\d{8}T\d{6}Z-[a-f0-9]{16,32}$/;
const MAX_ARTIFACT_BYTES = 64 * 1048576;
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const unescapeXml = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapeXml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Test output can contain credentials (D-008), and no pattern list recognises every secret. So nothing free-form from
// the raw TRX is ever persisted: the persisted TRX, the JUnit file and result.json are rebuilt from allowlisted fields
// only. Names must be code identifiers, outcomes, durations and counters must match fixed formats, and a failure is
// reported as one of a closed set of constant reasons. Message text, stdout/stderr, stack traces, run infos, computer
// and user names, and theory arguments are dropped, never copied or redacted.
const OUTCOMES = new Set(['Passed', 'Failed', 'NotExecuted', 'Inconclusive', 'Timeout', 'Aborted', 'Error', 'Warning', 'Completed', 'InProgress',
  'Pending', 'Disconnected', 'PassedButRunAborted', 'NotRunnable']);
const ASSERTS = new Set(['Equal', 'NotEqual', 'True', 'False', 'Null', 'NotNull', 'Empty', 'NotEmpty', 'Contains', 'DoesNotContain', 'Throws',
  'ThrowsAsync', 'ThrowsAny', 'ThrowsAnyAsync', 'Same', 'NotSame', 'InRange', 'NotInRange', 'IsType', 'IsNotType', 'IsAssignableFrom', 'Single',
  'All', 'Collection', 'Matches', 'DoesNotMatch', 'StartsWith', 'EndsWith', 'Equivalent', 'Fail', 'AreEqual', 'AreNotEqual', 'AreSame',
  'AreNotSame', 'IsTrue', 'IsFalse', 'IsNull', 'IsNotNull', 'IsInstanceOfType', 'ThrowsException', 'ThrowsExceptionAsync', 'That', 'Inconclusive',
  'Greater', 'Less', 'Zero', 'NotZero']);
const EXCEPTIONS = new Set(['Exception', 'NullReferenceException', 'InvalidOperationException', 'ArgumentException', 'ArgumentNullException',
  'ArgumentOutOfRangeException', 'KeyNotFoundException', 'NotImplementedException', 'NotSupportedException', 'IndexOutOfRangeException',
  'FormatException', 'TimeoutException', 'TaskCanceledException', 'OperationCanceledException', 'IOException', 'FileNotFoundException',
  'DirectoryNotFoundException', 'UnauthorizedAccessException', 'HttpRequestException', 'JsonException', 'DivideByZeroException',
  'InvalidCastException', 'OverflowException', 'ObjectDisposedException', 'AggregateException']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(?:[.+][A-Za-z_][A-Za-z0-9_]*)*(?:`\d+)?$/;
const DURATION = /^\d{1,2}:\d{2}:\d{2}(?:\.\d{1,7})?$/;
const safeName = s => (typeof s === 'string' && s.length <= 300 && IDENT.test(s) ? s : undefined);
const safeOutcome = s => (OUTCOMES.has(s) ? s : 'Unknown');
const REASONS = new Set(['test failed (no message)', 'test failed (message not persisted)', 'test timed out', 'assertion failed', 'exception thrown',
  ...[...ASSERTS].map(a => `assertion failed: Assert.${a}`), ...[...EXCEPTIONS].map(e => `exception thrown: ${e}`)]);
const tagAttr = (tag, name) => { const v = attr(tag, name); return v === undefined ? undefined : unescapeXml(v); };

// Maps a raw failure message to a constant reason. Only this closed vocabulary can come out; the input is never echoed.
export function failureReason(raw) {
  if (raw === undefined) return 'test failed (no message)';
  const text = String(raw);
  if (REASONS.has(text)) return text;   // already sanitized (the persisted TRX is parsed again)
  const asserted = /^\s*Assert\.([A-Za-z]+)\b/.exec(text)?.[1];
  if (asserted) return ASSERTS.has(asserted) ? `assertion failed: Assert.${asserted}` : 'assertion failed';
  if (/^\s*Expected\b/m.test(text) && /^\s*(?:But was|Actual)\s*:/m.test(text)) return 'assertion failed';
  const thrown = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)*([A-Za-z_][A-Za-z0-9_]*Exception)\s*:/.exec(text)?.[1];
  if (thrown) return EXCEPTIONS.has(thrown) ? `exception thrown: ${thrown}` : 'exception thrown';
  if (/\btim(?:ed|e) ?out\b/i.test(text)) return 'test timed out';
  return 'test failed (message not persisted)';
}

// Parses a TRX into allowlisted structured data. Raw message text never leaves this function; only failureReason() output does.
export function parseTrx(xml) {
  const counters = /<Counters\b[^>]*>/.exec(xml)?.[0];
  if (!counters) return null;
  const n = name => { const v = Number(attr(counters, name) ?? 0); return Number.isSafeInteger(v) && v >= 0 ? v : 0; };
  const methods = new Map();
  for (const m of xml.matchAll(/<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/g)) {
    const id = attr(m[1], 'id'), method = /<TestMethod\b[^>]*>/.exec(m[2])?.[0];
    if (id && method) methods.set(id, [tagAttr(method, 'className'), tagAttr(method, 'name')]);
  }
  const results = [], seen = new Map();
  for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const [cls, meth] = methods.get(attr(m[1], 'testId')) ?? [];
    const fromMethod = safeName(cls) && safeName(meth) ? `${cls}.${meth}` : undefined;
    const fromName = safeName(tagAttr(m[1], 'testName')?.replace(/\s*\([\s\S]*$/, ''));   // theory arguments can carry runtime data
    let name = fromMethod ?? fromName ?? `test-${results.length + 1}`;
    const count = (seen.get(name) ?? 0) + 1;
    seen.set(name, count);
    if (count > 1) name = `${name}#${count}`;
    const outcome = safeOutcome(attr(m[1], 'outcome')), duration = attr(m[1], 'duration') ?? '';
    const message = /<Message>([\s\S]*?)<\/Message>/.exec(m[2] ?? '')?.[1];
    results.push({ name, outcome, duration: DURATION.test(duration) ? duration : '',
      message: outcome === 'Failed' ? failureReason(message === undefined ? undefined : unescapeXml(message)) : undefined });
  }
  const resultSummary = /<ResultSummary\b[^>]*>/.exec(xml)?.[0];
  return { total: n('total'), executed: n('executed'), passed: n('passed'), failed: n('failed'),
    outcome: safeOutcome(resultSummary && attr(resultSummary, 'outcome')), results };
}

// Returns a TRX that is safe to persist, rebuilt from parseTrx() data only: no free-form byte of the raw file is copied.
// Ids are derived deterministically from the position and sanitized name, so they carry no raw content either.
const guid = h => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
const TEST_LIST = '8c84fa94-04c1-424b-9868-57a2d4851a1d', UNIT_TEST_TYPE = '13cdc9d9-ddb5-4fa4-a97d-d965ccfc6d4b';
export function sanitizeTrx(xml) {
  const s = parseTrx(xml);
  if (!s) return null;
  const rows = s.results.map((r, i) => {
    const h = crypto.createHash('sha256').update(`${i}:${r.name}`).digest('hex');
    const base = r.name.replace(/#\d+$/, ''), dot = base.lastIndexOf('.');
    return { r, testId: guid(h), executionId: guid(h.slice(32)), className: dot > 0 ? base.slice(0, dot) : '', method: base.slice(dot + 1) };
  });
  const results = rows.map(({ r, testId, executionId }) => {
    const head = `<UnitTestResult executionId="${executionId}" testId="${testId}" testName="${escapeXml(r.name)}"` +
      (r.duration ? ` duration="${r.duration}"` : '') + ` outcome="${r.outcome}" testType="${UNIT_TEST_TYPE}" testListId="${TEST_LIST}"`;
    return r.message === undefined ? `${head} />` : `${head}><Output><ErrorInfo><Message>${escapeXml(r.message)}</Message></ErrorInfo></Output></UnitTestResult>`;
  });
  const defs = rows.map(({ r, testId, executionId, className, method }) => `<UnitTest name="${escapeXml(r.name)}" id="${testId}">` +
    `<Execution id="${executionId}" /><TestMethod className="${escapeXml(className)}" name="${escapeXml(method)}" /></UnitTest>`);
  const entries = rows.map(({ testId, executionId }) => `<TestEntry testId="${testId}" executionId="${executionId}" testListId="${TEST_LIST}" />`);
  return '<?xml version="1.0" encoding="utf-8"?>\n<TestRun xmlns="http://microsoft.com/schemas/VisualStudio/TeamTest/2010">\n' +
    `<Results>\n${results.join('\n')}\n</Results>\n<TestDefinitions>\n${defs.join('\n')}\n</TestDefinitions>\n` +
    `<TestEntries>\n${entries.join('\n')}\n</TestEntries>\n<TestLists><TestList name="Results Not in a List" id="${TEST_LIST}" /></TestLists>\n` +
    `<ResultSummary outcome="${s.outcome}"><Counters total="${s.total}" executed="${s.executed}" passed="${s.passed}" failed="${s.failed}" /></ResultSummary>\n</TestRun>\n`;
}

export function trxToJunit(summary, suite = 'dotnet-test') {
  const failed = summary.results.filter(r => r.outcome === 'Failed');
  const skipped = summary.results.filter(r => r.outcome === 'NotExecuted');
  const cases = summary.results.map(r => {
    const body = r.outcome === 'Failed' ? `<failure message="${escapeXml(r.message ?? 'failed')}"/>` : r.outcome === 'NotExecuted' ? '<skipped/>' : '';
    return `  <testcase name="${escapeXml(r.name)}" classname="${escapeXml(suite)}">${body}</testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escapeXml(suite)}" tests="${summary.results.length}" failures="${failed.length}" skipped="${skipped.length}">\n${cases.join('\n')}\n</testsuite>\n`;
}

const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

function findFiles(dir, suffix, depth = 4) {
  if (depth < 0 || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) return [];            // never follow links out of the run volume
    if (e.isDirectory()) return findFiles(p, suffix, depth - 1);
    return e.isFile() && e.name.endsWith(suffix) ? [p] : [];
  });
}

function record(kind, file, runDir) {
  const data = fs.readFileSync(file);
  return { kind, path: path.relative(runDir, file), sha256: crypto.createHash('sha256').update(data).digest('hex'), bytes: data.length };
}

function copyBounded(from, to) {
  if (fs.statSync(from).size > MAX_ARTIFACT_BYTES) return false;
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  return true;
}

// Copies result files out of the run's /out directory into <runDir>/artifacts and returns artifact records.
export function collectArtifacts(outDir, runDir, suite) {
  const dest = path.join(runDir, 'artifacts');
  fs.mkdirSync(dest, { recursive: true, mode: 0o750 });
  const artifacts = [];
  let summary = null;
  const resultsDir = path.join(outDir, 'results');
  const trx = findFiles(resultsDir, '.trx')[0];
  if (trx && fs.statSync(trx).size <= MAX_ARTIFACT_BYTES) {
    const clean = sanitizeTrx(fs.readFileSync(trx, 'utf8'));   // the raw TRX is never copied
    if (clean !== null) {
      fs.writeFileSync(path.join(dest, 'results.trx'), clean, { flag: 'wx' });
      artifacts.push(record('trx', path.join(dest, 'results.trx'), runDir));
      summary = parseTrx(clean);
      fs.writeFileSync(path.join(dest, 'results.junit.xml'), trxToJunit(summary, suite), { flag: 'wx' });
      artifacts.push(record('report', path.join(dest, 'results.junit.xml'), runDir));
    }
  }
  const cov = findFiles(resultsDir, 'coverage.cobertura.xml')[0];
  if (cov && copyBounded(cov, path.join(dest, 'coverage.cobertura.xml'))) artifacts.push(record('coverage', path.join(dest, 'coverage.cobertura.xml'), runDir));
  return { artifacts, summary };
}

export function coverageRate(file) {
  const m = /<coverage\b[^>]*\bline-rate="([0-9.]+)"/.exec(fs.readFileSync(file, 'utf8'));
  return m ? Math.round(Number(m[1]) * 1000) / 10 : null;
}

// Maps the runner outcome plus parsed results to the cli.v1 exit code and status.
export function classify(result, summary, coverageRequested, hasCoverage) {
  if (result.exitCode === 5) return { exit_code: 5, status: 'timeout', message: 'time limit exceeded; the container was stopped and removed' };
  if (result.exitCode === 130) return { exit_code: 130, status: 'interrupted', message: 'interrupted' };
  if (result.exitCode === 7 || result.cleanup !== 'complete') return { exit_code: 7, status: 'error', message: 'finished but cleanup was incomplete' };
  if (result.exitCode === 6) return { exit_code: 6, status: 'error', message: 'runner failed; this is not evidence about the tests' };
  if (result.exitCode === 3) return { exit_code: 3, status: 'error', message: 'environment precondition missing' };
  if (result.exitCode === 0) {
    if (!summary) return { exit_code: 1, status: 'failed', message: 'dotnet exited 0 but produced no TRX; no tests were discovered or the logger did not run' };
    if (summary.total === 0) return { exit_code: 1, status: 'failed', message: 'no tests were discovered' };
    if (coverageRequested && !hasCoverage) return { exit_code: 1, status: 'failed', message: 'coverage was requested but no coverage report was produced; the test project needs the coverlet.collector package' };
    return { exit_code: 0, status: 'passed', message: `${summary.passed}/${summary.total} tests passed` };
  }
  if (summary && summary.failed > 0) return { exit_code: 1, status: 'failed', message: `${summary.failed} of ${summary.total} tests failed` };
  return { exit_code: 1, status: 'failed', message: 'build or test host failed before results were produced; see logs' };
}

// Keeps the newest `keep` timestamped run directories. Only names matching the run pattern that are real
// directories are ever removed; anything else in the root is left alone.
export function pruneRuns(root, keep, protect = new Set()) {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new RangeError('keep must be a positive integer');
  if (!fs.existsSync(root)) return [];
  const runs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink() && RUN_DIR.test(e.name)).map(e => e.name).sort();
  const removed = [];
  for (const name of runs.slice(0, Math.max(0, runs.length - keep))) {
    if (protect.has(name)) continue;
    fs.rmSync(path.join(root, name), { recursive: true, force: true });
    removed.push(name);
  }
  return removed;
}

export async function runDotnetTests(options, config, { runsRoot, keep = 20, now = () => new Date(), runner = runContainer, release = releaseVolumes, planner = createDotnetPlan } = {}) {
  if (typeof runsRoot !== 'string' || !path.isAbsolute(runsRoot)) throw new TypeError('absolute runsRoot is required');
  const started = now();
  const plan = planner({ ...options, operation: 'test' }, config);
  const name = `${stamp(started)}-${plan.runId}`;
  const runDir = path.join(runsRoot, name);
  fs.mkdirSync(runsRoot, { recursive: true, mode: 0o750 });
  fs.mkdirSync(runDir, { mode: 0o750 });     // fails if it already exists: a run directory is never reused
  let result, collected = { artifacts: [], summary: null };
  try {
    result = await runner(plan, { keepVolume: true });
    try { collected = collectArtifacts(plan.out, runDir, path.basename(options.project ?? options.projectRoot)); } catch { /* reported through classify */ }
  } finally {
    if (result) release(plan);
    fs.rmSync(plan.workspace, { recursive: true, force: true });
  }
  // The runner deliberately persists no raw subject output (it can contain credentials); only TRX/JUnit/coverage are kept.
  const logs = path.join(runDir, 'artifacts');
  const hasCoverage = collected.artifacts.some(a => a.kind === 'coverage');
  const verdict = classify(result, collected.summary, options.coverage === true, hasCoverage);
  const summary = {
    message: verdict.message, sdk: plan.dotnet.sdk,
    tests: collected.summary && { total: collected.summary.total, passed: collected.summary.passed, failed: collected.summary.failed },
    failures: (collected.summary?.results ?? []).filter(r => r.outcome === 'Failed').slice(0, 20).map(r => ({ name: r.name, message: r.message })),
    line_coverage_percent: hasCoverage ? coverageRate(path.join(logs, 'coverage.cobertura.xml')) : null
  };
  const report = { schema_version: 1, run_id: plan.runId, command: 'dotnet test', status: verdict.status, exit_code: verdict.exit_code,
    started_at: started.toISOString(), ended_at: now().toISOString(), workspace: runDir, artifacts: collected.artifacts,
    cleanup: result.cleanup, image: plan.image, summary };
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  report.retention_removed = pruneRuns(runsRoot, keep, new Set([name]));
  return report;
}
