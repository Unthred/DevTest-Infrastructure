// Issue #1337: the approved inbox action close_superseded, through the real entry points: the decision card click on the dashboard route, the inbox
// validation, the MCP proposal check, and one Team inbox pass whose GitHub client is the real one over a fake gh runner (so every call the action
// makes is seen, in order). PR #1189 is the target, superseded by #1157 and #1156. No model call, no network beyond loopback.
import { removeLater } from './_tmp-leaks.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { githubClient } from '../supervisor/github.mjs';
import { allStatuses, validateItem, SUPERSEDED_BY, SUPERSEDED_BY_MAX } from '../supervisor/inbox.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { checkProposal, createInbox, SUPERSEDED_BY as MCP_SUPERSEDED_BY, SUPERSEDED_BY_MAX as MCP_MAX } from '../foreman-mcp/inbox.mjs';
import { inboxToolDefs } from '../foreman-mcp/inbox-tools.mjs';

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const BRANCH = 'claude/issue-1157-v2-item-27';
const SAVED = `saved/pr-1189-${BRANCH.replace(/\//g, '-')}-${HEAD.slice(0, 7)}`;

// A fake gh process: answers the calls the real GitHub client makes and records every one, in order, as { args, input }.
function fakeGh(extra = {}) {
  const world = { pulls: { 1189: { number: 1189, headRefName: BRANCH, headRefOid: HEAD, state: 'OPEN' } }, issues: { 1157: 'OPEN', 1156: 'OPEN', 1200: 'OPEN', 1201: 'CLOSED' },
    refs: {}, comments: {}, closed: [], calls: [], ...extra };
  const writes = [];
  const fail = text => { throw new Error(text); };
  const run = (args, input) => {
    world.calls.push({ args, input });
    const [a, b, n] = args, num = Number(n);
    if (a === 'pr' && b === 'list') return JSON.stringify(Object.values(world.pulls).filter(p => !world.closed.includes(p.number)));
    if (a === 'issue' && b === 'list') return JSON.stringify(args[args.indexOf('--state') + 1] === 'open' ? Object.entries(world.issues).filter(([k, s]) => s === 'OPEN' && !world.closed.includes(Number(k))).map(([k, s]) => ({ number: Number(k), state: s, title: `issue ${k}`, labels: [] })) : []);
    if (a === 'pr' && b === 'view') return world.pulls[num] ? JSON.stringify(world.pulls[num]) : fail('no pull request found');
    if (a === 'issue' && b === 'view' && args.includes('comments')) return JSON.stringify({ comments: (world.comments[num] || []).map(body => ({ body })) });
    if (a === 'issue' && b === 'view') return world.issues[num] || world.pulls[num] ? JSON.stringify({ number: num, state: world.issues[num] || 'OPEN', labels: [] }) : fail('no issue found');
    if (a === 'issue' && b === 'comment') { (world.comments[num] ||= []).push(input); writes.push(['comment', num]); return ''; }
    if (a === 'api' && args.includes('GET')) { const name = args[args.length - 1].split('/git/ref/heads/')[1]; return world.refs[name] ? JSON.stringify({ object: { sha: world.refs[name] } }) : fail('Not Found'); }
    if (a === 'api' && args.includes('POST')) { const f = k => args.find(x => x.startsWith(`${k}=`)).slice(k.length + 1); world.refs[f('ref').replace('refs/heads/', '')] = f('sha'); writes.push(['branch', f('ref')]); return ''; }
    if ((a === 'pr' || a === 'issue') && b === 'close') { world.closed.push(num); writes.push([a === 'pr' ? 'close-pr' : 'close-issue', num, args.slice(3)]); return ''; }
    return fail(`unexpected gh call: ${args.slice(0, 3).join(' ')}`);
  };
  return { world, writes, run };
}

const sample = { run: null };
async function serve(t, { gh = fakeGh(), live = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cs1337-')); removeLater(root); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const inboxDir = path.join(root, 'inbox'); for (const d of ['items', 'status']) fs.mkdirSync(path.join(inboxDir, d), { recursive: true });
  const at = Date.now() - 60000, pull = { ...gh.world.pulls[1189], title: 'T', labels: ['needs-homeowner'], statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] };
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at, status: 'ok', lastOkAt: at }, fetchedAt: at, pulls: [pull], issues: [] }));
  const stateFile = path.join(root, 'team', 'state.json');
  const jobs = live ? { aaaaaaaa11111111: { pr: 1189, kind: 'fix' } } : {};
  fs.writeFileSync(stateFile, JSON.stringify({ fixAttempts: { [`1189:${HEAD}`]: 2 }, verdicts: {}, jobs }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const port = server.address().port;
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: inboxDir },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => Date.now() }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); }); r.on('error', reject); r.end(body); });
  const click = (card, control, supersededBy) => req('POST', '/decision', { headers: { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ card, control, proof: writeToken(root), ...(supersededBy === undefined ? {} : { superseded_by: supersededBy }) }).toString() });
  const team = () => new Team({ config, root: stateRoot(root), gh: githubClient(config, gh.run),
    jobs: { get: async () => (live ? { status: 'running' } : null), listActive: async () => [] }, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null },
    register: '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n' });
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { root, inboxDir, config, get: p => req('GET', p), click, team, state, gh };
}
// Approves an item the way the dashboard does (scan, then approve), without a click.
async function approve(s, item, id = 'b'.repeat(32)) {
  const inbox = await import('../supervisor/inbox.mjs');
  fs.writeFileSync(path.join(s.inboxDir, 'items', `${id}.json`), JSON.stringify(item));
  inbox.scan(s.inboxDir, Date.now());
  assert.equal(inbox.decide(s.inboxDir, id, 'approve', Date.now()).ok, true);
  return id;
}
const item = (target, by, extra = {}) => ({ kind: 'action', title: `close ${target}`, action: 'close_superseded', target: String(target), superseded_by: by, reason: 'replaced by the split issues', ...extra });
const statusOf = (s, id) => allStatuses(s.inboxDir).find(x => x.id === id);
const writeKinds = s => s.gh.writes.map(w => w[0]);

test('end to end: the card click saves the branch first, posts the comment once and closes PR #1189', async t => {
  const s = await serve(t);
  const page = (await s.get('/')).body;
  assert.match(page.slice(page.indexOf('att-fixlimit-1189')), /name="control" value="close_superseded"[^>]*><input type="hidden" name="back"[^>]*><input class="decision-input" type="text" name="superseded_by"/);
  assert.equal((await s.click('fixlimit-1189', 'close_superseded', '1157, 1156')).status, 303);
  assert.deepEqual(s.gh.writes, [], 'the click itself writes nothing to GitHub');
  await s.team().processInbox({});
  const [st] = allStatuses(s.inboxDir);
  assert.equal(st.state, 'done'); assert.match(st.result, /pull request #1189 closed, superseded by #1157, #1156; branch saved/);
  assert.deepEqual(writeKinds(s), ['branch', 'comment', 'close-pr'], 'branch first, then the comment, then the close');
  assert.equal(s.gh.world.refs[SAVED], HEAD);
  const [comment] = s.gh.world.comments[1189];
  assert.match(comment, /^Closed as superseded by #1157, #1156\./); assert.ok(comment.includes(SAVED)); assert.match(comment, /Reason: homeowner pressed Close as superseded on the fixlimit card/);
  assert.deepEqual(s.gh.world.closed, [1189]);
  const log = s.state().unblock.log.at(-1);
  assert.equal(log.target, 1189); assert.match(log.what, /closed the pull request as superseded by #1157, #1156/); assert.match(log.why, /homeowner approved on the dashboard: .*pressed Close as superseded/);
  assert.ok(Number.isFinite(log.at));
});

test('an issue target is closed as not planned and no branch is saved', async t => {
  const s = await serve(t);
  const id = await approve(s, item(1200, '1157'));
  await s.team().processInbox({});
  assert.equal(statusOf(s, id).state, 'done');
  assert.deepEqual(writeKinds(s), ['comment', 'close-issue']);
  assert.deepEqual(s.gh.writes.at(-1).slice(1), [1200, ['--repo', 'o/r', '--reason', 'not planned']]);
  assert.deepEqual(s.gh.world.refs, {});
  assert.match(s.gh.world.comments[1200][0], /^Closed as superseded by #1157\. Reason: replaced by the split issues/);
});

test('a pull request is not closed by a superseding number that is a pull request: either kind counts', async t => {
  const s = await serve(t, { gh: fakeGh({ pulls: { 1189: { number: 1189, headRefName: BRANCH, headRefOid: HEAD, state: 'OPEN' }, 1300: { number: 1300, headRefName: 'x/y', headRefOid: 'b'.repeat(40), state: 'OPEN' } } }) });
  const id = await approve(s, item(1189, '1300'));
  await s.team().processInbox({});
  assert.equal(statusOf(s, id).state, 'done'); assert.deepEqual(s.gh.world.closed, [1189]);
});

test('boundary: five numbers are accepted and six refused; 60 characters are accepted and 61 refused', async t => {
  const five = '1157, 1156, 1200, 1201, 1202', six = `${five}, 1203`;
  assert.equal(validateItem(item(1189, five)).ok, true); assert.equal(checkProposal(item(1189, five)).ok, true);
  assert.equal(validateItem(item(1189, six)).ok, false); assert.equal(checkProposal(item(1189, six)).ok, false);
  const sixty = ['1'.repeat(9), '2'.repeat(9), '3'.repeat(9), '4'.repeat(9), '5'.repeat(9)].join(',        ').slice(0, 60);
  assert.equal(sixty.length, 60);
  assert.deepEqual([SUPERSEDED_BY.test(sixty), validateItem(item(1189, sixty)).ok, checkProposal(item(1189, sixty)).ok], [true, true, true]);
  const long = `${sixty} `; assert.equal(long.length, 61);
  assert.match(validateItem(item(1189, long)).reason, /longer than 60/); assert.match(checkProposal(item(1189, long)).error, /longer than 60/);
  assert.equal(SUPERSEDED_BY_MAX, 60);
  // The action itself also refuses six numbers, whatever reached it.
  const s = await serve(t);
  const { closeSuperseded } = await import('../supervisor/closesupersededaction.mjs');
  await assert.rejects(() => closeSuperseded(s.team(), { target: '1189', superseded_by: six, reason: 'r' }), /more than 5 items/);
  assert.deepEqual(s.gh.writes, []);
});

test('the MCP copy of the numbers pattern equals the supervisor one, and the published propose schema lists the field', () => {
  assert.equal(MCP_SUPERSEDED_BY.source, SUPERSEDED_BY.source); assert.equal(MCP_SUPERSEDED_BY.flags, SUPERSEDED_BY.flags); assert.equal(MCP_MAX, SUPERSEDED_BY_MAX);
  const schema = inboxToolDefs({ enabled: true }).find(d => d.name === 'foreman_propose').inputSchema;
  assert.ok(schema.properties.action.enum.includes('close_superseded'));
  assert.equal(schema.properties.superseded_by.maxLength, 60);
  assert.equal(new RegExp(schema.properties.superseded_by.pattern).source, SUPERSEDED_BY.source);
});

test('the field belongs to close_superseded only: required there, refused anywhere else, in the inbox and the MCP check', () => {
  assert.equal(validateItem({ ...item(1189, '1157'), superseded_by: undefined }).ok, false, 'missing');
  assert.equal(checkProposal({ ...item(1189, '1157'), superseded_by: undefined }).ok, false, 'missing');
  for (const bad of ['', 'abc', '1157,', ',1157', '1157 1156', '1157;1156', '0x10', '#1157']) {
    assert.equal(validateItem(item(1189, bad)).ok, false, JSON.stringify(bad)); assert.equal(checkProposal(item(1189, bad)).ok, false, JSON.stringify(bad));
  }
  const other = { kind: 'action', title: 't', action: 'reopen', target: '12', reason: 'r', superseded_by: '1157' };
  assert.match(validateItem(other).reason, /only accepted with close_superseded/); assert.match(checkProposal(other).error, /only accepted with close_superseded/);
  assert.equal(validateItem({ ...other, kind: 'control', action: 'park' }).ok, false);
  assert.equal(validateItem({ ...other, superseded_by: undefined }).ok, true);
});

test('foreman_propose stores a close_superseded proposal with its numbers; it stays pending until approved', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs1337mcp-')); removeLater(dir); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const d of ['items', 'status']) fs.mkdirSync(path.join(dir, d));
  const r = createInbox({ dir }).propose(item(1189, '1157, 1156'));
  assert.equal(r.state, 'submitted');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'items', `${r.id}.json`), 'utf8')).superseded_by, '1157, 1156');
});

test('the click handler refuses a malformed list before anything is recorded, and takes the target from the card', async t => {
  const s = await serve(t);
  for (const bad of [undefined, '', '   ', 'abc', '1157,', '1157 1156', '1,2,3,4,5,6', '1157, #1156', `1${'0'.repeat(9)}`]) {
    const r = await s.click('fixlimit-1189', 'close_superseded', bad);
    assert.equal(r.status, 400, JSON.stringify(bad)); assert.match(r.body, /one to five superseding issue or pull request numbers/);
  }
  assert.deepEqual(allStatuses(s.inboxDir), [], 'nothing was recorded');
  assert.equal((await s.click('fixlimit-1189', 'close_superseded', '1157,1156')).status, 303);
  const [st] = allStatuses(s.inboxDir);
  assert.equal(st.click.target, '1189', 'the target is the card’s');
  await s.click('fixlimit-1189', 'close_superseded', '1157');
  assert.equal(allStatuses(s.inboxDir).length, 1, 'a second click while the first waits records nothing more');
});

for (const [name, target, by, opts, why] of [
  ['a superseding number that is neither an issue nor a pull request', 1189, '1157, 9999', {}, /#9999 not found as an issue or pull request/],
  ['the target itself', 1189, '1157, 1189', {}, /#1189 cannot supersede itself/],
  ['a target that is not open (a closed issue)', 1201, '1157', {}, /#1201 is not open; nothing changed/],
  ['a target that is not open (no such number)', 4242, '1157', {}, /#4242 is not open/],
  ['a target with a live job', 1189, '1157', { live: true }, /has a running job \(aaaaaaaa\)/],
]) {
  test(`invalid: ${name} ends the item failed with nothing written`, async t => {
    const s = await serve(t, opts);
    const id = await approve(s, item(target, by));
    await s.team().processInbox({});
    const st = statusOf(s, id);
    assert.equal(st.state, 'failed'); assert.match(st.reason, why);
    assert.deepEqual(s.gh.writes, [], 'no branch, comment or close');
    assert.deepEqual(s.gh.world.refs, {});
  });
}

test('a saved branch at another commit is refused before the comment or the close', async t => {
  const s = await serve(t, { gh: fakeGh({ refs: { [SAVED]: 'f'.repeat(40) } }) });
  const id = await approve(s, item(1189, '1157'));
  await s.team().processInbox({});
  assert.equal(statusOf(s, id).state, 'failed'); assert.match(statusOf(s, id).reason, /already exists at another commit/);
  assert.deepEqual(s.gh.writes, []); assert.deepEqual(s.gh.world.closed, []);
});

test('a repeat after a half finished run reuses the saved branch and does not comment twice', async t => {
  const s = await serve(t, { gh: fakeGh({ refs: { [SAVED]: HEAD }, comments: { 1189: ['Closed as superseded by #1157. Its branch is kept.'] } }) });
  const id = await approve(s, item(1189, '1157'));
  await s.team().processInbox({});
  assert.equal(statusOf(s, id).state, 'done');
  assert.deepEqual(writeKinds(s), ['close-pr'], 'the branch exists at the same commit, the comment is found, only the close remains');
  assert.equal(s.gh.world.comments[1189].length, 1);
});

test('the saved branch name is pr-number, branch made safe and cut to 50 characters, and the 7 character commit', async () => {
  const { savedBranchName } = await import('../supervisor/closesupersededaction.mjs');
  const pr = { number: 7, headRefName: `claude/${'x'.repeat(80)} y!`, headRefOid: HEAD };
  const name = savedBranchName(pr);
  assert.equal(name, `saved/pr-7-claude-${'x'.repeat(43)}-abcdef0`);
});

test('every GitHub call of the action goes through the runner the client was given (the counting one), never a second gh', async t => {
  const src = fs.readFileSync(new URL('../supervisor/closesupersededaction.mjs', import.meta.url), 'utf8') + fs.readFileSync(new URL('../supervisor/ghclose.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /ghRunner|spawnSync|child_process/);
  const s = await serve(t);
  const id = await approve(s, item(1189, '1157'));
  await s.team().processInbox({});
  assert.equal(statusOf(s, id).state, 'done');
  const writes = s.gh.world.calls.filter(c => ['comment', 'close'].includes(c.args[1]) || (c.args[0] === 'api' && c.args.includes('POST')));
  assert.equal(writes.length, 3, 'the branch, the comment and the close all reached the one runner');
});
