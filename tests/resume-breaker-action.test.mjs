// Issue #1332: the approved inbox action resume_breaker, through the real entry points: the dashboard view and decision card, the inbox
// validation, the MCP proposal check, the decision click, and one Team inbox pass. No model call, no network beyond loopback.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { decisionCard } from '../supervisor/decisiontable.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { allStatuses, validateItem, BREAKER_SCOPE } from '../supervisor/inbox.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { checkProposal, BREAKER_SCOPE as MCP_SCOPE } from '../foreman-mcp/inbox.mjs';
import { createInbox } from '../foreman-mcp/inbox.mjs';

const REAL = 'fix:blocked:postcondition_not_met';
const APP = { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' };
// 160 characters that no secret rule flags: groups of 30 letters split by colons.
const longKey = n => { const g = `${'ab'.repeat(15)}:`; return g.repeat(Math.ceil(n / g.length)).slice(0, n - 1) + 'z'; };
const halt = (cause, since) => ({ cause, since, jobs: 3, tokens: 30, inputTokens: 15, outputTokens: 15, cost: 1, prs: [40], issues: [], types: ['fix'], jobIds: ['a', 'b', 'c'], trippedBy: 'count' });

async function serve(t, halts = { [REAL]: halt(REAL, 1000) }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rb1332-')); removeLater(root); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const inboxDir = path.join(root, 'inbox'); for (const d of ['items', 'status']) fs.mkdirSync(path.join(inboxDir, d), { recursive: true });
  const at = Date.now() - 60000;
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at, status: 'ok', lastOkAt: at }, fetchedAt: at, pulls: [], issues: [] }));
  const stateFile = path.join(root, 'team', 'state.json');
  fs.writeFileSync(stateFile, JSON.stringify({ fixAttempts: {}, verdicts: {}, jobs: {}, breaker: { waste: {}, halts, global: null, clearedAt: {} } }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const port = server.address().port;
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inboxDir }, github_app: APP,
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); r.on('error', reject); r.end(body); });
  const click = (card, control) => req('POST', '/decision', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ card, control, proof: writeToken(root) }).toString() });
  const team = () => new Team({ config, root: stateRoot(root), gh: { listPulls: async () => [], listIssues: async () => [], getPull: async () => null, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} },
    jobs: { get: async () => null, listActive: async () => [] }, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n' });
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { root, inboxDir, config, get: p => req('GET', p), click, team, state };
}
const action = target => ({ kind: 'action', title: `resume ${target.slice(0, 20)}`, action: 'resume_breaker', target, reason: 'the cause was fixed' });

test('the breaker card carries the real top halt key as its scope and offers Resume breaker', async t => {
  const s = await serve(t);
  const view = JSON.parse((await s.get('/api/view.json')).body);
  assert.equal((await s.get('/api/view.json')).status, 200);
  const item = view.panels.needsYou.find(a => a.id === 'breaker-halt');
  assert.equal(item.scope, REAL);
  assert.deepEqual(item.card.controls.map(c => [c.action, c.target, c.label]), [['resume_breaker', REAL, 'Resume breaker']]);
  assert.doesNotMatch(item.card.later ?? '', /arrives with slice 2/);
});

test('the card builder offers a scope only when it is a valid scope', () => {
  const card = scope => decisionCard({ id: 'breaker-halt', text: 'Work halted', scope, ref: null }).controls.filter(c => c.action === 'resume_breaker');
  for (const ok of [REAL, '@global', 'all', longKey(160)]) assert.equal(card(ok).length, 1, ok);
  for (const bad of ['has space', 'a/b', longKey(161), undefined, '']) assert.equal(card(bad).length, 0, String(bad));
});

test('one scope pattern: 160 characters are accepted and 161 refused by inbox validation, the decision table and the MCP check', () => {
  for (const [scope, ok] of [[longKey(160), true], [longKey(161), false], [REAL, true], ['@global', true], ['all', true], ['a b', false], ['a/b', false], ['', false]]) {
    const inbox = scope ? validateItem(action(scope)).ok : false, mcp = checkProposal(action(scope)).ok;
    const table = decisionCard({ id: 'breaker-halt', text: 'x', scope, ref: null }).controls.some(c => c.action === 'resume_breaker');
    assert.deepEqual([inbox, mcp, table], [ok, ok, ok], `${scope.length} characters ${JSON.stringify(scope.slice(0, 12))}`);
  }
  assert.match(checkProposal(action(longKey(161))).error, /longer than 160/);
});

test('every other action keeps its short target limit, in the inbox and the MCP check', () => {
  const long = '1'.repeat(41);
  assert.equal(validateItem({ kind: 'action', title: 't', action: 'reopen', target: long, reason: 'r' }).ok, false);
  assert.equal(checkProposal({ kind: 'action', title: 't', action: 'reopen', target: long, reason: 'r' }).ok, false);
  assert.equal(checkProposal({ kind: 'action', title: 't', action: 'reopen', target: '12', reason: 'r' }).ok, true);
});

test('the MCP copy of the scope pattern equals the supervisor one', () => {
  assert.equal(MCP_SCOPE.source, BREAKER_SCOPE.source);
  assert.equal(MCP_SCOPE.flags, BREAKER_SCOPE.flags);
});

test('foreman_propose stores a resume_breaker proposal with the real halt key; it stays pending until approved', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb1332mcp-')); removeLater(dir); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const d of ['items', 'status']) fs.mkdirSync(path.join(dir, d));
  const r = createInbox({ dir }).propose(action(REAL));
  assert.equal(r.state, 'submitted');
  const stored = JSON.parse(fs.readFileSync(path.join(dir, 'items', `${r.id}.json`), 'utf8'));
  assert.equal(stored.target, REAL);
});

test('end to end: the click resumes the real halt on the next tick and records who, channel and why', async t => {
  const s = await serve(t, { [REAL]: halt(REAL, 1000), 'review:other': halt('review:other', 2000) });
  assert.equal((await s.click('breaker-halt', 'resume_breaker')).status, 303);
  assert.ok(s.state().breaker.halts[REAL], 'the click itself changes nothing');
  await s.team().processInbox({});
  const [st] = allStatuses(s.inboxDir);
  assert.equal(st.state, 'done'); assert.match(st.result, new RegExp(`circuit breaker resumed: ${REAL}`));
  const b = s.state().breaker;
  assert.equal(b.halts[REAL], undefined); assert.ok(b.halts['review:other'], 'only the named scope is cleared');
  const entry = b.resumes.at(-1);
  assert.equal(entry.scope, REAL); assert.deepEqual(entry.cleared, [REAL]);
  assert.equal(entry.by, 'homeowner'); assert.equal(entry.channel, 'decision card on the dashboard');
  assert.match(entry.why, /pressed Resume breaker on the breaker card/);
});

test('an approved overseer proposal is recorded on a different channel than a dashboard click', async t => {
  const s = await serve(t);
  const { decide } = await import('../supervisor/inbox.mjs');
  const id = 'c'.repeat(32), item = action(REAL);
  fs.writeFileSync(path.join(s.inboxDir, 'items', `${id}.json`), JSON.stringify(item));
  const inbox = await import('../supervisor/inbox.mjs');
  inbox.scan(s.inboxDir, Date.now());
  assert.equal(decide(s.inboxDir, id, 'approve', Date.now()).ok, true);
  await s.team().processInbox({});
  assert.equal(allStatuses(s.inboxDir).find(x => x.id === id).state, 'done');
  const entry = s.state().breaker.resumes.at(-1);
  assert.equal(entry.channel, 'overseer proposal approved on the dashboard'); assert.equal(entry.why, 'the cause was fixed');
});

test('stale: resuming a scope that is not halted ends failed and changes nothing', async t => {
  for (const scope of [REAL, 'all', '@global']) {
    const s = await serve(t, {});
    const before = fs.readFileSync(path.join(s.root, 'team', 'state.json'), 'utf8');
    const id = 'd'.repeat(32);
    fs.writeFileSync(path.join(s.inboxDir, 'items', `${id}.json`), JSON.stringify(action(scope)));
    const inbox = await import('../supervisor/inbox.mjs');
    inbox.scan(s.inboxDir, Date.now()); inbox.decide(s.inboxDir, id, 'approve', Date.now());
    await s.team().processInbox({});
    const st = allStatuses(s.inboxDir).find(x => x.id === id);
    assert.equal(st.state, 'failed', scope); assert.match(st.reason, /it was already resumed or never tripped\); nothing changed/);
    assert.equal(fs.readFileSync(path.join(s.root, 'team', 'state.json'), 'utf8'), before, `${scope} left the state file untouched`);
  }
});

test('@global and all still resume', async t => {
  const s = await serve(t, { [REAL]: halt(REAL, 1000), 'review:other': halt('review:other', 2000) });
  const inbox = await import('../supervisor/inbox.mjs');
  const id = 'e'.repeat(32);
  fs.writeFileSync(path.join(s.inboxDir, 'items', `${id}.json`), JSON.stringify(action('all')));
  inbox.scan(s.inboxDir, Date.now()); inbox.decide(s.inboxDir, id, 'approve', Date.now());
  await s.team().processInbox({});
  assert.deepEqual(s.state().breaker.halts, {});
  assert.deepEqual(s.state().breaker.resumes.at(-1).cleared.sort(), [REAL, 'review:other'].sort());
});
