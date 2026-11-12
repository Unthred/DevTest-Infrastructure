// Builds real dashboard pages from synthetic state; the browser never sees a live state root.
import fs from 'node:fs';
import path from 'node:path';
import { currentView, STATIC } from '../../../supervisor/dashserver.mjs';
import { renderRoute } from '../../../supervisor/dashrender.mjs';
import { scan } from '../../../supervisor/inbox.mjs';

const FIXTURES = new URL('./fixtures/', import.meta.url);
const ITEM_ID = 'a'.repeat(32);
const configFor = root => ({
  schema_version: 1,
  enabled: true,
  repository: 'fixture/dashboard',
  repo_path: root,
  worktree_base: root,
  access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: {
    claude: { provider: 'claude', branch_prefix: 'claude/', issues: [1148] },
    codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] }
  },
  inbox: { dir: path.join(root, 'inbox') }
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readFixture(variant) {
  const file = variant === 'malformed' ? 'malformed.json' : 'state.json';
  const raw = fs.readFileSync(new URL(file, FIXTURES), 'utf8');
  return variant === 'malformed' ? JSON.parse(raw) : JSON.parse(raw)[variant];
}

function stageAssets(site) {
  const source = new URL('../../../supervisor/dashui/', import.meta.url);
  fs.mkdirSync(path.join(site, 'static'), { recursive: true });
  for (const [file] of Object.values(STATIC)) fs.copyFileSync(new URL(file, source), path.join(site, 'static', file));
  fs.mkdirSync(path.join(site, 'api'), { recursive: true });
  fs.writeFileSync(path.join(site, 'api', 'next'), '<span class="muted">none</span>');
}

function stageError(site, error) {
  const message = error instanceof SyntaxError ? 'Fixture JSON is malformed.' : 'Fixture state could not be prepared.';
  const html = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    '<title>Fixture state unavailable</title></head><body><main>',
    `<h1>Fixture state unavailable</h1><p role="alert">${message}</p>`,
    '</main></body></html>'
  ].join('');
  fs.writeFileSync(path.join(site, 'index.html'), html);
}

function fixtureIssues(fixture) {
  if (Number.isSafeInteger(fixture.issueCount)) {
    return Array.from({ length: fixture.issueCount }, (_, index) => ({
      number: 2000 + index,
      title: `Long fixture issue ${index + 1}`,
      state: 'OPEN',
      labels: [],
      prerequisites: []
    }));
  }
  return fixture.issues;
}

function writeState(root, fixture, now) {
  for (const dir of ['dashboard', 'jobs', 'team', 'inbox/items', 'inbox/status']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  writeJson(path.join(root, 'dashboard', 'cache.json'), {
    tick: { at: now - 60000, status: 'ok', error: null, lastOkAt: now - 60000 },
    fetchedAt: now - 60000,
    pulls: [],
    issues: fixtureIssues(fixture)
  });
  writeJson(path.join(root, 'team', 'state.json'), { verdicts: {}, jobs: {} });
  if (fixture.inbox) {
    writeJson(path.join(root, 'inbox', 'items', `${ITEM_ID}.json`), fixture.inbox);
    scan(path.join(root, 'inbox'), now);
  }
}

function writePage(site, relative, html) {
  const file = path.join(site, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, html.replace(/<meta http-equiv="refresh"[^>]*>/, ''));
}

function makeReadable(dir) {
  fs.chmodSync(dir, 0o755);
  for (const entry of fs.readdirSync(dir, { recursive: true })) {
    const file = path.join(dir, entry);
    fs.chmodSync(file, fs.statSync(file).isDirectory() ? 0o755 : 0o644);
  }
}

export async function buildFixtureSite({ root, site, variant }) {
  stageAssets(site);
  try {
    const fixture = readFixture(variant);
    const state = JSON.parse(fs.readFileSync(new URL('state.json', FIXTURES), 'utf8'));
    const now = Date.parse(state.now);
    writeState(root, fixture, now);
    const view = await currentView({ root, config: configFor(root), now, tz: 'UTC' });
    writePage(site, 'index.html', renderRoute(view, { page: 'overview' }, { pathname: '/' }).html);
    writePage(site, 'work/index.html', renderRoute(view, { page: 'work' }, { pathname: '/work' }).html);
  } catch (error) {
    stageError(site, error);
  }
  makeReadable(site);
}
