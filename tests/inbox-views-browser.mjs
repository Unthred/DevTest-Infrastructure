#!/usr/bin/env node
// Tower-only browser check of the Inbox view switch (issue #1219), in the pinned Chromium container (same path as tests/lists-browser.mjs).
// The page is the real /inbox route: dashserver's handler serves it, with the real static scripts, over the declared Unix socket, from a
// fixture inbox built through the real store (tests/helpers/inbox-views-fixture.mjs). Only the Host header is set to the one the handler
// expects, because the container reaches the socket through a loopback port the host does not know. Results go to the directory in argv[2].
// Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { listenOnSocket } from '../browser/static-server.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { stageProject } from './stage-project.mjs';
import { buildInbox } from './helpers/inbox-views-fixture.mjs';
import * as inbox from '../supervisor/inbox.mjs';
import { transcriptFile } from '../supervisor/transcript.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/inbox-views-browser.mjs <output-dir>'); process.exit(2); }
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/inbox-views', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ivbrowser-'));
for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [] }));
buildInbox(path.join(root, 'inbox'), Date.now(), { layout: true });
// Issue #1466: the three jobs running at 16:15 UTC on 14 Nov 2026, as job records the real dashboard reads (the review 2 minutes old, the
// implement job 12 minutes old, the fix job 3 h 10 min old), and the Inbox card the implement job's issue was posted from.
const jobAt = (ms, o) => {
  const record = { status: 'running', provider: 'claude', createdAt: Date.now() - ms, updatedAt: Date.now(), ...o };
  fs.writeFileSync(path.join(root, 'jobs', `${o.id}.json`), JSON.stringify(record));
};
jobAt(2 * 60000, { id: 'a'.repeat(32), kind: 'review', model: 'opus', issue: 1457, pr: 1457, attempts: 0 });
jobAt(12 * 60000, { id: 'b'.repeat(32), kind: 'implement', model: 'sonnet', issue: 1449, attempts: 1 });
jobAt(190 * 60000, { id: 'c'.repeat(32), kind: 'fix', model: 'sonnet', issue: 1443, pr: 1443, attempts: 1 });
for (const c of 'abc') {   // a transcript exists, so Watch live shows
  const file = transcriptFile(root, c.repeat(32));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
}
{
  const dir = path.join(root, 'inbox'), id = crypto.randomBytes(16).toString('hex');
  const draft = { kind: 'issue_draft', title: 'About box in the web UI shows the version Aboutpanel', body: 'Draft.' };
  fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(draft));
  inbox.scan(dir, Date.now() - 86400000);
  inbox.decide(dir, id, 'approve', Date.now() - 80000000);
  inbox.finish(dir, id, { state: 'done', issue: 1449, result: 'posted as issue #1449' }, Date.now() - 70000000);
}
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: path.join(root, 'inbox') },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
const HOST = '127.0.0.1', PORT = 8080;
const dash = handler({ wake: () => {}, root, config, host: HOST, port: PORT });
const failures = [];
const run = async (name, spec, serve) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: serve ? ['fixture'] : [] }, cfg);
  const server = serve ? await listenOnSocket(http.createServer((req, res) => { req.headers.host = `${HOST}:${PORT}`; dash(req, res); }), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup }));
    if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (serve) for (const f of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await server?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true });
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390'])
    await run(profile, { phase: 'test', command: ['node', '/src/browser/inbox-views-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `inbox-views-${profile}`] }, true);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`INBOX VIEWS BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('INBOX VIEWS BROWSER CHECK DONE');
