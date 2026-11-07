// Issue #855: done means installed and verified. Real files in temp roots; fake GitHub, jobs and clock; no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as inbox from '../supervisor/inbox.mjs';
import { Team, reviewPrompt, DONE_RULE, validateVerdict, applyLocalOverride, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { runMigrations, LOCAL_FILE } from '../supervisor/migrations.mjs';
import { applyHostValue, recordRefusedOrigin, readRefusedOrigins } from '../supervisor/hostvalue.mjs';
import { deferredSteps, homeownerSteps, enforceNoDeferredSteps } from '../supervisor/homeownersteps.mjs';
import { parseLiveChecks, runLiveChecks, verifyPass, stageOf, readVerification } from '../supervisor/livechecks.mjs';

const shippedFile = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supervisor', 'team.json');
const shipped = () => JSON.parse(fs.readFileSync(shippedFile, 'utf8'));
const validate = next => validateTeamConfig(applyLocalOverride(shipped(), next));
const tmp = (t, p = 'dm-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const read = root => JSON.parse(fs.readFileSync(path.join(root, LOCAL_FILE), 'utf8'));
const ORIGIN = 'https://agents.example.org';

// ---- 1. a release needing a new local key applies it through a migration at install
test('a release that needs a new local key ships a migration that applies it at install, once, with a backup', async t => {
  const root = tmp(t), dir = path.join(root, 'migrations'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '001-new-key.mjs'), "export const description = 'Set the new key'; export function migrate(l) { return { ...l, self_upgrade: { ...l.self_upgrade, drain_max_minutes: 20 } }; }");
  fs.writeFileSync(path.join(root, LOCAL_FILE), JSON.stringify({ enabled: true }));
  const r = await runMigrations({ root, dir, validate });
  assert.deepEqual(r.applied.map(a => a.number), [1]);
  assert.equal(read(root).self_upgrade.drain_max_minutes, 20); assert.equal(read(root).enabled, true);
  assert.equal(fs.readdirSync(root).filter(f => f.includes('.bak-')).length, 1);
  assert.deepEqual((await runMigrations({ root, dir, validate })).applied, [], 'never re-applied');
});

// ---- 2. a host-specific value: exactly one inbox item; approval merges with a backup and a parse check
function world(t) {
  const dir = tmp(t, 'inbox-'), state = tmp(t, 'state-');
  fs.mkdirSync(path.join(dir, 'items')); fs.mkdirSync(path.join(dir, 'status'));
  const gh = { listPulls: async () => [], getPull: async () => null, listIssues: async () => [], board: async () => {}, listMergedPulls: async () => [], comment: async () => {}, addLabel: async () => {} };
  const jobs = { listActive: async () => [], get: async () => null };
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const root = stateRoot(state);
  const team = new Team({ config, root, gh, jobs, git: {}, register: '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n', clock: { now: () => 5000 } });
  return { dir, root, team };
}
const rep = () => ({ ingested: [], notified: [], actions: [], skipped: [] });

test('a refused dashboard origin produces exactly one inbox item, however often it is seen or the tick runs', async t => {
  const w = world(t);
  assert.equal(recordRefusedOrigin(w.root, ORIGIN, 1), true); recordRefusedOrigin(w.root, ORIGIN, 2);
  assert.equal(recordRefusedOrigin(w.root, 'javascript:alert(1)'), false, 'a malformed origin is never kept');
  assert.equal(readRefusedOrigins(w.root).length, 1);
  for (let i = 0; i < 3; i++) await w.team.processInbox(rep()), await w.team.raiseHostValues(rep());
  const items = inbox.allStatuses(w.dir).filter(s => s.kind === 'host_value');
  assert.equal(items.length, 1); assert.equal(items[0].state, 'pending');
  const card = inbox.pendingCards(w.dir).find(c => c.id === items[0].id);
  assert.match(card.text, /dashboard\.allowed_origins \+= https:\/\/agents\.example\.org/);
  // a second, different refused origin waits until the first is decided
  recordRefusedOrigin(w.root, 'https://other.example.org', 3); await w.team.raiseHostValues(rep());
  assert.equal(inbox.allStatuses(w.dir).filter(s => s.kind === 'host_value').length, 1);
});

test('approving the host-value item backs up team.local.json, merges the value and checks it parses; nothing else changes', async t => {
  const w = world(t);
  fs.writeFileSync(path.join(w.root, LOCAL_FILE), JSON.stringify({ enabled: true, limits: { overall: 3 } }));
  recordRefusedOrigin(w.root, ORIGIN, 1); await w.team.processInbox(rep()); await w.team.raiseHostValues(rep());
  const [st] = inbox.allStatuses(w.dir).filter(s => s.kind === 'host_value');
  assert.equal(inbox.decide(w.dir, st.id, 'approve', 2).ok, true);
  await w.team.processInbox(rep());
  assert.deepEqual(read(w.root), { enabled: true, limits: { overall: 3 }, dashboard: { allowed_origins: [ORIGIN] } });
  const baks = fs.readdirSync(w.root).filter(f => f.includes('.bak-'));
  assert.equal(baks.length, 1); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.root, baks[0]), 'utf8')), { enabled: true, limits: { overall: 3 } });
  assert.equal(inbox.statusOf(w.dir, st.id).state, 'done');
  await w.team.processInbox(rep()); await w.team.raiseHostValues(rep());
  assert.equal(inbox.allStatuses(w.dir).filter(s => s.kind === 'host_value').length, 1, 'once applied, the origin is allowed and nothing is raised again');
});

test('a host value is refused before any card when the key or shape is wrong, the overseer cannot submit one, and a broken file is left untouched', t => {
  const w = world(t);
  assert.equal(inbox.raiseHostValue(w.dir, { key: 'limits.overall', value: '9' }).raised, false);
  assert.equal(inbox.raiseHostValue(w.dir, { key: 'dashboard.allowed_origins', value: 'https://x.example.org/path' }).raised, false);
  assert.equal(inbox.validateItem({ kind: 'host_value', title: 't', key: 'dashboard.allowed_origins', value: ORIGIN }).ok, false, 'not a kind the overseer may submit');
  const id = crypto.randomBytes(16).toString('hex'); fs.writeFileSync(path.join(w.dir, 'items', `${id}.json`), JSON.stringify({ kind: 'host_value', title: 't', key: 'dashboard.allowed_origins', value: ORIGIN }));
  inbox.scan(w.dir, 1); assert.equal(inbox.statusOf(w.dir, id).state, 'refused');
  const bad = '{ not json'; fs.writeFileSync(path.join(w.root, LOCAL_FILE), bad);
  assert.throws(() => applyHostValue({ root: w.root, key: 'dashboard.allowed_origins', value: ORIGIN, validate }), /not valid JSON/);
  assert.equal(fs.readFileSync(path.join(w.root, LOCAL_FILE), 'utf8'), bad);
  fs.writeFileSync(path.join(w.root, LOCAL_FILE), '{}');
  assert.throws(() => applyHostValue({ root: w.root, key: 'dashboard.allowed_origins', value: ORIGIN, validate: () => { throw new Error('invalid'); } }), /invalid/);
  assert.equal(fs.readFileSync(path.join(w.root, LOCAL_FILE), 'utf8'), '{}');
});

// ---- 3. live checks
const SHA = 'a'.repeat(40);
const ISSUE_BODY = '## Problem\nx\n\n## Live checks\n- GET /api/view.json -> 200\n- GET /index -> 200 contains "Needs you"\n- GET http://evil/ -> 200\n- GET /a/../b -> 200\n\n## Acceptance\n- `GET /nope -> 404`\n';
const res = (status, body = '') => ({ status, text: async () => body });

test('live checks are parsed only from the Live checks section and only as relative paths', () => {
  assert.deepEqual(parseLiveChecks(ISSUE_BODY), [{ method: 'GET', path: '/api/view.json', status: 200 }, { method: 'GET', path: '/index', status: 200, contains: 'Needs you' }]);
  assert.deepEqual(parseLiveChecks('no section'), []);
});
test('stages: merged, then installed, then verified', () => {
  assert.equal(stageOf({ merged: true }), 'merged'); assert.equal(stageOf({ merged: true, installed: true }), 'installed');
  assert.equal(stageOf({ merged: true, installed: true, verified: true }), 'verified'); assert.equal(stageOf({}), 'open');
});
function deps(t, { fetchImpl, body = ISSUE_BODY, records } = {}) {
  const root = tmp(t), created = [], fetched = [];
  return { root, created, fetched, args: {
    root, installedSha: SHA, records: records || [{ result: 'verified', prs: [7] }], baseUrl: 'http://dash.test:8099',
    getPull: async () => ({ closingIssuesReferences: [{ number: 5 }] }), getIssue: async () => ({ body }), ownerText: async (n, i) => i.body,
    fetchImpl: async (u, o) => { fetched.push(o.method + ' ' + new URL(u).pathname); return fetchImpl(u, o); },
    createIssue: async (title, b) => { created.push({ title, b }); return 300; }, findIssueByMarker: async () => null, now: 9 } };
}
test('an issue with live checks is verified only after every check passes on the installed version', async t => {
  const d = deps(t, { fetchImpl: async u => (u.endsWith('/index') ? res(200, 'Needs you: 0') : res(200, '{}')) });
  const r = await verifyPass(d.args);
  assert.deepEqual(r.verified, [5]); assert.deepEqual(r.failed, []);
  assert.deepEqual(readVerification(d.root)[5], { pr: 7, sha: SHA, state: 'verified', at: 9 });
  assert.deepEqual(d.fetched, ['GET /api/view.json', 'GET /index']);
  await verifyPass(d.args); assert.equal(d.fetched.length, 2, 'not asked again');
});
test('a failing live check is never verified: a follow-up issue carries the evidence, once per installed version', async t => {
  const d = deps(t, { fetchImpl: async u => (u.endsWith('/index') ? res(200, 'nothing here') : res(403, '')) });
  const r = await verifyPass(d.args);
  assert.deepEqual(r.verified, []); assert.deepEqual(r.failed, [{ issue: 5, followUp: 300 }]);
  assert.equal(d.created.length, 1); assert.match(d.created[0].title, /#5/);
  assert.match(d.created[0].b, /FAILED.*GET \/api\/view\.json.*expected status 200, got 403/); assert.match(d.created[0].b, /did not contain "Needs you"/);
  assert.equal(readVerification(d.root)[5].state, 'failed');
  await verifyPass(d.args); assert.equal(d.created.length, 1, 'same version: no second issue');
  // after the next install the checks run again, and passing verifies
  d.args.installedSha = 'b'.repeat(40); d.args.fetchImpl = async u => (u.endsWith('/index') ? res(200, 'Needs you') : res(200));
  assert.deepEqual((await verifyPass(d.args)).verified, [5]);
});
test('an unreachable system fails the check; no dashboard URL or a non-owner issue text runs nothing', async t => {
  const d = deps(t, { fetchImpl: async () => { throw Object.assign(new Error('refused'), { name: 'TypeError' }); } });
  assert.equal((await verifyPass(d.args)).failed.length, 1);
  const none = deps(t, { fetchImpl: async () => res(200) }); none.args.baseUrl = null;
  assert.match((await verifyPass(none.args)).skipped, /no dashboard URL/); assert.equal(none.fetched.length, 0);
  const foreign = deps(t, { fetchImpl: async () => res(200) }); foreign.args.ownerText = async () => '';
  const r = await verifyPass(foreign.args); assert.deepEqual(r.noChecks, [5]); assert.equal(foreign.fetched.length, 0);
  assert.deepEqual((await runLiveChecks([], { baseUrl: 'http://x' })), []);
});

// ---- 4. reviews block on a missing step
test('the review prompt carries the blocking rule', () => {
  const p = reviewPrompt({ pr: 1, head: SHA, branch: 'claude/issue-1-x', repository: 'o/r', inbox: '/i' });
  assert.ok(p.includes(DONE_RULE)); assert.match(p, /never an accepted resolution/); assert.match(p, /"Homeowner steps" heading/);
});
const PASS = { pr: 1, headSha: SHA, verdict: 'PASS', findings: [{ kind: 'follow-up', text: 'nit' }], commandsRun: ['node --test'] };
test('a PR body that defers a step to the homeowner after deploy draws CHANGES with a blocking finding', () => {
  for (const line of ['The homeowner can set dashboard.allowed_origins after deploy.', 'After install the homeowner needs to add the origin to team.local.json.', '- Left for the homeowner once it is installed.'])
    {
      const v = enforceNoDeferredSteps(PASS, `## Summary\nDoes a thing.\n${line}\n`);
      assert.equal(v.verdict, 'CHANGES', line); assert.ok(v.findings.some(f => f.kind === 'blocking' && /Deferred homeowner step/.test(f.text)));
      assert.equal(validateVerdict(v, { pr: 1, head: SHA }), null, 'still a valid verdict file');
    }
});
test('a clean body, or steps under a Homeowner steps heading, do not change the verdict; the steps are returned for Needs you', () => {
  assert.equal(enforceNoDeferredSteps(PASS, 'Adds a migration that sets the key at install.'), PASS);
  const body = '## Summary\nx\n\n## Homeowner steps\n- Paste your API credential into the broker (needs your credentials).\n\n## Tests\nthe homeowner can read them\n';
  assert.equal(enforceNoDeferredSteps(PASS, body), PASS); assert.deepEqual(deferredSteps(body), []);
  assert.deepEqual(homeownerSteps(body), ['Paste your API credential into the broker (needs your credentials).']);
  assert.deepEqual(homeownerSteps('## Homeowner steps\n_None._\n'), []);
  assert.equal(enforceNoDeferredSteps({ ...PASS, verdict: 'CHANGES', findings: [{ kind: 'blocking', text: 'x' }] }, 'homeowner should run it after deploy').verdict, 'CHANGES');
});
test('team: a review verdict is tightened from the PR body at ingestion and Homeowner steps are recorded for Needs you', async t => {
  const w = world(t); w.team.gh.pullBody = async () => 'The homeowner can restart it after deploy.\n\n## Homeowner steps\n- Plug in the cable.';
  const v = await w.team.applyDoneRule(1, SHA, PASS);
  assert.equal(v.verdict, 'CHANGES'); assert.deepEqual(w.team.s.homeownerSteps[1].steps, ['Plug in the cable.']);
  w.team.gh.pullBody = async () => 'Fine.'; assert.equal(await w.team.applyDoneRule(1, SHA, PASS), PASS); assert.equal(w.team.s.homeownerSteps[1], undefined);
});

test('the deferral gate ignores negated and quoted sentences and still catches real deferrals', () => {
  for (const ok of ['Nothing is left for the homeowner after deploy.', 'No step for the homeowner after install; the migration applies it.', 'A deferred "homeowner can do X after deploy" turns the verdict into CHANGES.'])
    assert.deepEqual(deferredSteps(ok), [], ok);
  for (const bad of ['Once deployed, the homeowner must restart the dashboard.', 'The homeowner will add the key post-deploy.', 'The homeowner can set the origin after deploy.'])
    assert.equal(deferredSteps(bad).length, 1, bad);
});

test('the dashboard shows a merged pull request as merged, installed or verified', () => {
  assert.equal(stageOf({ merged: true, installed: true }), 'installed');
  const src = fs.readFileSync(path.join(path.dirname(shippedFile), 'dashboard.mjs'), 'utf8'), rend = fs.readFileSync(path.join(path.dirname(shippedFile), 'dashrender.mjs'), 'utf8');
  assert.match(src, /stage: m \? stageOf\(/); assert.match(rend, /p\.status\} \(\$\{p\.stage\}\)/);
});
