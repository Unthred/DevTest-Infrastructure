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

export function parseTrx(xml) {
  const counters = /<Counters\b[^>]*>/.exec(xml)?.[0];
  if (!counters) return null;
  const n = name => Number(attr(counters, name) ?? 0);
  const results = [];
  for (const m of xml.matchAll(/<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/g)) {
    const message = /<Message>([\s\S]*?)<\/Message>/.exec(m[2] ?? '')?.[1];
    results.push({ name: unescapeXml(attr(m[1], 'testName') ?? ''), outcome: attr(m[1], 'outcome') ?? 'Unknown', duration: attr(m[1], 'duration') ?? '',
      message: message === undefined ? undefined : unescapeXml(message).slice(0, 500) });
  }
  return { total: n('total'), executed: n('executed'), passed: n('passed'), failed: n('failed'), results };
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
  if (trx && copyBounded(trx, path.join(dest, 'results.trx'))) {
    artifacts.push(record('trx', path.join(dest, 'results.trx'), runDir));
    summary = parseTrx(fs.readFileSync(path.join(dest, 'results.trx'), 'utf8'));
    if (summary) {
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
