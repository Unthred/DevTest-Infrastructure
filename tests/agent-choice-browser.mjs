#!/usr/bin/env node
// Tower browser check for the Next-card agent-choice reason. The view comes from the real dashboard data and renderer; its planned
// actions use the real choice core, including a configured default for issue 1166. It runs pinned Chromium at 1280 and 390 wide.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlan, releaseVolumes, runContainer, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { currentView } from '../supervisor/dashserver.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { nextWhyFields } from '../supervisor/holdreason.mjs';
import { chooseAgent, describeChoice } from '../supervisor/agentchoice.mjs';
import { expectedShare } from '../supervisor/jobshare.mjs';
import { freezeLivePanels, stageDashui } from './helpers/dashui-stage.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.resolve(process.argv[2] || '');
const temporaryRoot = process.env.TMPDIR;
if (!process.argv[2] || !temporaryRoot) {
  console.error('usage: TMPDIR=<directory> node tests/agent-choice-browser.mjs <output-dir>');
  process.exit(2);
}
const now = Date.now();
const root = fs.mkdtempSync(path.join(temporaryRoot, 'agentchoice-state-'));
const site = fs.mkdtempSync(path.join(temporaryRoot, 'agentchoice-site-'));
const storageRoot = temporaryRoot;

function config() {
  return {
    schema_version: 1,
    enabled: true,
    repository: 'o/r',
    repo_path: '/p/r',
    worktree_base: '/p',
    access: { mode: 'full', decision: 'D-020' },
    inbox: { dir: path.join(root, 'inbox') },
    github_app: { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
  };
}

function candidate(id, share, changes = {}) {
  return {
    id,
    mayDo: true,
    freeSlot: true,
    capacity: 100,
    weekly: { used: 0.1, resetsAt: now + 72 * 60 * 60 * 1000 },
    short: { used: 0.1, resetsAt: now + 72 * 60 * 60 * 1000 },
    rate: { weekly: 0.001, short: 0.001 },
    share,
    ...changes,
  };
}

function action(type, ref, result) {
  return {
    agent: result.chosen,
    type,
    issue: type === 'implement' ? ref : undefined,
    pr: type === 'implement' ? undefined : ref,
    why: describeChoice(result),
  };
}

async function dashboardHtml() {
  for (const name of ['jobs', 'dashboard', 'team', 'inbox/items', 'inbox/status']) {
    fs.mkdirSync(path.join(root, name), { recursive: true });
  }
  const cache = { tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls: [], issues: [] };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
  const view = await currentView({ root, config: config(), now, tz: 'UTC' });
  const defaultShare = expectedShare({
    jobs: [{ type: 'implement', tokens: 5, finishedAt: now - 60000 }],
    type: 'implement',
    capacity: 100,
  });
  const implement = chooseAgent({
    now,
    candidates: [candidate('alpha', { weekly: 0.04, short: 0.28, source: 'history', note: 'median history' }), candidate('beta', defaultShare)],
  });
  const repair = chooseAgent({
    now,
    candidates: [candidate('missing', { weekly: 0.04, short: 0.28 }, { weekly: undefined }), candidate('gamma', { weekly: 0.03, short: 0.21 })],
  });
  const implementAction = action('implement', 1166, implement);
  const repairAction = action('fix', 7, repair);
  view.panels.next = [
    { agent: implementAction.agent, type: implementAction.type, ref: implementAction.issue, ...nextWhyFields(implementAction, value => value) },
    { agent: repairAction.agent, type: repairAction.type, ref: repairAction.pr, ...nextWhyFields(repairAction, value => value) },
    { agent: 'reviewer', type: 'review', ref: 22, ...nextWhyFields({ why: "today's review rank and independence rule" }, value => value) },
    { agent: 'nobody', type: 'implement', ref: 44, ...nextWhyFields({}, value => value) },
  ];
  const rendered = renderRoute(view, { page: 'overview' }, { query: new URLSearchParams(), pathname: '/' }).html;
  return freezeLivePanels(rendered).replace(/<meta http-equiv="refresh"[^>]*>/, '');
}

function createRunnerConfig(lock) {
  const uid = process.getuid() === 0 ? 99 : process.getuid();
  const gid = process.getgid() === 0 ? 100 : process.getgid();
  return {
    allowedProjects: [here],
    storageRoot,
    uid,
    gid,
    lock,
    limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 },
  };
}

async function runBrowserChecks(config, siteDirectory, failures) {
  const run = async (name, spec, target = null) => {
    const runId = crypto.randomBytes(8).toString('hex');
    const plan = createPlan({ project: here, runId, image: 'playwright', ...spec, targets: target ? ['fixture'] : [] }, config);
    const socket = targetSocketPath(storageRoot, runId, 'fixture');
    const server = target
      ? await listenOnSocket(createStaticServer(target), socket, { uid: config.uid, gid: config.gid })
      : null;
    try {
      const result = await runContainer(plan, { keepVolume: true });
      console.log(JSON.stringify({ run: name, exit: result.subjectExit, cleanup: result.cleanup }));
      if (result.subjectExit !== 0 || result.cleanup !== 'complete') failures.push(`${name}: exit ${result.subjectExit}, cleanup ${result.cleanup}`);
      if (target) {
        for (const file of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, file), path.join(output, file));
      }
    } finally {
      await server?.close();
      releaseVolumes(plan);
    }
  };
  const packageLock = config.lock.packages['playwright-core'];
  const restoreCommand = [
    'sh',
    '-c',
    `tar -xzf /src/browser/vendor/playwright-core-${packageLock.version}.tgz -C /cache && test -f /cache/package/index.mjs`,
  ];
  await run('restore', { phase: 'restore', command: restoreCommand });
  for (const profile of ['desktop-1280', 'phone-390']) {
    const command = [
      'node',
      '/src/browser/agent-choice-scenario.mjs',
      '--target',
      'fixture',
      '--profile',
      profile,
      '--name',
      `agent-choice-${profile}`,
    ];
    await run(profile, { phase: 'test', command }, siteDirectory);
  }
}

const failures = [];
try {
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(site, 'card.html'), await dashboardHtml());
  stageDashui(site, path.join(here, 'supervisor', 'dashui'));
  const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker', 'images.lock.json'), 'utf8'));
  await runBrowserChecks(createRunnerConfig(lock), site, failures);
} finally {
  fs.rmSync(site, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`AGENT CHOICE REASON BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('AGENT CHOICE REASON BROWSER CHECK OK');
