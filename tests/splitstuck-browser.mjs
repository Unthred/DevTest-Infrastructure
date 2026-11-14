#!/usr/bin/env node
// Tower-only browser check for the real dashboard split card and pull request page (issue #1343).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlan, releaseVolumes, runContainer, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { currentView } from '../supervisor/dashserver.mjs';
import { renderRoute } from '../supervisor/dashrender.mjs';
import { stageProject } from './stage-project.mjs';
import { freezeLivePanels, stageDashui } from './helpers/dashui-stage.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
const tempBase = process.env.TMPDIR;
if (!process.argv[2]) {
  console.error('usage: node tests/splitstuck-browser.mjs <output-dir>');
  process.exit(2);
}
if (!tempBase) {
  console.error('TMPDIR is required for the temporary dashboard state');
  process.exit(2);
}
const temporaryDir = prefix => fs.mkdtempSync(path.join(tempBase, prefix));
const HEAD = 'a'.repeat(40);
const now = Date.now();
const real = JSON.parse(fs.readFileSync(path.join(here, 'tests/fixtures/split-stuck/pr1139.json'), 'utf8'));
const ITEMS = [
  { title: 'Capacity team', files: ['supervisor/capacityteam.mjs', 'tests/capacity-planner.test.mjs'] },
  { title: 'Issue assignment', files: ['supervisor/issueassign.mjs', 'tests/overseer-control.test.mjs'] },
  { title: 'Inbox agent and pass speed', files: ['supervisor/inboxagent.mjs', 'tests/pass-speed.test.mjs', 'tests/test-resources.test.mjs'] },
];
const config = root => ({
  schema_version: 1,
  enabled: true,
  repository: 'o/r',
  repo_path: '/p/r',
  worktree_base: '/p',
  access: { mode: 'full', decision: 'D-020' },
  inbox: { dir: path.join(root, 'inbox') },
  github_app: { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 4 },
  agents: {
    claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] },
    codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] },
  },
});

async function render(filed, route = { page: 'overview' }) {
  const root = temporaryDir('splitstuck-state-');
  try {
    for (const directory of ['jobs', 'dashboard', 'team', 'inbox/items', 'inbox/status']) {
      fs.mkdirSync(path.join(root, directory), { recursive: true });
    }
    const pr = real.pr;
    const pulls = [{
      number: pr.number,
      title: pr.title,
      state: 'OPEN',
      headRefName: pr.headRefName,
      headRefOid: pr.headRefOid,
      labels: ['parked'],
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }],
    }];
    const stuckSplits = {
      [pr.number]: {
        status: filed ? 'filed' : 'proposed',
        cause: 'fix-limit',
        reason: '4 fix rounds (limit 4) have not cleared the review findings',
        issue: pr.sourceIssue,
        head: pr.headRefOid,
        parked: true,
        items: ITEMS.map(item => ({ ...item, scope: item.title, acceptance: [], tests: [] })),
        ...(filed ? { filed: [2000, 2001, 2002] } : {}),
      },
    };
    const cache = { tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls, issues: [] };
    const state = { fixAttempts: { [`${pr.number}:${pr.headRefOid}`]: 4 }, verdicts: {}, jobs: {}, stuckSplits };
    fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify(cache));
    fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify(state));
    const view = await currentView({ root, config: config(root), now, tz: 'UTC' });
    const page = renderRoute(view, route, { query: new URLSearchParams(), pathname: '/' }).html;
    return freezeLivePanels(page).replace('<meta name="refresh-seconds" content="60">', '<meta name="refresh-seconds" content="3">');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/splitstuck', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid();
const gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid);
const project = stage.project;
const runnerConfig = {
  allowedProjects: [project],
  storageRoot,
  uid,
  gid,
  lock,
  limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 },
};
const failures = [];

async function run(name, spec, site) {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: site ? ['fixture'] : [] }, runnerConfig);
  const server = site
    ? await listenOnSocket(createStaticServer(site), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid })
    : null;
  try {
    const result = await runContainer(plan, { keepVolume: true });
    console.log(JSON.stringify({ run: name, exit: result.subjectExit, cleanup: result.cleanup }));
    if (result.subjectExit !== 0 || result.cleanup !== 'complete') {
      failures.push(`${name}: exit ${result.subjectExit}, cleanup ${result.cleanup}`);
    }
    if (site) {
      for (const file of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, file), path.join(outDir, file));
    }
  } finally {
    await server?.close();
    releaseVolumes(plan);
  }
}

const site = temporaryDir('splitstuck-site-');
try {
  const pages = await Promise.all([
    render(false),
    render(true),
    render(false, { page: 'pr', id: real.pr.number }),
    render(true, { page: 'pr', id: real.pr.number }),
  ]);
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(outDir, { recursive: true });
  stageDashui(site, path.join(here, 'supervisor', 'dashui'));
  for (const [file, page] of [['a.html', pages[0]], ['b.html', pages[1]], ['pr-proposed.html', pages[2]], ['pr.html', pages[3]]]) {
    fs.writeFileSync(path.join(site, file), page);
  }
  for (const file of fs.readdirSync(site, { recursive: true })) {
    const target = path.join(site, file);
    fs.chmodSync(target, fs.statSync(target).isDirectory() ? 0o755 : 0o644);
  }
  fs.chmodSync(site, 0o755);
  const pkg = lock.packages['playwright-core'];
  await run('restore', {
    phase: 'restore',
    command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`],
  });
  for (const profile of ['desktop-1280', 'phone-390']) {
    await run(profile, {
      phase: 'test',
      command: ['node', '/src/browser/splitstuck-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `splitstuck-${profile}`],
    }, site);
  }
} finally {
  fs.rmSync(storageRoot, { recursive: true, force: true });
  fs.rmSync(site, { recursive: true, force: true });
  stage.cleanup();
}
if (failures.length) {
  console.error(`SPLIT STUCK BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('SPLIT STUCK BROWSER CHECK OK');
