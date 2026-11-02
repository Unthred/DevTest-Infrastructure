// The dev-test CLI (issue #8, contract: docs/cli-contract.md, contracts/cli.v1.json). One entry point for .NET build/test and browser
// screenshot/responsive runs. It only plans and starts runs through the trusted runner (docker/runner.mjs); it never builds a
// `docker run` line itself and never passes a value through a shell.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, UsageError, COMMANDS, VERSION, CONTRACT_VERSION } from './args.mjs';
import { loadConfig, EnvironmentError, REPO_ROOT, playwrightCacheState } from './config.mjs';
import { newRunId, createRunDir, artifactRecord, collectWebArtifacts, findRunDir, readStoredResult, writeStoredResult, stamp } from './evidence.mjs';
import { createPlan, runContainer, releaseVolumes, sweepStaleVolumes, dockerCommand, RunnerError, targetSocketPath } from '../docker/runner.mjs';
import { dotnetRunSpec } from '../dotnet/run.mjs';
import { runDotnetTests } from '../dotnet/testing.mjs';
import { DotnetCommandError, discoverProject } from '../dotnet/commands.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { checkHealth } from '../broker/openbao.mjs';
import { validatePolicy, CREDENTIAL_KEY } from '../broker/broker.mjs';
import { evaluateLiveGate } from '../browser/ha-live-gate.mjs';

export const EXIT = { ok: 0, subject_failed: 1, usage: 2, environment: 3, policy_refused: 4, timeout: 5, internal: 6, cleanup_incomplete: 7, interrupted: 130 };
const STATUS = { 0: 'passed', 1: 'failed', 2: 'error', 3: 'error', 4: 'refused', 5: 'timeout', 6: 'error', 7: 'error', 130: 'interrupted' };
const DESCRIPTIONS = {
  version: 'Print CLI and contract versions.',
  help: 'Usage. "dev-test help <command>" shows one command.',
  doctor: 'Read-only check of Docker, pinned images, caches, run directories and OpenBao reachability.',
  'dotnet build': 'Build in a pinned SDK container.',
  'dotnet test': 'Test in a pinned SDK container; TRX, JUnit and optional coverage artifacts.',
  'web screenshot': 'Capture one screenshot of a local page in a network-less Playwright container.',
  'web responsive': 'Capture across profiles and apply responsive layout assertions.',
  'web ha': 'Home Assistant read-only browser profile: anonymised local fixture by default; --live reports whether the real instance may be used (it is blocked).',
  report: 'Show a stored result by run id.',
  cleanup: 'Remove run workspaces; evidence only when its run id is named.'
};

// Bad inputs that are the caller's to fix, as opposed to refusals of policy.
class PolicyRefused extends Error { constructor(message) { super(message); this.name = 'PolicyRefused'; } }
const has = (v) => v !== undefined && v !== null;

const realDeps = () => ({
  docker: dockerCommand, createPlan, runContainer, releaseVolumes, sweep: sweepStaleVolumes, health: checkHealth,
  startTarget: (root, socket, owner) => listenOnSocket(createStaticServer(root), socket, owner),
  mounts: () => fs.readFileSync('/proc/mounts', 'utf8'), now: () => new Date(), commit: gitCommit
});

function gitCommit(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000, env: { PATH: process.env.PATH || '/usr/bin:/bin' } });
  const v = r.status === 0 ? r.stdout.trim() : '';
  return /^[0-9a-f]{40}$/.test(v) ? v : null;
}

export async function main(argv, { env = process.env, deps: override = {}, stdout = process.stdout, stderr = process.stderr, cwd = process.cwd() } = {}) {
  const deps = { ...realDeps(), ...override };
  const wantJson = argv.includes('--json');
  const started = deps.now();
  let ctx = { command: argv.filter((a) => !a.startsWith('-')).slice(0, 2).join(' ') || 'help', runId: newRunId(), json: wantJson };
  let outcome;
  try {
    const parsed = parseArgs(argv);
    ctx = { ...ctx, ...parsed, json: parsed.global.json, command: parsed.command };
    outcome = await dispatch(ctx, { env, deps, cwd });
  } catch (error) { outcome = classifyError(error); }
  const exit = outcome.exit;
  const result = {
    schema_version: 1, contract_version: CONTRACT_VERSION, run_id: outcome.runId ?? ctx.runId, command: ctx.command, status: STATUS[exit] ?? 'error', exit_code: exit,
    started_at: started.toISOString(), ended_at: deps.now().toISOString(), workspace: outcome.workspace ?? null, artifacts: outcome.artifacts ?? [],
    cleanup: outcome.cleanup ?? 'not_applicable', message: outcome.message, image: outcome.image ?? null, source_commit: outcome.sourceCommit ?? null,
    redaction: { applied: true, scope: 'subject output is never persisted; stored files are rebuilt from allow-listed fields (D-008)' }
  };
  if (outcome.data !== undefined) result.data = outcome.data;
  if (outcome.persist) { try { writeStoredResult(outcome.persist.dir, result, outcome.persist.overwrite); } catch (error) { result.message += ` (result.json not stored: ${error.code ?? error.name})`; } }
  if (ctx.json) stdout.write(`${JSON.stringify(result)}\n`);
  stderr.write(human(result, outcome.lines));
  return exit;
}

function classifyError(error) {
  if (error instanceof UsageError || error instanceof DotnetCommandError) return { exit: 2, message: error.message };
  if (error instanceof EnvironmentError) return { exit: 3, message: error.message };
  if (error instanceof PolicyRefused) return { exit: 4, message: error.message };
  if (error instanceof RunnerError) {
    const code = error.exitCode;
    return { exit: [3, 4, 5, 7, 130].includes(code) ? code : 6, message: error.message };
  }
  return { exit: 6, message: `internal error (${error?.name ?? 'Error'}); this is not evidence about the subject` };
}

function human(r, lines = []) {
  const head = `dev-test ${r.command}: ${r.status} (exit ${r.exit_code}) - ${r.message}`;
  return `${[head, ...lines, r.workspace ? `  run ${r.run_id}  evidence: ${r.workspace}` : ''].filter(Boolean).join('\n')}\n`;
}

async function dispatch(ctx, io) {
  switch (ctx.command) {
    case 'version': return { exit: 0, message: `dev-test ${VERSION} (contract ${CONTRACT_VERSION})`, data: { version: VERSION, contract_version: CONTRACT_VERSION, node: process.version } };
    case 'help': return help(ctx.positionals.join(' '));
    case 'doctor': return doctor(ctx, io);
    case 'dotnet build': case 'dotnet test': return dotnet(ctx, io);
    case 'web ha': return ctx.options['--live'] ? haLive(ctx, io) : web(ctx, io);
    case 'web screenshot': case 'web responsive': return web(ctx, io);
    case 'report': return report(ctx, io);
    case 'cleanup': return cleanup(ctx, io);
    default: throw new UsageError(`unknown command ${ctx.command}`);
  }
}

function help(topic) {
  if (topic && !(topic in COMMANDS)) throw new UsageError(`unknown command ${JSON.stringify(topic)}`);
  const names = topic ? [topic] : Object.keys(COMMANDS);
  const usage = names.map((n) => ({ command: n, summary: DESCRIPTIONS[n], options: Object.entries(COMMANDS[n].options).map(([o, k]) => `${o}${k === 'flag' ? '' : ' <value>'}${k === 'repeat' ? ' (repeatable)' : ''}${COMMANDS[n].required.includes(o) ? ' (required)' : ''}`) }));
  const lines = usage.flatMap((u) => [`  dev-test ${u.command}${u.options.length ? ` ${u.options.join(' ')}` : ''}`, `      ${u.summary}`]);
  if (!topic) lines.push('', 'Global options: --json (one JSON result on stdout), --run-dir <dir>, --timeout <duration>, --no-color', 'Exit codes: 0 ok, 1 subject failed, 2 usage, 3 environment, 4 policy refused, 5 timeout, 6 internal, 7 cleanup incomplete, 130 interrupted');
  return { exit: 0, message: topic ? `usage for ${topic}` : 'usage', lines, data: { usage } };
}

// ---------- shared helpers ----------

function evidenceRoot(ctx, config) {
  const dir = ctx.global.runDir ?? config.evidenceRoot ?? path.join(config.storageRoot, 'evidence');
  if (!path.isAbsolute(dir) || /[\0\r\n]/.test(dir)) throw new UsageError('--run-dir must be an absolute path');
  return path.resolve(dir);
}

function effectiveConfig(ctx, config) {
  if (!has(ctx.global.timeoutMs)) return config;
  const max = config.limits?.timeoutMs;
  if (Number.isSafeInteger(max) && ctx.global.timeoutMs > max) throw new PolicyRefused(`--timeout exceeds the configured maximum of ${max} ms`);
  return { ...config, limits: { ...config.limits, timeoutMs: ctx.global.timeoutMs } };
}

function realpathOrNull(p) { try { return fs.realpathSync(p); } catch { return null; } }
const inside = (base, candidate) => candidate === base || candidate.startsWith(base + path.sep);

function allowedRoots(config) { return (config.allowedProjects ?? []).map(realpathOrNull).filter(Boolean); }
function owningRoot(config, real) { return allowedRoots(config).filter((r) => inside(r, real)).sort((a, b) => b.length - a.length)[0] ?? null; }

function dockerProblem(deps) {
  const r = deps.docker(['version', '--format', '{{.Server.Version}}']);
  if (r.error?.code === 'ENOENT') return 'the docker command was not found';
  if (r.status !== 0) return 'the Docker daemon is not reachable';
  return null;
}

// Everything that can be checked before a run directory exists. Missing Docker, a missing pinned image or an unwritable
// directory is exit 3 with an actionable message and nothing started.
function preflight(ctx, { config, deps, runsRoot, imageIds, needPlaywrightCache }) {
  let storage;
  try { storage = fs.statSync(config.storageRoot); } catch { storage = null; }
  if (!storage?.isDirectory()) throw new EnvironmentError(`storage root ${config.storageRoot} does not exist; create it on the cache pool`);
  try { fs.mkdirSync(runsRoot, { recursive: true, mode: 0o750 }); fs.accessSync(runsRoot, fs.constants.W_OK); }
  catch { throw new EnvironmentError(`run directory ${runsRoot} is not writable`); }
  const problem = dockerProblem(deps);
  if (problem) throw new EnvironmentError(`Docker is unavailable: ${problem}. Nothing ran.`);
  for (const id of imageIds) {
    const ref = config.lock?.images?.[id]?.reference;
    if (!ref) throw new EnvironmentError(`image ${id} is not in the lock file`);
    if (deps.docker(['image', 'inspect', '--format', '{{.Id}}', ref]).status !== 0)
      throw new EnvironmentError(`pinned image ${id} (${ref.replace(/^.*\//, '')}) is not present locally; pull it through the reviewed image update path (runs never pull)`);
  }
  if (needPlaywrightCache) {
    const cache = playwrightCacheState(config);
    if (!cache.ok) throw new EnvironmentError(`the Playwright cache is not ready (${cache.reason}); run "node browser/prepare-cache.mjs" then "node browser/restore-cache.mjs" (docs/browser-runner.md)`);
  }
}

const imageInfo = (plan) => ({ reference: plan.image, digest: plan.image.split('@')[1] ?? null });

function classifyRunner(result) {
  const map = { 0: 0, 1: 1, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 130: 130 };
  return map[result.exitCode] ?? 6;
}

// ---------- dotnet ----------

async function dotnet(ctx, io) {
  const { deps, env, cwd } = io;
  const { config } = loadConfig(env);
  const cfg = effectiveConfig(ctx, config);
  const op = ctx.command.split(' ')[1];
  const raw = path.resolve(cwd, ctx.options['--project']);
  const real = realpathOrNull(raw);
  if (!real) throw new UsageError(`--project ${ctx.options['--project']} does not exist`);
  const root = owningRoot(cfg, real);
  if (!root) throw new PolicyRefused('--project is not inside an allowlisted project (docker/runner.example.json "allowedProjects")');
  const isDir = fs.statSync(real).isDirectory();
  const projectOptions = isDir ? { workingDirectory: path.relative(root, real) || '.' } : { project: real };
  if (isDir) discoverProject(root, projectOptions.workingDirectory);   // fail with a usage error before touching Docker
  const runsRoot = evidenceRoot(ctx, cfg);
  preflight(ctx, { config: cfg, deps, runsRoot, imageIds: [`dotnet-${ctx.options['--sdk']}`] });
  const options = { sdk: ctx.options['--sdk'], projectRoot: root, runId: ctx.runId, ...projectOptions, ...(op === 'test' && ctx.options['--coverage'] ? { coverage: true } : {}) };
  const planner = (o, c) => { const { spec, command } = dotnetRunSpec(o); return { ...deps.createPlan(spec, c), dotnet: command }; };
  const sourceCommit = deps.commit(root);
  if (op === 'test') {
    const report = await runDotnetTests(options, cfg, { runsRoot, keep: cfg.keepRuns ?? 200, now: deps.now, runner: deps.runContainer, release: deps.releaseVolumes, planner });
    const enriched = { ...report, contract_version: CONTRACT_VERSION, message: report.summary?.message, image: { reference: report.image, digest: report.image?.split('@')[1] ?? null }, source_commit: sourceCommit, redaction: { applied: true, scope: 'TRX rebuilt from allow-listed fields; raw output never persisted (D-008)' } };
    const lines = [];
    if (report.summary?.tests) lines.push(`  tests: ${report.summary.tests.passed}/${report.summary.tests.total} passed${report.summary.line_coverage_percent != null ? `, line coverage ${report.summary.line_coverage_percent}%` : ''}`);
    for (const f of report.summary?.failures ?? []) lines.push(`  failed: ${f.name}${f.message ? ` - ${f.message}` : ''}`);
    return { exit: report.exit_code, runId: report.run_id, message: report.summary?.message ?? report.status, workspace: report.workspace, artifacts: report.artifacts, cleanup: report.cleanup,
      image: enriched.image, sourceCommit, data: { summary: report.summary }, lines, persist: { dir: report.workspace, overwrite: true } };
  }
  // build: no artifacts exist (raw compiler output is never persisted), so the run directory holds only result.json.
  const began = deps.now();
  const plan = planner({ ...options, operation: 'build' }, cfg);
  const dir = createRunDir(runsRoot, plan.runId, began);
  let result;
  try { result = await deps.runContainer(plan); }
  finally { fs.rmSync(plan.workspace, { recursive: true, force: true }); }
  const exit = classifyRunner(result);
  const message = { 0: 'build succeeded', 1: 'build failed (raw compiler output is not stored by policy; build locally to read diagnostics)', 5: 'time limit exceeded; the container was stopped and removed', 6: 'runner failed; this is not evidence about the build', 7: 'finished but cleanup was incomplete', 130: 'interrupted', 3: 'environment precondition missing', 4: 'refused by runner policy' }[exit];
  return { exit, runId: plan.runId, message, workspace: dir, cleanup: result.cleanup, image: imageInfo(plan), sourceCommit, data: { sdk: plan.dotnet.sdk, reason: result.reason, subject_exit: result.subjectExit }, persist: { dir } };
}

// ---------- web ----------

const CREDENTIAL_VALUE = /^[A-Za-z0-9_\-+/=.]{24,}$/;
export function resolveWebTarget(rawUrl, config, rootOption, cwd = process.cwd()) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new UsageError('--url must be a URL such as file:///mnt/user/projects/<project>/dist/index.html'); }
  if (url.username || url.password) throw new PolicyRefused('the URL carries credentials; secrets never go in arguments (D-008)');
  for (const [k, v] of [...url.searchParams, ...new URLSearchParams(url.hash.replace(/^#/, ''))]) if (CREDENTIAL_KEY.test(k) || CREDENTIAL_VALUE.test(v)) throw new PolicyRefused('the URL carries something that looks like a credential; secrets never go in arguments (D-008)');
  if (url.protocol === 'http:' || url.protocol === 'https:') throw new PolicyRefused(`network targets (${url.protocol}//${url.host}) are not offered: browser runs reach only declared host-side targets (D-016, OQ-2). Use a file:// URL of a built page inside an allowlisted project`);
  if (url.protocol !== 'file:') throw new UsageError(`unsupported URL scheme ${url.protocol}`);
  if (url.host) throw new UsageError('file URLs must not name a host');
  let file;
  try { file = fileURLToPath(url); } catch { throw new UsageError('invalid file URL'); }
  const real = realpathOrNull(file);
  if (!real || !fs.statSync(real).isFile()) throw new UsageError('the page file does not exist');
  const root = owningRoot(config, real);
  if (!root) throw new PolicyRefused('the page is not inside an allowlisted project (unapproved target)');
  // The served directory is the page's own directory unless --root names a wider one (for sites that use root-absolute links such as /style.css).
  let serveRoot = path.dirname(real);
  if (rootOption !== undefined) {
    const given = realpathOrNull(path.resolve(cwd, rootOption));
    if (!given || !fs.statSync(given).isDirectory()) throw new UsageError('--root must be an existing directory');
    if (!owningRoot(config, given)) throw new PolicyRefused('--root is not inside an allowlisted project (unapproved target)');
    if (!inside(given, real)) throw new UsageError('the page must be inside --root');
    serveRoot = given;
  }
  const pagePath = `/${path.relative(serveRoot, real).split(path.sep).map(encodeURIComponent).join('/')}${url.search}`;
  return { root, serveRoot, pagePath, project: root };
}

async function web(ctx, io) {
  const { deps, env } = io;
  const { config } = loadConfig(env);
  const cfg = effectiveConfig(ctx, config);
  const repo = realpathOrNull(REPO_ROOT);
  const isHa = ctx.command === 'web ha';
  // The Home Assistant profile serves only its own anonymised fixture directory from the repository: no URL argument exists.
  const target = isHa ? { root: repo, serveRoot: path.join(repo, 'browser', 'fixture', 'ha'), pagePath: '/', project: repo } : resolveWebTarget(ctx.options['--url'], cfg, ctx.options['--root'], io.cwd);
  if (!allowedRoots(cfg).includes(repo)) throw new EnvironmentError(`the dev-test repository (${REPO_ROOT}) must be in "allowedProjects": the browser scripts run from its read-only mount`);
  const runsRoot = evidenceRoot(ctx, cfg);
  preflight(ctx, { config: cfg, deps, runsRoot, imageIds: ['playwright'], needPlaywrightCache: true });
  const responsive = ctx.command === 'web responsive';
  const browser = ctx.options['--browser'] ?? 'chromium';
  const navMs = Math.min(15000, Math.max(1000, Math.floor((cfg.limits.timeoutMs ?? 120000) / 2)));
  const common = ['--target', 'page', '--path', target.pagePath, '--browser', browser, '--timeout-ms', String(navMs)];
  const command = isHa
    ? ['node', '/src/browser/ha-readonly.mjs', '--target', 'page', '--page-set', 'fixture', '--browser', browser, '--timeout-ms', String(navMs), '--probe', 'clicks', '--name', 'ha']
    : responsive
    ? ['node', '/src/browser/responsive.mjs', ...common, '--profiles', ctx.options['--profiles'], '--name', 'audit']
    : ['node', '/src/browser/capture.mjs', ...common, '--profile', ctx.options['--profile'], '--name', 'shot', ...(ctx.options['--full-page'] ? ['--full-page'] : [])];
  const plan = deps.createPlan({ project: repo, runId: ctx.runId, image: 'playwright', phase: 'test', targets: ['page'], command }, cfg);
  const began = deps.now();
  const dir = createRunDir(runsRoot, plan.runId, began);
  let handle, result, artifacts = [], volumeError = null;
  try {
    handle = await deps.startTarget(target.serveRoot, targetSocketPath(plan.storage, plan.runId, 'page'), { uid: cfg.uid, gid: cfg.gid });
    result = await deps.runContainer(plan, { keepVolume: true });
    try { artifacts = collectWebArtifacts(plan.out, dir); } catch (error) { volumeError = error.code ?? error.name; }
  } finally {
    await handle?.close();
    try { if (result) deps.releaseVolumes(plan); } catch (error) { if (result) result.cleanup = 'incomplete'; }
    fs.rmSync(plan.workspace, { recursive: true, force: true });
  }
  const read = (name) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'artifacts', name), 'utf8')); } catch { return null; } };
  let exit = classifyRunner(result), lines = [], data = {}, message;
  if (exit === 1) {
    const wrapper = result.subjectExit;
    data.wrapper_exit = wrapper;
    if (isHa) {
      const summary = read('ha.summary.json');
      if (summary?.pages) {
        haData(summary, data, lines);
        if (wrapper === 16) { message = 'the page tried to change state (write request, non-read WebSocket frame or unprompted interaction) or the interaction guard was bypassed; it was blocked'; lines.push(...summary.readOnly.blockedWrites.slice(0, 5).map((w) => `  blocked write: ${w}`)); }
      }
    } else if (responsive) {
      const summary = read('audit.summary.json');
      const asserted = new Set(ctx.options['--assert'] ?? []);
      if (summary?.profiles) {
        const relevant = summary.failures.filter((f) => !asserted.size || asserted.has(f.check));
        const unrendered = summary.profiles.filter((p) => !p.rendered).map((p) => p.profile);
        data.profiles = summary.profiles.map((p) => ({ profile: p.profile, rendered: p.rendered, failures: p.failures, warnings: p.warnings }));
        data.failures = relevant.map((f) => ({ profile: f.profile, check: f.check, element: f.element }));
        data.ignored_failures = summary.failures.length - relevant.length;
        data.blocked_requests = summary.blockedRequests?.length ?? 0;
        for (const f of relevant.slice(0, 20)) lines.push(`  ${f.profile}: ${f.check} on ${f.element}`);
        if (wrapper === 15 && !relevant.length && !unrendered.length) { exit = 0; message = `no asserted layout defect across ${summary.profiles.length} profile(s)`; }
        else if (wrapper === 15) message = `${relevant.length} asserted layout failure(s)${unrendered.length ? `, ${unrendered.length} profile(s) not rendered` : ''}`;
      }
    } else {
      const rep = read('shot-' + ctx.options['--profile'] + '-' + browser + '.report.json');
      if (rep) { data.problems = (rep.problems ?? []).slice(0, 10); data.blocked_requests = rep.blockedRequests?.length ?? 0; for (const p of data.problems) lines.push(`  ${p}`); }
    }
    if (exit === 1 && !message) {
      if (wrapper === 10 && (data.problems ?? []).some((p) => /^capture failed:/.test(p))) { exit = 6; message = 'the browser wrapper crashed before testing the page; not evidence about the page. If the Playwright cache is not restored see docs/browser-runner.md'; }
      else if ([10, 11, 12, 13, 15, 16].includes(wrapper)) message = { 16: 'a state-changing action was attempted and blocked (read-only profile)', 10: 'the page reported console, page or HTTP errors', 11: 'navigation timed out', 12: 'the page tried to reach an undeclared destination (blocked)', 13: 'TLS error', 15: 'layout defect or a profile that did not render' }[wrapper];
      else { exit = 6; message = `the browser wrapper failed unexpectedly (code ${wrapper}); not evidence about the page. If the Playwright cache is not restored see docs/browser-runner.md`; }
    }
  } else if (exit === 0) {
    if (isHa) { const s = read('ha.summary.json'); if (s?.pages) haData(s, data, lines); }
    message = isHa ? 'fixture: 3 pages at phone-390 and desktop-1280 rendered, no layout defect, no state-changing action reached the page. This is the local fixture, not the live Home Assistant' : responsive ? `no layout defect across the selected profile(s)` : 'screenshot captured with no page errors';
    if (!artifacts.some((a) => a.kind === 'screenshot')) { exit = 6; message = 'run reported success but produced no screenshot'; }
    if (responsive && ctx.options['--assert']) data.asserted = ctx.options['--assert'];
  }
  if (volumeError && exit === 0) { exit = 6; message = `result files could not be read (${volumeError})`; }
  if (result.cleanup !== 'complete' && exit !== 130 && exit !== 5) { exit = exit === 6 ? 6 : 7; message = `${message ?? ''} (cleanup incomplete)`.trim(); }
  message ??= { 3: 'environment precondition missing', 4: 'refused by runner policy', 5: 'time limit exceeded; the container was stopped and removed', 6: 'runner failed; not evidence about the page', 7: 'finished but cleanup was incomplete', 130: 'interrupted' }[exit];
  return { exit, runId: plan.runId, message, workspace: dir, artifacts, cleanup: result.cleanup, image: imageInfo(plan), sourceCommit: deps.commit(target.project), data, lines, persist: { dir } };
}

function haData(summary, data, lines) {
  data.page_set = summary.pageSet;
  data.pages = summary.pages.map((p) => ({ page: p.page, profiles: p.profiles.map((x) => ({ profile: x.profile, rendered: x.rendered, failures: x.failures, warnings: x.warnings })) }));
  data.read_only = { blocked_writes: summary.readOnly.blockedWrites.length, blocked_frames: summary.readOnly.blockedFrames.length, blocked_interactions: summary.readOnly.blockedInteractions.length, probe: summary.probe };
  data.blocked_requests = summary.blockedRequests?.length ?? 0;
  for (const p of summary.pages) for (const f of p.failures.slice(0, 10)) lines.push(`  ${p.page} / ${f.profile}: ${f.check} on ${f.element}`);
}

// `web ha --live`: decides, and reports, whether the real Home Assistant may be used. It reads the credential POLICY (paths, never values),
// the decision register and the runner's network capability. It starts nothing and logs in to nothing. Today it is blocked, and says why.
async function haLive(ctx, io) {
  const { config } = loadConfig(io.env);
  const file = config.openbao?.policyFile;
  let policy = null, policyNote = null;
  if (!file) policyNote = 'no OpenBao credential policy is configured (openbao.policyFile)';
  else { try { policy = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { policyNote = `the credential policy is unreadable (${error.name === 'SyntaxError' ? 'not JSON' : error.code ?? error.name})`; } }
  const gate = evaluateLiveGate({ policy: policy ?? undefined, networkRoute: 'unavailable' });
  const reasons = policyNote ? [policyNote, ...gate.reasons.filter((r) => !/^credential policy unusable/.test(r))] : gate.reasons;
  const status = 'blocked';
  return { exit: 4, runId: ctx.runId, message: `live Home Assistant acceptance is BLOCKED (${gate.host}); nothing was contacted and no success is claimed`,
    data: { live: { status, host: gate.host, reasons }, fixture_alternative: 'dev-test web ha' }, lines: reasons.map((r) => `  - ${r}`) };
}

// ---------- doctor ----------

async function doctor(ctx, io) {
  const { deps, env } = io;
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });
  let config = null;
  try { const loaded = loadConfig(env); config = loaded.config; add('config', 'ok', loaded.file); } catch (error) { add('config', 'fail', error.message); }
  const problem = dockerProblem(deps);
  add('docker', problem ? 'fail' : 'ok', problem ?? 'daemon reachable');
  if (config) {
    const st = fs.statSync(config.storageRoot, { throwIfNoEntry: false });
    let writable = false;
    try { fs.accessSync(config.storageRoot, fs.constants.W_OK); writable = !!st?.isDirectory(); } catch { /* reported below */ }
    add('storage', writable ? 'ok' : 'fail', writable ? config.storageRoot : `${config.storageRoot} is missing or not writable`);
    let runsRoot = null;
    try { runsRoot = evidenceRoot(ctx, config); } catch (error) { add('run-dir', 'fail', error.message); }
    if (runsRoot) { const exists = fs.statSync(runsRoot, { throwIfNoEntry: false })?.isDirectory(); let ok = false; try { fs.accessSync(exists ? runsRoot : path.dirname(runsRoot), fs.constants.W_OK); ok = true; } catch { /* below */ } add('run-dir', ok ? 'ok' : 'fail', `${runsRoot}${exists ? '' : ' (created on first run)'}`); }
    for (const [id, entry] of Object.entries(config.lock?.images ?? {})) {
      if (problem) { add(`image ${id}`, 'warn', 'not checked: Docker unavailable'); continue; }
      const present = deps.docker(['image', 'inspect', '--format', '{{.Id}}', entry.reference]).status === 0;
      add(`image ${id}`, present ? 'ok' : 'fail', present ? entry.reference.split('@')[1].slice(0, 19) : 'pinned image not present locally; pull through the reviewed update path');
    }
    for (const name of ['playwright', 'nuget-sdk-8', 'nuget-sdk-9', 'nuget-sdk-10']) {
      if (name === 'playwright') { const c = playwrightCacheState(config); add('cache playwright', c.ok ? 'ok' : 'warn', c.ok ? c.reason : `${c.reason} (browser commands need node browser/prepare-cache.mjs and node browser/restore-cache.mjs)`); continue; }
      const there = fs.existsSync(path.join(config.storageRoot, 'cache', `${name}.img`));
      add(`cache ${name}`, there ? 'ok' : 'warn', there ? 'present' : 'created on first use');
    }
    const repo = realpathOrNull(REPO_ROOT);
    add('allowlist', allowedRoots(config).includes(repo) ? 'ok' : 'warn', allowedRoots(config).includes(repo) ? 'dev-test repository is allowlisted' : 'dev-test repository is not in allowedProjects (web commands will be refused)');
    const address = config.openbao?.address;
    if (!address) add('openbao', 'warn', 'not configured (no credential is needed for non-authenticated runs)');
    else {
      try { const h = await deps.health({ address }); add('openbao', h.reachable && !h.sealed ? 'ok' : 'warn', h.reachable ? `reachable, ${h.sealed ? 'SEALED' : 'unsealed'}, initialized=${h.initialized}` : 'not reachable'); }
      catch (error) { add('openbao', 'warn', `address refused: ${error.message}`); }
    }
    const policyFile = config.openbao?.policyFile;
    if (!policyFile) add('openbao policy', 'warn', 'not configured');
    else { try { validatePolicy(JSON.parse(fs.readFileSync(policyFile, 'utf8'))); add('openbao policy', 'ok', 'valid (paths only; no values read)'); } catch (error) { add('openbao policy', 'fail', `invalid or unreadable: ${error.name === 'SyntaxError' ? 'not JSON' : error.message}`); } }
  }
  const failed = checks.filter((c) => c.status === 'fail');
  return { exit: failed.length ? 3 : 0, message: failed.length ? `${failed.length} check(s) failed: ${failed.map((c) => c.name).join(', ')}` : 'environment ready', data: { checks }, lines: checks.map((c) => `  [${c.status}] ${c.name}: ${c.detail}`) };
}

// ---------- report ----------

function report(ctx, io) {
  const { config } = loadConfig(io.env);
  const id = ctx.positionals[0];
  if (!/^[a-f0-9]{16,32}$/.test(id)) throw new UsageError('report takes a run id (16 to 32 lowercase hex characters)');
  const root = evidenceRoot(ctx, config);
  const dir = findRunDir(root, id);
  if (!dir) throw new UsageError(`no stored result for run ${id} in ${root}`);
  let stored;
  try { stored = readStoredResult(dir); } catch { return { exit: 6, runId: id, message: 'stored result.json is not valid JSON' }; }
  if (!stored) return { exit: 6, runId: id, message: 'the run directory has no result.json' };
  const lines = [`  stored: ${stored.command} -> ${stored.status} (exit ${stored.exit_code})${stored.message ? ` - ${stored.message}` : ''}`, ...(stored.artifacts ?? []).map((a) => `  ${a.kind}: ${a.path} (${a.bytes} bytes)`)];
  return { exit: 0, runId: id, message: `stored result for run ${id}`, workspace: dir, artifacts: stored.artifacts ?? [], data: { stored }, lines };
}

// ---------- cleanup ----------

function cleanup(ctx, io) {
  const { deps, env } = io;
  const { config } = loadConfig(env);
  const storage = realpathOrNull(config.storageRoot);
  if (!storage || !fs.statSync(storage).isDirectory()) throw new EnvironmentError(`storage root ${config.storageRoot} does not exist`);
  const dry = ctx.options['--dry-run'] === true;
  const only = ctx.options['--run-id'];
  const cutoff = ctx.options.olderThanMs ? deps.now().getTime() - ctx.options.olderThanMs : null;
  const runs = path.join(storage, 'runs');
  const evidence = evidenceRoot(ctx, config);
  const mounts = deps.mounts();
  const entries = [];
  const problem = dockerProblem(deps);
  const names = fs.existsSync(runs) ? fs.readdirSync(runs, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink() && /^[a-f0-9]{16,32}$/.test(e.name)).map((e) => e.name) : [];
  if (names.length && problem && !dry) throw new EnvironmentError(`cannot verify that no container uses a workspace: ${problem}`);
  if (names.length && !dry) { try { deps.sweep(storage, deps.docker); } catch { /* a failed sweep only leaves mounted workspaces reported below */ } }
  const mountedNow = names.length && !dry ? deps.mounts() : mounts;
  for (const id of names) {
    if (only && id !== only) continue;
    const ws = path.join(runs, id);
    if (cutoff !== null && fs.lstatSync(ws).mtimeMs > cutoff) continue;
    const entry = { run_id: id, kind: 'workspace', path: ws };
    if (mountedNow.split('\n').some((l) => { const mp = l.split(' ')[1]; return mp && inside(ws, mp.replace(/\\040/g, ' ')); })) Object.assign(entry, { action: 'skipped', reason: 'a volume is still mounted' });
    else if (!problem && deps.docker(['container', 'inspect', '--format', '{{.Id}}', `devtest-${id}`]).status === 0) Object.assign(entry, { action: 'skipped', reason: 'a container with this run id exists' });
    else if (dry) entry.action = 'would_remove';
    else { fs.rmSync(ws, { recursive: true, force: true }); entry.action = fs.existsSync(ws) ? 'failed' : 'removed'; }
    entries.push(entry);
  }
  // Evidence is removed only when its run id is named; --older-than never touches it.
  if (only) {
    const dir = findRunDir(evidence, only);
    if (dir) {
      const entry = { run_id: only, kind: 'evidence', path: dir };
      if (dry) entry.action = 'would_remove'; else { fs.rmSync(dir, { recursive: true, force: true }); entry.action = fs.existsSync(dir) ? 'failed' : 'removed'; }
      entries.push(entry);
    }
  }
  const bad = entries.filter((e) => e.action === 'failed' || (e.action === 'skipped' && only));
  const count = (a) => entries.filter((e) => e.action === a).length;
  const message = `${dry ? `${count('would_remove')} would be removed` : `${count('removed')} removed`}, ${count('skipped')} skipped, ${count('failed')} failed`;
  return { exit: bad.length ? 7 : 0, message, cleanup: bad.length ? 'incomplete' : 'complete', data: { dry_run: dry, entries }, lines: entries.map((e) => `  ${e.action} ${e.kind} ${e.run_id}${e.reason ? ` (${e.reason})` : ''}`) };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
