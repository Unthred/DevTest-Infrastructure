// Issue #1155: the homeowner steps of a merged PR stay in Needs you until done. Real Team passes over a temp state root with a fake GitHub,
// the real dashboard handler for the Mark done click, the real park path for the refusal. No model, no network beyond loopback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { removeLater } from './_tmp-leaks.mjs';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { consolidateNeedsYou } from '../supervisor/needsyou.mjs';
import { park, depsOf } from '../supervisor/controlactions.mjs';
import { RERAISE_MS, WINDOW_DAYS, refusalNote, outstanding } from '../supervisor/pendingsteps.mjs';
import { requestStepDone } from '../supervisor/pendingstepssync.mjs';

const DAY = 86400000, NOW = Date.parse('2026-11-12T00:00:00Z');
const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const BODY = '## Summary\nPark through the MCP.\n\n## Homeowner steps\n1. Create and install a GitHub App for Foreman.\n2. Save the GitHub App key on Tower (mode 600) and write the offer line.\n'
  + '3. Comment homeowner-approval: D-038 and D-039 on this pull request.\n\n## Tests\nAll pass.\n';
const tmp = (t, p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); removeLater(d); return d; };
const cfg = extra => ({ schema_version: 1, enabled: true, repository: 'Unthred/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } }, ...extra });

function world(t, { config = {}, register = REGISTER, merged, comments = [] } = {}) {
  const state = tmp(t, 'pstate-'), clock = { t: NOW, now: () => clock.t }, alerts = [];
  const gh = { listPulls: async () => [], listIssues: async () => [], getPull: async () => null, board: async () => {},
    listMergedPulls: async () => merged ?? [{ number: 1125, title: 'Park and stop through the MCP (#1125)', mergedAt: new Date(NOW - 2 * DAY).toISOString() },
      { number: 900, title: 'Old', mergedAt: new Date(NOW - (WINDOW_DAYS + 5) * DAY).toISOString() }],
    pullBody: async n => { gh.bodyReads.push(n); return BODY; }, bodyReads: [], prComments: async () => comments };
  const jobs = { listActive: async () => [], get: async () => null };
  const team = new Team({ config: cfg(config), root: stateRoot(state), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register, clock,
    alert: async text => { alerts.push(text); }, providerModels: { claude: { aliases: ['opus'], pattern: '^claude-', efforts: ['low'] } } });
  return { team, gh, clock, alerts, state, root: stateRoot(state) };
}
const pass = w => w.team.tickPass({});
const saved = w => JSON.parse(fs.readFileSync(path.join(w.root, 'team', 'state.json'), 'utf8'));

test('backfill: a pass scans PRs merged in the last 30 days, records the steps once, and ignores older PRs', async t => {
  const w = world(t);
  await pass(w);
  assert.deepEqual(w.gh.bodyReads, [1125], 'the 35 day old PR is not read');
  const e = w.team.s.pendingSteps[1125];
  assert.equal(e.steps.length, 3);
  assert.equal(e.title, 'Park and stop through the MCP');
  assert.equal(saved(w).pendingSteps[1125].steps.length, 3, 'the record is saved');
  w.clock.t += 11 * 60000; await pass(w);
  assert.deepEqual(w.gh.bodyReads, [1125], 'a PR already scanned is not read again');
});

test('a PR without a Homeowner steps section raises nothing', async t => {
  const w = world(t); w.gh.pullBody = async () => '## Summary\nNothing for the homeowner.\n';
  await pass(w);
  assert.deepEqual(w.team.s.pendingSteps, {});
});

test('Needs you lists every outstanding step naming the PR and the feature, although the PR is merged (not open)', async t => {
  const w = world(t); await pass(w);
  const r = consolidateNeedsYou([], { cache: { pulls: [], issues: [] }, pendingSteps: w.team.s.pendingSteps, repository: 'Unthred/r' });
  assert.equal(r.needsYou.length, 3);
  for (const [i, item] of r.needsYou.entries()) {
    assert.match(item.text, new RegExp(`homeowner step ${i + 1} of 3 of PR #1125`));
    assert.match(item.text, /Park and stop through the MCP/);
    assert.deepEqual(item.stepDone, { pr: 1125, index: i });
  }
  assert.deepEqual(r.dropped, []);
});

test('detection: github_app configured finishes the App steps only; the approval comment finishes the decision step', async t => {
  const w = world(t, { comments: [{ login: 'Unthred', url: 'u', body: 'homeowner-approval: D-038 D-039' }] });
  await pass(w);
  assert.deepEqual(w.team.s.pendingSteps[1125].steps.map(s => s.done), [false, false, true], 'the owner comment approves D-038 and D-039');
  assert.equal(w.team.s.pendingSteps[1125].steps[2].doneBy, 'the approval is recorded');
  w.team.c.github_app = { app_id: 1, installation_id: 2, key_file: '/k' };
  await pass(w);
  assert.deepEqual(w.team.s.pendingSteps[1125].steps.map(s => s.done), [true, true, true]);
  assert.deepEqual(outstanding(w.team.s.pendingSteps), []);
});

test('detection: a comment by someone other than the owner, or one naming only D-038, does not finish the decision step', async t => {
  const w = world(t, { comments: [{ login: 'someone-else', body: 'homeowner-approval: D-038 D-039' }, { login: 'Unthred', body: 'homeowner-approval: D-038' }] });
  await pass(w);
  assert.equal(w.team.s.pendingSteps[1125].steps[2].done, false);
});

test('detection: a register entry marked homeowner-approved finishes the decision step', async t => {
  const reg = `${REGISTER}\n## D-038 — a\n- Status: homeowner-approved\n- Date: 2026-11-09\n\n## D-039 — b\n- Status: homeowner-approved\n- Date: 2026-11-09\n`;
  const w = world(t, { register: reg }); await pass(w);
  assert.deepEqual(w.team.s.pendingSteps[1125].steps.map(s => s.done), [false, false, true]);
});

test('no expiry: an outstanding step is still listed 200 days later, long after the 30 day scan window', async t => {
  const w = world(t); await pass(w);
  w.clock.t += 200 * DAY; w.gh.listMergedPulls = async () => []; await pass(w);
  assert.equal(outstanding(w.team.s.pendingSteps).length, 3);
  assert.equal(consolidateNeedsYou([], { cache: {}, pendingSteps: saved(w).pendingSteps, repository: 'o/r' }).needsYou.length, 3);
});

test('re-raise: the homeowner is alerted at once, not again inside 3 days, and again after 3 days; nothing once all are done', async t => {
  const w = world(t); await pass(w);
  assert.equal(w.alerts.length, 1); assert.match(w.alerts[0], /3 homeowner steps are still waiting.*PR #1125/);
  w.clock.t += RERAISE_MS - 60000; await pass(w);
  assert.equal(w.alerts.length, 1, 'inside the interval');
  w.clock.t += 120000; await pass(w);
  assert.equal(w.alerts.length, 2, 'the interval has passed');
  for (const s of w.team.s.pendingSteps[1125].steps) s.done = true;
  w.clock.t += RERAISE_MS * 2; await pass(w);
  assert.equal(w.alerts.length, 2);
});

test('a failed alert is retried on the next pass', async t => {
  const w = world(t); let fail = true; const sent = [];
  w.team.alert = async x => { if (fail) throw new Error('down'); sent.push(x); };
  const r = await pass(w); assert.ok(JSON.stringify(r).includes('alert homeowner steps'));
  fail = false; await pass(w); assert.equal(sent.length, 1);
});

test('refusal: park without the GitHub App names the outstanding step and its PR; once the App is set the note is gone', async t => {
  const w = world(t); await pass(w);
  const gh = { listPulls: async () => [{ number: 7, labels: [] }], listIssues: async () => [] };
  const r = await park(7, { ...depsOf(w.team), gh });
  const text = JSON.stringify(r);
  assert.match(text, /no GitHub App identity configured/);
  assert.match(text, /needs the GitHub App, homeowner steps 1 to 2 of 3 of PR #1125/);
  assert.equal(refusalNote({}, 'github_app'), '', 'no outstanding step, no note');
  assert.equal(refusalNote(w.team.s.pendingSteps, 'other'), '');
});

async function dashboard(t, steps) {
  const root = tmp(t, 'pdash-');
  for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  const at = Date.now() - 60000;
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at, status: 'ok', lastOkAt: at }, fetchedAt: at, pulls: [], issues: [] }));
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ pendingSteps: steps }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const port = server.address().port;
  server.on('request', handler({ wake: () => {}, root, config: cfg(), host: '127.0.0.1', port, now: () => Date.now(), supervised: () => false, peerPid: () => 4242 }));
  const req = (method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } },
    res => { let b = ''; res.on('data', d => (b += d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject); r.end(body); });
  const click = (fields, { proof = writeToken(root), person = true, origin = `http://127.0.0.1:${port}` } = {}) => req('POST', '/step-done', {
    headers: { origin, ...(person ? { 'sec-fetch-site': 'same-origin', 'sec-fetch-user': '?1' } : {}), 'content-type': 'application/x-www-form-urlencoded' }, body: `${fields}&proof=${proof}` });
  return { root, get: p => req('GET', p), click };
}
const ENTRY = { title: 'Park and stop through the MCP', mergedAt: NOW - DAY, raisedAt: null, steps: [{ text: 'Create and install a GitHub App', done: false }, { text: 'Comment homeowner-approval: D-038', done: false }] };

test('the real dashboard lists the merged PR steps in Needs you with a Mark done button for each', async t => {
  const d = await dashboard(t, { 1125: ENTRY }), page = (await d.get('/')).body;
  assert.match(page, /homeowner step 1 of 2 of PR #1125/);
  assert.match(page, /homeowner step 2 of 2 of PR #1125/);
  assert.match(page, /Park and stop through the MCP/);
  assert.equal((page.match(/action="\/step-done"/g) || []).length, 2);
  assert.match(page, /name="pr" value="1125"><input type="hidden" name="index" value="1"/);
});

test('Mark done: a person click leaves a request, the next pass marks the step done and Needs you drops it', async t => {
  const w = world(t, { merged: [] }); w.team.s.pendingSteps = { 1125: structuredClone(ENTRY) }; w.team.save();
  const d = await dashboard(t, w.team.s.pendingSteps);
  const before = fs.readFileSync(path.join(d.root, 'team', 'state.json'), 'utf8');
  const r = await d.click('pr=1125&index=1');
  assert.equal(r.status, 303);
  assert.equal(fs.readFileSync(path.join(d.root, 'team', 'state.json'), 'utf8'), before, 'the dashboard edits no state');
  // The tick owns the state: it applies the request found in the dashboard's request folder.
  w.team.root = d.root; await pass(w);
  assert.deepEqual(w.team.s.pendingSteps[1125].steps.map(s => s.done), [false, true]);
  assert.equal(w.team.s.pendingSteps[1125].steps[1].doneBy, 'marked done on the dashboard');
  assert.deepEqual(outstanding(w.team.s.pendingSteps).map(o => o.index), [0]);
});

test('Mark done is refused for a script, a wrong proof, a foreign origin, an unknown or finished step', async t => {
  const done = structuredClone(ENTRY); done.steps[0].done = true;
  const d = await dashboard(t, { 1125: done });
  assert.equal((await d.click('pr=1125&index=1', { person: false })).status, 403);
  assert.equal((await d.click('pr=1125&index=1', { proof: 'f'.repeat(64) })).status, 403);
  assert.equal((await d.click('pr=1125&index=1', { origin: 'http://evil.example' })).status, 403);
  assert.equal((await d.click('pr=999&index=0')).status, 409, 'unknown PR');
  assert.equal((await d.click('pr=1125&index=5')).status, 409, 'unknown step');
  assert.equal((await d.click('pr=1125&index=0')).status, 409, 'already done');
  assert.equal(fs.existsSync(path.join(d.root, 'dashboard', 'step-done')), false, 'no refused click left a request');
});

test('a done request for an unknown step is discarded and changes nothing', async t => {
  const w = world(t, { merged: [] }); w.team.s.pendingSteps = { 1125: structuredClone(ENTRY) };
  requestStepDone(w.root, 4, 9, NOW); requestStepDone(w.root, 1125, 7, NOW);
  await pass(w);
  assert.equal(outstanding(w.team.s.pendingSteps).length, 2);
  assert.deepEqual(fs.readdirSync(path.join(w.root, 'dashboard', 'step-done')), []);
});
