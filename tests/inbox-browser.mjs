#!/usr/bin/env node
// Tower-only browser check for the Inbox page (issue #884), in the pinned Chromium container (same path as tests/lists-browser.mjs).
// Renders the Inbox page and the Overview from fake data (no supervisor state), stages the real static files, and runs browser/inbox-scenario.mjs
// at a laptop and a phone width. Results (JSON, screenshots) go to the directory in argv[2]. Run `node browser/prepare-cache.mjs` first.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createPlan, runContainer, releaseVolumes, targetSocketPath } from '../docker/runner.mjs';
import { createStaticServer, listenOnSocket } from '../browser/static-server.mjs';
import { stageProject } from './stage-project.mjs';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), outDir = path.resolve(process.argv[2] || '');
if (!process.argv[2]) { console.error('usage: node tests/inbox-browser.mjs <output-dir>'); process.exit(2); }
const { overviewView, NOW } = await import(pathToFileURL(path.join(here, 'tests/helpers/lists-fixture.mjs')).href);
const { renderRoute } = await import(pathToFileURL(path.join(here, 'supervisor/dashrender.mjs')).href);
const { markDuplicates } = await import(pathToFileURL(path.join(here, 'supervisor/inbox.mjs')).href);
const lock = JSON.parse(fs.readFileSync(path.join(here, 'docker/images.lock.json'), 'utf8'));

// Seven proposals: three kinds, a same-titled pair (the second is newer), one that needs its own confirmation, long text on the phone.
const hexId = n => n.toString(16).padStart(2, '0').repeat(16);
const card = (n, kind, title, why, extra = {}) => ({ id: hexId(n), kind, title, why, hash: `${n}`.padStart(12, 'f'), createdAt: NOW - n * 3600000, strong: false, will: 'Start one supervised Foreman job.',
  text: kind === 'issue_draft' ? `# Plan\n\nA **bold** claim with \`code\`.\n\n- first\n- second\n\nzebra-in-body-only` : `Do the work called ${title}.`, ...extra });
const cards = markDuplicates([
  card(0xa1, 'issue_draft', 'Project board update: one GraphQL rate limit', 'The board query hits the limit.'),
  card(0xb2, 'prompt', 'Tidy the docs index', 'Links are broken.'),
  card(0xc3, 'action', 'Stop the stuck job', 'It has not moved for a day.'),
  card(0xd4, 'prompt', 'Tidy the docs index', 'Same again, reworded.', { createdAt: NOW - 600000 }),
  card(0xe5, 'issue_draft', 'Retire the old script', 'Dead code.'),
  card(0xf6, 'prompt', 'A very long title that must wrap on a phone without any horizontal scrolling because the buttons still have to be reachable', 'Checks wrapping of a long line.'),
  card(0x17, 'action', 'Merge pull request 5', 'Ready.', { strong: true })]);
const view = await overviewView({ needs: 3 });
view.panels.inbox = cards; view.panels.inboxDecided = [];
view.panels.needsYou.unshift({ id: 'inbox-waiting', severity: 'action', text: `${cards.length} overseer proposals waiting`, ref: null, decision: 'Approve or reject them in the Inbox.', tried: '', links: [{ url: '/inbox', text: 'Open the Inbox' }], command: null });
const storageRoot = path.join('/mnt/cache/appdata/devtest-infrastructure/inbox', crypto.randomBytes(6).toString('hex'));
const uid = process.getuid() === 0 ? 99 : process.getuid(), gid = process.getgid() === 0 ? 100 : process.getgid();
const stage = stageProject(here, uid, gid), project = stage.project;
const cfg = { allowedProjects: [project], storageRoot, uid, gid, lock, limits: { cpus: 2, memoryMb: 2048, pids: 256, shmMb: 256, timeoutMs: 240000, diskMb: 256, cacheMb: 64 } };
const site = fs.mkdtempSync('/mnt/cache/appdata/devtest-infrastructure/inbox-site-');
fs.mkdirSync(path.join(site, 'static'), { recursive: true });
for (const f of fs.readdirSync(path.join(here, 'supervisor/dashui'))) if (/\.(m?js|css)$/.test(f)) fs.copyFileSync(path.join(here, 'supervisor/dashui', f), path.join(site, 'static', f));
const proof = html => html.replace(/(<form method="post"[^>]*>)/g, '$1<input type="hidden" name="proof" value="fixture-proof">').replace(/<meta http-equiv="refresh"[^>]*>/, '');
const page = (route, pathname) => proof(renderRoute(view, route, { query: new URLSearchParams(), pathname }).html);
fs.writeFileSync(path.join(site, 'inbox.html'), page({ page: 'inbox' }, '/inbox')); fs.writeFileSync(path.join(site, 'overview.html'), page({ page: 'overview' }, '/'));
fs.chmodSync(site, 0o755); fs.chmodSync(path.join(site, 'static'), 0o755); for (const f of fs.readdirSync(site, { recursive: true })) { const p = path.join(site, f); fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o755 : 0o644); }
const failures = [];
const run = async (name, spec, dir) => {
  const runId = crypto.randomBytes(8).toString('hex');
  const plan = createPlan({ project, runId, image: 'playwright', ...spec, targets: dir ? ['fixture'] : [] }, cfg);
  const server = dir ? await listenOnSocket(createStaticServer(dir), targetSocketPath(storageRoot, runId, 'fixture'), { uid, gid }) : null;
  try {
    const r = await runContainer(plan, { keepVolume: true }); console.log(JSON.stringify({ run: name, exit: r.subjectExit, cleanup: r.cleanup }));
    if (r.subjectExit !== 0 || r.cleanup !== 'complete') failures.push(`${name}: exit ${r.subjectExit}, cleanup ${r.cleanup}`);
    if (dir) for (const f of fs.readdirSync(plan.out)) fs.copyFileSync(path.join(plan.out, f), path.join(outDir, f));
  } finally { await server?.close(); releaseVolumes(plan); }
};
try {
  fs.mkdirSync(storageRoot, { recursive: true, mode: 0o700 }); fs.mkdirSync(outDir, { recursive: true });
  const pkg = lock.packages['playwright-core'];
  await run('restore', { phase: 'restore', command: ['sh', '-c', `tar -xzf /src/browser/vendor/playwright-core-${pkg.version}.tgz -C /cache && test -f /cache/package/index.mjs`] });
  for (const profile of ['desktop-1280', 'phone-390']) await run(profile, { phase: 'test', command: ['node', '/src/browser/inbox-scenario.mjs', '--target', 'fixture', '--profile', profile, '--name', `inbox-${profile}`] }, site);
} finally { fs.rmSync(storageRoot, { recursive: true, force: true }); fs.rmSync(site, { recursive: true, force: true }); stage.cleanup(); }
if (failures.length) { console.error(`INBOX BROWSER CHECK FAILED (${failures.length}):\n${failures.join('\n')}`); process.exit(1); }
console.log('INBOX BROWSER CHECK DONE');
