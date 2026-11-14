// Issue #1448: GET /api/v1/about through the real dashboard handler over a temporary state root holding install records and an issue
// index file with bodies; the wording module has unit tests below.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { handler } from '../supervisor/dashserver.mjs';
import { validate } from '../supervisor/api/validate.mjs';
import { build } from '../supervisor/api/models/about.mjs';
import { cleanTitle, describeChange, firstSentence, groupOf } from '../supervisor/api/aboutwords.mjs';

const NOW = Date.UTC(2026, 10, 14, 12, 0, 0);
const DAY = 86400000;
const OLD = '5b160d0aa74268c6870a503f6d63d3b82c725550';
const NEW = 'f748e468cf21be20e62d99b5c3a5d9c28b36f084';
const THIRD = 'a880f7bf8763837da321956bd1cd2bf5f78f872c';
const SENTENCE = 'The agent choice starts a job whenever a candidate actually has room left for it.';
const API = new URL('../supervisor/api/', import.meta.url);
const readSchema = name => [name, JSON.parse(fs.readFileSync(new URL(`schemas/${name}`, API), 'utf8'))];
const schemas = Object.fromEntries(['common.schema.json', 'about.schema.json'].map(readSchema));
const config = {
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { alpha: { provider: 'prov-a', branch_prefix: 'alpha/', issues: [] } },
};
const freshness = { state: 'unknown', tick_at: null, age_seconds: null, stale_after_seconds: 1, reason_code: 'x', reason_text: 'x' };
const envelope = data => ({ contract: '1.0', model: 'about', generated_at: new Date(NOW).toISOString(), freshness, cursor: 'e-0', data });
const check = data => validate(schemas['about.schema.json'], envelope(data), schemas);

// The real records of the 14 Nov 2026 install of f748e46 with pull request 1425 (times as written by the upgrader).
const INSTALL_AT = Date.UTC(2026, 10, 14, 9, 18, 33);
const VERIFIED_AT = Date.UTC(2026, 10, 14, 9, 20, 27);
const RESTART_AT = Date.UTC(2026, 10, 14, 9, 20, 38);
const record = (at, result, extra = {}, from = OLD, to = NEW) => JSON.stringify({ at, from, to, result, ...extra });
const realRecords = () => [
  record(INSTALL_AT, 'upgraded', { prs: [1425] }),
  record(VERIFIED_AT, 'verified', { prs: [1425] }),
  record(RESTART_AT, 'dashboard_restarted', { reason: null, restarted: true }),
];
const issue = (number, title, body) => ({ kind: 'issue', number, title, state: 'CLOSED', body });
const pr = (number, title, closes) => ({ kind: 'pr', number, title, state: 'MERGED', closes });
const realBody = `Tier: 0\n\n${SENTENCE} More words follow.\n\n## What happened\n- x`;
const realIndex = () => [issue(1424, 'Agent choice stalls V2-9 Pickroom', realBody), pr(1425, 'Fix the agent choice', [1424])];

async function serve(t, { lines = realRecords(), items = realIndex(), installed = NEW } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'api1448-'));
  removeLater(root);
  for (const dir of ['jobs', 'dashboard', 'team', 'versions']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  if (installed) fs.symlinkSync(`versions/${installed}`, path.join(root, 'current'));
  if (lines) fs.writeFileSync(path.join(root, 'team', 'upgrades.jsonl'), `${lines.join('\n')}\n`);
  const keyed = Object.fromEntries((items ?? []).map(i => [`${i.kind}:${i.number}`, i]));
  if (items) fs.writeFileSync(path.join(root, 'dashboard', 'issue-index.json'), JSON.stringify({ schema: 1, items: keyed }));
  const tick = { at: NOW, status: 'ok', error: null, lastOkAt: NOW };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ fetchedAt: NOW, delivered: [], pulls: [], issues: [], tick }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: {} }));
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const { port } = server.address();
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => NOW }));
  const get = route => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: route, headers: { host: `127.0.0.1:${port}` } }, res => {
      let text = '';
      res.on('data', d => (text += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    }).on('error', reject);
  });
  get.root = root;
  return get;
}

async function about(t, options) {
  const r = await (await serve(t, options))('/api/v1/about');
  assert.equal(r.status, 200);
  assert.equal(r.body.model, 'about');
  assert.deepEqual(validate(schemas['about.schema.json'], r.body, schemas), []);
  return r.body.data;
}

test('the install of f748e46 lists one version with one fixed change and not the dashboard restart', async t => {
  const data = await about(t);
  assert.equal(data.installed.commit, NEW);
  assert.equal(data.installed.short, 'f748e46');
  assert.equal(data.installed.installed_at, new Date(INSTALL_AT).toISOString());
  assert.equal(data.installed.verified_at, new Date(VERIFIED_AT).toISOString());
  assert.equal(data.installs.length, 1);
  const change = { text: SENTENCE, group: 'fixed', pr: 1425, issue: 1424 };
  assert.deepEqual(data.installs[0], { at: new Date(INSTALL_AT).toISOString(), commit: NEW, short: 'f748e46', current: true, changes: [change] });
  assert.equal(data.mcp_version, null);
  assert.equal(data.hold, null);
});

test('installs are newest first, the first is current, an install older than 7 days and a retry of the same commit are left out', async t => {
  const lines = [
    record(NOW - 9 * DAY, 'upgraded', { prs: [1] }, THIRD, OLD),
    record(NOW - 9 * DAY + 1, 'verified', { prs: [1] }, THIRD, OLD),
    ...realRecords(),
    record(NOW - 3600000, 'upgraded', { prs: [2] }, NEW, THIRD),
    record(NOW - 3000000, 'verified', { prs: [2] }, NEW, THIRD),
    record(NOW - 2000000, 'precheck_failed', { reason: 'x' }, NEW, THIRD),
    record(NOW - 1000000, 'mcp_install', {}, NEW, NEW),
  ];
  const data = await about(t, { lines, installed: THIRD });
  assert.deepEqual(data.installs.map(i => [i.short, i.current]), [['a880f7b', true], ['f748e46', false]]);
  assert.equal(data.installed.short, 'a880f7b');
});

test('an install with two pull requests lists two changes', async t => {
  const lines = [record(INSTALL_AT, 'upgraded', { prs: [1425, 1430] }), record(VERIFIED_AT, 'verified', { prs: [1425, 1430] })];
  const second = issue(1429, 'Wider boxes V2-3 Boxes', 'Tier: 5\n\nThe About box shows the version.');
  const data = await about(t, { lines, items: [...realIndex(), second, pr(1430, 'Add the box', [1429])] });
  const changes = data.installs[0].changes.map(c => [c.pr, c.group, c.text]);
  assert.deepEqual(changes, [[1425, 'fixed', SENTENCE], [1430, 'screens', 'The About box shows the version.']]);
});

test('a pull request missing from the index is listed with a cleaned title or the words Pull request and its number', async t => {
  const lines = [record(INSTALL_AT, 'upgraded', { prs: [7, 8, 9] }), record(VERIFIED_AT, 'verified', { prs: [7, 8, 9] })];
  const items = [pr(7, 'V2-12 Show the version Aboutfacts', []), issue(9, 'Review follow-ups: tests', ''), pr(9, 'ignored title', [9])];
  const data = await about(t, { lines, items });
  const changes = data.installs[0].changes.map(c => [c.pr, c.text, c.group]);
  assert.deepEqual(changes, [[7, 'Show the version', 'improved'], [8, 'Pull request 8', 'improved'], [9, 'Review follow-ups: tests', 'tidying']]);
  assert.ok(data.installs[0].changes.every(c => c.text.length > 0));
});

test('a damaged line in the install records is skipped and the rest are served', async t => {
  const data = await about(t, { lines: ['{not json', ...realRecords(), '[1,2]'] });
  assert.equal(data.installs.length, 1);
  assert.equal(data.installs[0].changes[0].text, SENTENCE);
});

test('with no install records the reply holds the version part and an empty list', async t => {
  const data = await about(t, { lines: null, items: null, installed: null });
  assert.deepEqual(data.installs, []);
  assert.equal(data.installed.commit, null);
  assert.equal(data.main, null);
  assert.deepEqual(data.processes.filter(p => p.version === NEW), []);
});

test('a latch holds upgrades with its reason, and processes and the MCP version are reported', async t => {
  const get = await serve(t);
  const latch = { at: NOW - 1000, from: OLD, to: NEW, reason: 'the live tick failed twice' };
  fs.writeFileSync(path.join(get.root, 'team', 'self-upgrade.latch'), JSON.stringify(latch));
  const mcpDir = path.join(get.root, 'mcp');
  fs.mkdirSync(mcpDir);
  fs.writeFileSync(path.join(mcpDir, 'VERSION'), `${OLD}\n`);
  fs.writeFileSync(path.join(get.root, 'foreman-mcp.install'), `INSTALL_DIR=${mcpDir}\n`);
  const proc = path.join(get.root, 'proc', '4242');
  fs.mkdirSync(proc, { recursive: true });
  fs.writeFileSync(path.join(proc, 'cmdline'), ['node', `/x/versions/${OLD}/supervisor/dashserver.mjs`].join('\0'));
  const data = build(null, { root: get.root, now: NOW, procRoot: path.join(get.root, 'proc') });
  assert.deepEqual(data.hold, { kind: 'latch', since: new Date(NOW - 1000).toISOString(), reason: 'the live tick failed twice' });
  assert.equal(data.mcp_version, OLD);
  assert.deepEqual(data.processes, [{ role: 'dashboard', pid: 4242, version: OLD, matches_installed: false }]);
  assert.deepEqual(check(data), []);
});

test('the schema refuses an empty change text and an unknown group', () => {
  const version = { commit: null, short: null, installed_at: null, verified_at: null };
  const install = changes => ({ at: new Date(NOW).toISOString(), commit: NEW, short: 'f748e46', current: true, changes });
  const rest = { main: null, behind: null, hold: null, mcp_version: null, processes: [] };
  const reply = changes => ({ installed: version, ...rest, installs: [install(changes)] });
  assert.deepEqual(check(reply([{ text: 'x', group: 'fixed', pr: 1, issue: null }])), []);
  assert.notEqual(check(reply([{ text: '', group: 'fixed', pr: 1, issue: null }])).length, 0);
  assert.notEqual(check(reply([{ text: 'x', group: 'other', pr: 1, issue: null }])).length, 0);
});

test('wording: the first sentence skips Tier, prerequisite, heading and comment lines and ends at the first full stop', () => {
  assert.equal(firstSentence(`Tier: 0\n${SENTENCE} Second sentence.`), SENTENCE);
  assert.equal(firstSentence(`<!-- marker -->\n# Title\nTier: 2\nPrerequisites: #5\n\nIt shows the\nversion. More.`), 'It shows the version.');
  assert.equal(firstSentence('No full stop here'), 'No full stop here');
  assert.equal(firstSentence('Tier: 3\n## Heading\n\n'), '');
  assert.equal(firstSentence(undefined), '');
});

test('wording: titles lose a leading V2 item number and one trailing code word but keep a name', () => {
  assert.equal(cleanTitle('V2-14 About read model gives the version Aboutfacts'), 'About read model gives the version');
  assert.equal(cleanTitle('Connect to Home Assistant'), 'Connect to Home Assistant');
  assert.equal(cleanTitle('Plain title'), 'Plain title');
  assert.equal(cleanTitle(null), '');
});

test('wording: tiers map to groups and a body with no sentence falls back to the title', () => {
  assert.deepEqual([0, 1, 4, 5, 6].map(groupOf), ['fixed', 'improved', 'improved', 'screens', 'tidying']);
  assert.equal(describeChange(5, undefined, { number: 3, title: 'Fix it Codeword', body: 'Tier: 0\n## Only a heading' }).text, 'Fix it');
  assert.equal(describeChange(5, undefined, undefined).text, 'Pull request 5');
});
