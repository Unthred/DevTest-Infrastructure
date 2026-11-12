// Builds real dashboard pages from synthetic state; the browser never sees a live state root.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { currentView, handler, STATIC } from '../../../supervisor/dashserver.mjs';
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
  const raw = fs.readFileSync(new URL('state.json', FIXTURES), 'utf8');
  return JSON.parse(raw)[variant];
}

function stageAssets(site) {
  const source = new URL('../../../supervisor/dashui/', import.meta.url);
  fs.mkdirSync(path.join(site, 'static'), { recursive: true });
  for (const [file] of Object.values(STATIC)) fs.copyFileSync(new URL(file, source), path.join(site, 'static', file));
  fs.mkdirSync(path.join(site, 'api'), { recursive: true });
  fs.writeFileSync(path.join(site, 'api', 'next'), '<span class="muted">none</span>');
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

function malformedState(root) {
  fs.writeFileSync(path.join(root, 'team', 'state.json'), fs.readFileSync(new URL('malformed.json', FIXTURES), 'utf8'));
}

function requestDashboard(server, port) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/', headers: { host: `127.0.0.1:${port}` } }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

async function stageDashboardError(site, root, config, now) {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  server.on('request', handler({ root, config, host: '127.0.0.1', port, now: () => now }));
  try {
    const response = await requestDashboard(server, port);
    if (response.status !== 500) throw new Error(`expected malformed state to produce 500, got ${response.status}`);
    fs.writeFileSync(path.join(site, 'index.html'), response.body);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

export async function buildFixtureSite({ root, site, variant }) {
  stageAssets(site);
  const state = JSON.parse(fs.readFileSync(new URL('state.json', FIXTURES), 'utf8'));
  const now = Date.parse(state.now);
  const config = configFor(root);
  writeState(root, variant === 'malformed' ? {} : readFixture(variant), now);
  if (variant === 'malformed') {
    malformedState(root);
    await stageDashboardError(site, root, config, now);
  } else {
    const view = await currentView({ root, config, now, tz: 'UTC' });
    writePage(site, 'index.html', renderRoute(view, { page: 'overview' }, { pathname: '/' }).html);
    writePage(site, 'work/index.html', renderRoute(view, { page: 'work' }, { pathname: '/work' }).html);
  }
  makeReadable(site);
}
