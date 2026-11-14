#!/usr/bin/env node
// Tower-only browser check for the About box (issue #1449), in the pinned Chromium container (same path as tests/ui-appbar-browser.mjs).
// Serves the REAL dashboard request handler (supervisor/dashserver.mjs) with the REAL contract folder, so the real about model and the real web UI
// files answer over a temporary state root holding the real records of the 14 Nov 2026 09:18 install of f748e46 (pull request 1425, issue 1424),
// two installs on 13 Nov, and one pull request whose title holds angle brackets. A wrapper in front fails the about request on demand
// (/__fixture/about-fail-on and -off) and serves a state root with no installs on /__fixture/empty. Runs browser/ui-about-scenario.mjs at 1280 and 390 wide.
// Run `node browser/prepare-cache.mjs` first. Results go to argv[2].
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { listenOnSocket } from '../browser/static-server.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { stageProject } from './stage-project.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/ui-about-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const base = '/mnt/cache/appdata/devtest-infrastructure';
const storageRoot = path.join(base, 'ui-about', crypto.randomBytes(6).toString('hex'));
const stateRoot = fs.mkdtempSync(path.join(base, 'ui-about-state-'));
const emptyRoot = fs.mkdtempSync(path.join(base, 'ui-about-empty-'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };

// 14 Nov 2026 12:00 UTC is "now" for the dashboard and, through the scenario, for the browser clock.
const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const SHA = { old: '5b160d0aa74268c6870a503f6d63d3b82c725550', now: 'f748e468cf21be20e62d99b5c3a5d9c28b36f084', a: 'a880f7bf8763837da321956bd1cd2bf5f78f872c', b: '0123456789abcdef0123456789abcdef01234567', c: '89abcdef0123456789abcdef0123456789abcdef' };
const record = (at, result, from, to, prs) => JSON.stringify({ at, from, to, result, prs });
const issue = (number, title, body) => ({ kind: 'issue', number, title, state: 'CLOSED', body });
const pr = (number, title, closes) => ({ kind: 'pr', number, title, state: 'MERGED', closes });

function seed(root, { installs }) {
  for (const d of ['jobs', 'dashboard', 'team', 'versions']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.symlinkSync(`versions/${installs ? SHA.now : SHA.old}`, path.join(root, 'current'));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [], delivered: [] }));
  if (!installs) return;
  const day13 = h => Date.UTC(2026, 10, 13, h, 0, 0), day12 = Date.UTC(2026, 10, 12, 8, 0, 0), at = Date.UTC(2026, 10, 14, 9, 18, 33);
  const lines = [
    record(day12, 'upgraded', SHA.b, SHA.a, [1410]), record(day12 + 90000, 'verified', SHA.b, SHA.a, [1410]),
    record(day13(8), 'upgraded', SHA.a, SHA.c, [1411]), record(day13(8) + 90000, 'verified', SHA.a, SHA.c, [1411]),
    record(day13(20), 'upgraded', SHA.c, SHA.old, [1412]), record(day13(20) + 90000, 'verified', SHA.c, SHA.old, [1412]),
    record(at, 'upgraded', SHA.old, SHA.now, [1425, 1426]), record(at + 114000, 'verified', SHA.old, SHA.now, [1425, 1426]),
  ];
  fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), `${lines.join('\n')}\n`);
  const items = [
    issue(1424, 'Agent choice stalls V2-9 Roomgate', 'Tier: 0\n\nThe agent choice starts a job whenever a candidate actually has room left for it. More words follow.'),
    pr(1425, 'Fix the agent choice', [1424]),
    issue(1427, 'Look of the board V2-10 Boardlook', 'Tier: 5\n\nThe live board shows a <b>bold</b> legend under the picture.'),
    pr(1426, 'Board legend', [1427]),
    issue(1409, 'Inbox V2-3 Inboxfix', 'Tier: 0\n\nThe inbox no longer shows a card twice.'), pr(1410, 'Inbox fix', [1409]),
    issue(1413, 'Menu V2-4 Menus', 'Tier: 1\n\nThe menu opens faster.'), pr(1411, 'Menu', [1413]),
    issue(1414, 'Cleanup V2-5 Tidyup', 'Tier: 6\n\nThe old settings files are gone.'), pr(1412, 'Cleanup', [1414]),
  ];
  fs.writeFileSync(path.join(root, 'dashboard', 'issue-index.json'), JSON.stringify({ schema: 1, items: Object.fromEntries(items.map(i => [`${i.kind}:${i.number}`, i])) }));
}

const failures = [];
const run = async (name, spec, server) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: server ? ['fixture'] : [] }, cfg);
  const listening = server ? await listenOnSocket(server, targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup }));
    if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (server) for (const f of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await listening?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true });
  seed(stateRoot, { installs: true }); seed(emptyRoot, { installs: false });
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390']) {
    const make = root => handler({ wake: () => {}, root, config, host: '127.0.0.1', port: 8731, now: () => NOW });
    const real = make(stateRoot), empty = make(emptyRoot);
    let failing = false;
    const server = http.createServer((req, res) => {
      req.headers.host = '127.0.0.1:8731';
      if (req.url === '/__fixture/about-fail-on' || req.url === '/__fixture/about-fail-off') {
        failing = req.url.endsWith('-on');
        res.writeHead(200).end('ok');
        return;
      }
      if (failing && new URL(req.url, 'http://x').pathname === '/api/v1/about') {
        res.writeHead(500, { 'content-type': 'application/json' }).end('{"error":"fixture failure"}');
        return;
      }
      // The same page, but its about model comes from the state root with no installs.
      if (req.headers.referer?.includes('empty=1') && new URL(req.url, 'http://x').pathname === '/api/v1/about') return empty(req, res);
      return real(req, res);
    });
    await run(profile, { phase: 'test', command: ['node', '/src/browser/ui-about-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `ui-about-${profile}`] }, server);
  }
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(stateRoot, { recursive: true, force: true }); fs.rmSync(emptyRoot, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`UI ABOUT BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('UI ABOUT BROWSER CHECK DONE');
