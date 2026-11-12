// Issue #1160: clear_latch (the Needs you card, the click, the approved action, the overseer proposal) and the short job id on the job commands.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { latchCardText, stopLines, clearLatchApproved } from '../supervisor/latchaction.mjs';
import { decisionCard } from '../supervisor/decisiontable.mjs';
import { Team, upgradeLock } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { allStatuses, validateItem } from '../supervisor/inbox.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { createInbox, checkProposal } from '../foreman-mcp/inbox.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';

const A = 'a'.repeat(40), B = 'b'.repeat(40), AT = Date.UTC(2026, 10, 10, 18, 5);
const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const noHold = () => null;
const deps = (extra = {}) => ({ upgradeLock, handInstallHold: noHold, now: () => 1234, ...extra });
function stateWith(t, { latch = { at: AT, from: A, to: B, reason: 'live tick failed: git worktree failed' }, state = null } = {}) {
  const root = tmp(t, 'latch1160-'); fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  if (latch) fs.writeFileSync(path.join(root, 'team', 'self-upgrade.latch'), JSON.stringify(latch));
  if (state) fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify(state));
  return root;
}
const records = root => fs.readFileSync(path.join(root, 'team', 'upgrades.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const latchFile = root => path.join(root, 'team', 'self-upgrade.latch');

test('card text: a rollback names both versions, the failed check, when, and what would install next', () => {
  const text = latchCardText({ at: AT, from: A, to: B, reason: 'live tick failed: git worktree failed' }, { installed: A, main: 'c'.repeat(40), behind: 4 });
  assert.match(text, /from aaaaaaa to bbbbbbb was rolled back \(failed check: live tick failed: git worktree failed\), 2026-11-10 18:05 UTC/);
  assert.match(text, /main ccccccc, 4 commits ahead of the installed aaaaaaa/);
  assert.match(latchCardText({ at: AT, from: A, to: B, reason: 'x' }, { installed: A, main: A, behind: 0 }), /nothing to install/);
  assert.match(latchCardText({ at: AT, from: A, to: B, reason: 'x' }, null), /not known yet/);
});

test('card text: a homeowner pause shows the first lines of its stop record, read only from the stop directory', t => {
  const dir = tmp(t, 'stop1160-'), file = path.join(dir, 'S1-pause.md');
  fs.writeFileSync(file, '\n# Agent storage S1 pause\nDo not install until the disks are checked.\nThird line.\nFourth line is cut.\n');
  const lines = stopLines(`homeowner pause, see ${file}`, { dir });
  assert.deepEqual(lines, ['# Agent storage S1 pause', 'Do not install until the disks are checked.', 'Third line.']);
  const text = latchCardText({ at: AT, reason: `homeowner pause, see ${file}` }, { behind: 2, main: B, installed: A }, lines);
  assert.match(text, /paused by a homeowner pause/); assert.match(text, /Stop record: # Agent storage S1 pause \| Do not install/); assert.ok(!/Fourth/.test(text));
  assert.deepEqual(stopLines(`see ${file}`, { dir: path.join(dir, 'other') }), [], 'a file outside the stop directory is not read');
  const link = path.join(dir, 'link.md'); fs.symlinkSync(file, link);
  assert.deepEqual(stopLines(`see ${link}`, { dir }), [], 'a symbolic link is not followed');
  assert.deepEqual(stopLines('no path here', { dir }), []);
});

test('the decision table maps the upgrade-latched card to the clear_latch control, and only that card', () => {
  const card = decisionCard({ id: 'upgrade-latched', text: 'Automatic upgrades are paused', ref: null });
  assert.deepEqual(card.controls.map(c => [c.action, c.target]), [['clear_latch', 'latch']]);
  assert.match(card.clears, /clear the latch with the control on this card/);
  assert.deepEqual(decisionCard({ id: 'drift-1', text: 'x', ref: null }).controls.filter(c => c.action === 'clear_latch'), []);
});

test('clear_latch clears once, records who, when and why, and a second call is refused as stale', t => {
  const root = stateWith(t);
  const msg = clearLatchApproved({ root, reason: 'homeowner pressed Clear upgrade latch on the upgrade-latched card' }, deps());
  assert.match(msg, /upgrade latch cleared/); assert.match(msg, /git worktree failed/);
  assert.ok(!fs.existsSync(latchFile(root)));
  const [r] = records(root);
  assert.deepEqual([r.at, r.result, r.by, r.from, r.to], [1234, 'latch_cleared', 'homeowner', A, B]);
  assert.match(r.why, /pressed Clear upgrade latch/); assert.match(r.was, /git worktree failed/);
  assert.throws(() => clearLatchApproved({ root, reason: 'again' }, deps()), /no upgrade latch is set/);
  assert.equal(records(root).length, 1, 'the stale call recorded nothing');
});

test('clear_latch is refused, with the latch left in place, while an install is running or waiting', t => {
  const root = stateWith(t);
  const unlock = upgradeLock(root); assert.ok(unlock);
  assert.throws(() => clearLatchApproved({ root, reason: 'x' }, deps()), /an install is running/);
  unlock();
  assert.throws(() => clearLatchApproved({ root, reason: 'x' }, deps({ handInstallHold: () => ({ at: 1 }) })), /hand-install is in progress/);
  fs.writeFileSync(path.join(root, 'team', 'self-upgrade.json'), JSON.stringify({ pending: { from: A, to: B } }));
  assert.throws(() => clearLatchApproved({ root, reason: 'x' }, deps()), /waiting for its verification/);
  assert.ok(fs.existsSync(latchFile(root)), 'the latch is still set after each refusal');
  assert.ok(!fs.existsSync(path.join(root, 'team', 'upgrades.jsonl')));
  assert.ok(upgradeLock(root), 'the lock is released after a refusal');
});

test('an unreadable latch can still be cleared and says so', t => {
  const root = stateWith(t, { latch: null });
  fs.writeFileSync(latchFile(root), '{not json');
  assert.match(clearLatchApproved({ root, reason: 'x' }, deps()), /unreadable latch/);
  assert.ok(!fs.existsSync(latchFile(root)));
});

const APP = { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' };
async function serve(t, { latch = true } = {}) {
  const root = stateWith(t, { latch: latch ? { at: AT, from: A, to: B, reason: 'live tick failed: git worktree failed' } : null });
  for (const d of ['jobs', 'dashboard']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const inboxDir = path.join(root, 'inbox'); for (const d of ['items', 'status']) fs.mkdirSync(path.join(inboxDir, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [] }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ fixAttempts: {}, verdicts: {}, jobs: {} }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const port = server.address().port;
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inboxDir }, github_app: APP,
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); r.on('error', reject); if (body) r.write(body); r.end(); });
  const click = (card, control) => req('POST', '/decision', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ card, control, proof: writeToken(root) }).toString() });
  return { root, inboxDir, config, get: p => req('GET', p), click };
}
function teamAt(root, inboxDir, config) {
  const gh = { listPulls: async () => [], listIssues: async () => [], getPull: async () => null, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {}, removeLabel: async () => {} };
  return new Team({ config, root: stateRoot(root), gh, jobs: { get: async () => null, listActive: async () => [] }, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n' });
}

test('end to end: the latched card shows the reason and a control; the click is applied once by the next tick; the card is then gone', async t => {
  const s = await serve(t);
  const page = (await s.get('/')).body, card = page.slice(page.indexOf('att-upgrade-latched'));
  assert.match(card, /rolled back \(failed check: live tick failed: git worktree failed\)/);
  assert.match(card, /name="control" value="clear_latch"/);
  assert.equal((await s.click('upgrade-latched', 'clear_latch')).status, 303);
  assert.ok(fs.existsSync(latchFile(s.root)), 'nothing is applied by the click itself');
  const team = teamAt(s.root, s.inboxDir, s.config);
  await team.processInbox({});
  const [st] = allStatuses(s.inboxDir);
  assert.equal(st.state, 'done'); assert.match(st.result, /upgrade latch cleared/);
  assert.equal(st.click.by, 'homeowner'); assert.match(st.click.reason, /pressed Clear upgrade latch on the upgrade-latched card/);
  assert.ok(!fs.existsSync(latchFile(s.root)));
  assert.equal(records(s.root).filter(r => r.result === 'latch_cleared').length, 1);
  await team.processInbox({});
  assert.equal(records(s.root).filter(r => r.result === 'latch_cleared').length, 1, 'a repeat pass clears nothing again');
  assert.ok(!(await s.get('/')).body.includes('att-upgrade-latched'));
});

test('end to end: a stale card does nothing and says so, at the click and at the tick', async t => {
  const s = await serve(t);
  assert.equal((await s.click('upgrade-latched', 'clear_latch')).status, 303);
  fs.rmSync(latchFile(s.root));   // the homeowner cleared it by hand before the tick
  await teamAt(s.root, s.inboxDir, s.config).processInbox({});
  const [st] = allStatuses(s.inboxDir);
  assert.equal(st.state, 'failed'); assert.match(st.reason, /no upgrade latch is set/); assert.match(st.result, /nothing was changed/);
  assert.ok(!fs.existsSync(path.join(s.root, 'team', 'upgrades.jsonl')));
  await new Promise(r => setTimeout(r, 1100));   // past the inbox cooldown
  const late = await s.click('upgrade-latched', 'clear_latch');
  assert.equal(late.status, 409); assert.match(late.body, /already cleared/);
});

test('overseer parity: clear_latch is proposed with no target, becomes a card for the homeowner, and cannot be a control', async t => {
  const c = checkProposal({ kind: 'action', title: 'Clear the upgrade latch', action: 'clear_latch', reason: 'the cause was fixed in PR 1145' });
  assert.equal(c.ok, true); assert.equal(c.item.target, 'latch');
  assert.equal(validateItem(c.item).ok, true, 'Foreman accepts the item the server writes');
  assert.equal(checkProposal({ kind: 'action', title: 't', action: 'clear_latch', target: '12', reason: 'r' }).ok, false);
  assert.equal(checkProposal({ kind: 'control', title: 't', action: 'clear_latch', target: 'latch', reason: 'r' }).ok, false, 'a control item cannot clear the latch');
  assert.equal(validateItem({ kind: 'action', title: 't', action: 'clear_latch', target: '12', reason: 'r' }).ok, false);
  const dir = tmp(t, 'inbox1160-'); for (const d of ['items', 'status']) fs.mkdirSync(path.join(dir, d));
  const tools = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), inbox: createInbox({ dir }) });
  const propose = tools.list().find(x => x.name === 'foreman_propose');
  assert.match(propose.description, /clear_latch with no target/);
  assert.ok(propose.inputSchema.properties.action.enum.includes('clear_latch'));
  const r = await tools.call('foreman_propose', { kind: 'action', title: 'Clear the upgrade latch', action: 'clear_latch', reason: 'cause fixed' });
  assert.ok(!r.isError, r.text);
  assert.equal(fs.readdirSync(path.join(dir, 'items')).length, 1);
});

// The job commands, through the real entry point (a child process), against a state root with two jobs that share a prefix.
function cli(root, ...argv) { return spawnSync(process.execPath, [new URL('../supervisor/cli.mjs', import.meta.url).pathname, ...argv, '--state-root', root], { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: root } }); }
function jobsRoot(t) {
  const root = tmp(t, 'ids1160-'); fs.mkdirSync(path.join(root, 'jobs')); fs.mkdirSync(path.join(root, 'events'));
  for (const [id, status] of [['12345678' + 'a'.repeat(24), 'completed'], ['12345678' + 'b'.repeat(24), 'completed'], ['9abcdef0' + 'c'.repeat(24), 'completed']]) {
    fs.writeFileSync(path.join(root, 'jobs', `${id}.json`), JSON.stringify({ id, provider: 'claude', issue: 1, status, attempts: 0 }));
    fs.writeFileSync(path.join(root, 'events', `${id}.jsonl`), '{"event":"x"}\n');
  }
  return root;
}
test('job commands resolve a unique short id, through the real CLI, and reject an ambiguous or unknown one', t => {
  const root = jobsRoot(t), short = '9abcdef0';
  const out = (r, re) => assert.match(r.stdout + r.stderr, re);
  out(cli(root, 'logs', short), /"event":"x"/);
  out(cli(root, 'pause', short), /terminal job cannot be paused or stopped/);
  out(cli(root, 'stop', short), /terminal job cannot be paused or stopped/);
  out(cli(root, 'resume', short), /job is not resumable/);
  const rel = cli(root, 'release', short); assert.equal(rel.status ?? 0, 0, rel.stderr); out(rel, new RegExp('9abcdef0' + 'c'.repeat(24)));
  for (const cmd of ['logs', 'pause', 'stop', 'resume', 'release']) {
    const amb = cli(root, cmd, '12345678'); assert.equal(amb.status, 2, cmd); assert.match(amb.stderr, /job ID prefix is ambiguous/, cmd);
    assert.match(cli(root, cmd, 'ffffffff').stderr, /no such job/, cmd);
    assert.match(cli(root, cmd, '1234567').stderr, /invalid job ID/, `${cmd}: fewer than 8 characters`);
  }
  assert.match(cli(root, 'stop').stderr, /job ID is required/);
});
