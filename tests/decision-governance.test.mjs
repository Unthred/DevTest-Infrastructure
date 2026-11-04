// Issue #303: agents cannot mark a decision homeowner-approved. Register check (CI), Needs you item for proposals, and the
// decisionApproved() enforcement of every decision code must check. Fixtures use git init, never a linked worktree.
import { tmpDir } from './helpers/tmp.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseRegister, approvalsFrom, decisionViolations, proposalsAdded, ENFORCED_DECISIONS } from '../supervisor/decisions.mjs';
import { buildView, pendingProposals } from '../supervisor/dashboard.mjs';
import { Team, decisionApproved, CARRY_DECISION, INDEPENDENCE_DECISION } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = (id, status, source = 'issue #1') => `## ${id} — title ${id}\n- Status: ${status}\n- Date: 2026-11-02\n- Source: ${source}\n- Decision: Something. More.\n\n`;
const BASE = entry('D-001', 'homeowner-approved') + entry('D-002', 'agent-proposal');
const owner = (body, id = 77) => ({ login: 'Unthred', body, url: `https://github.com/o/r/pull/9#issuecomment-${id}`, id });

test('an agent adds an entry as homeowner-approved: fails', () => {
  const bad = decisionViolations(BASE, BASE + entry('D-003', 'homeowner-approved'));
  assert.equal(bad.length, 1); assert.match(bad[0], /D-003 is added as homeowner-approved/);
});
test('an agent adds a proposal: passes', () => {
  assert.deepEqual(decisionViolations(BASE, BASE + entry('D-003', 'agent-proposal')), []);
  assert.deepEqual(decisionViolations(BASE, BASE), []);
});
test('an agent flips a status to or from homeowner-approved: fails', () => {
  const up = BASE.replace('D-002 — title D-002\n- Status: agent-proposal', 'D-002 — title D-002\n- Status: homeowner-approved');
  assert.match(decisionViolations(BASE, up)[0], /D-002 changes status agent-proposal -> homeowner-approved/);
  const down = BASE.replace('D-001 — title D-001\n- Status: homeowner-approved', 'D-001 — title D-001\n- Status: agent-proposal');
  assert.match(decisionViolations(BASE, down)[0], /D-001 changes status homeowner-approved -> agent-proposal/);
  // a non-approval status change is not this check's concern
  assert.deepEqual(decisionViolations(BASE, BASE.replace('Status: agent-proposal', 'Status: temporary-note')), []);
});
test('deleting or duplicating an entry fails', () => {
  assert.match(decisionViolations(BASE, entry('D-001', 'homeowner-approved'))[0], /D-002 was removed/);
  assert.match(decisionViolations(BASE, BASE + entry('D-002', 'agent-proposal'))[0], /D-002 appears twice/);
});
test('a verified homeowner-instructed approval passes; unverifiable ones do not', () => {
  const link = 'https://github.com/o/r/pull/9#issuecomment-77';
  const up = BASE.replace('D-002 — title D-002\n- Status: agent-proposal\n- Date: 2026-11-02\n- Source: issue #1', `D-002 — title D-002\n- Status: homeowner-approved\n- Date: 2026-11-02\n- Source: ${link}`);
  const ok = approvalsFrom([owner('ok\nhomeowner-approval: D-002')], 'Unthred');
  assert.deepEqual(decisionViolations(BASE, up, ok), []);
  assert.equal(decisionViolations(BASE, up, approvalsFrom([{ ...owner('homeowner-approval: D-002'), login: 'someone-else' }], 'Unthred')).length, 1, 'not the owner');
  assert.equal(decisionViolations(BASE, up, approvalsFrom([owner('please approve D-002')], 'Unthred')).length, 1, 'no approval line');
  assert.equal(decisionViolations(BASE, up, approvalsFrom([owner('homeowner-approval: D-005')], 'Unthred')).length, 1, 'other entry');
  assert.equal(decisionViolations(BASE, up, approvalsFrom([owner('homeowner-approval: D-002', 78)], 'Unthred')).length, 1, 'Source does not link the comment');
  assert.equal(decisionViolations(BASE, up, approvalsFrom([owner('homeowner-approval: D-002')], '')).length, 1, 'no owner known');
  // a new entry may also arrive approved when the homeowner recorded it and the Source links it
  assert.deepEqual(decisionViolations(BASE, BASE + entry('D-003', 'homeowner-approved', link), approvalsFrom([owner('homeowner-approval: D-003')], 'Unthred')), []);
});

function repoWith(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dec-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...a) => execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '-b', 'main', dir]); fs.mkdirSync(path.join(dir, 'docs'));
  const commit = text => { fs.writeFileSync(path.join(dir, 'docs/DECISIONS.md'), text); g('add', '.'); g('commit', '-q', '-m', 'x'); return g('rev-parse', 'HEAD'); };
  return { dir, commit };
}
test('the CI script exits 1 for an agent-approved entry, 0 for a proposal, and reads the approvals file', t => {
  const r = repoWith(t, {}); const base = r.commit(BASE);
  const run = (head, file) => spawnSync('node', [path.join(ROOT, 'tools/ci/validate-decision-status.mjs'), base, head, ...(file ? [file] : [])], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, REPO_OWNER: 'Unthred' } });
  const prop = r.commit(BASE + entry('D-003', 'agent-proposal'));
  assert.equal(run(prop).status, 0);
  const link = 'https://github.com/o/r/pull/9#issuecomment-77';
  const appr = r.commit(BASE + entry('D-003', 'homeowner-approved', link));
  const res = run(appr); assert.equal(res.status, 1); assert.match(res.stderr, /D-003 is added as homeowner-approved/);
  const f = path.join(r.dir, 'a.json'); fs.writeFileSync(f, JSON.stringify([owner('homeowner-approval: D-003')]));
  assert.equal(run(appr, f).status, 0);
  assert.equal(run('nonexistent-ref').status, 1);
});
test('the live register still passes against itself and the workflow runs the check', () => {
  const text = fs.readFileSync(path.join(ROOT, 'docs/DECISIONS.md'), 'utf8');
  assert.deepEqual(decisionViolations(text, text), []); assert.ok(parseRegister(text).size >= 25);
  assert.match(fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8'), /validate-decision-status\.mjs/);
});

test('Needs you: a pending proposal in an open PR is one item naming the entry and the PR; none once on main or when absent', async t => {
  const r = repoWith(t, {}); const head = r.commit(BASE + entry('D-003', 'agent-proposal'));
  const noHead = r.commit(BASE);
  const H = (n) => String(n).repeat(40);
  const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: r.dir, worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
  const pr = (n, oid, extra = {}) => ({ number: n, title: `pr ${n}`, headRefName: `claude/issue-${n}-a`, headRefOid: oid, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [], labels: [], ...extra });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dv-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); fs.chmodSync(root, 0o700);
  const view = pulls => buildView({ config: cfg, root, jobs: [], events: [], state: {}, register: BASE, cache: { tick: { at: 1_800_000_000_000 - 60000, status: 'ok', error: null, lastOkAt: 1_800_000_000_000 - 60000 }, pulls, issues: [] }, snapshots: [], now: 1_800_000_000_000 });
  const v = await view([pr(310, head), pr(311, noHead), pr(312, head, { isDraft: true })]);
  const items = v.panels.needsYou.filter(a => a.id.startsWith('decision-proposal-'));
  assert.equal(items.length, 1); assert.equal(items[0].id, 'decision-proposal-D-003-310');
  assert.match(items[0].text, /D-003/); assert.match(items[0].text, /310/); assert.match(items[0].decision, /homeowner-approval: D-003/);
  assert.equal((await view([pr(311, noHead)])).panels.needsYou.some(a => a.id.startsWith('decision-proposal-')), false);
  assert.equal((await view([pr(310, H(9))])).panels.needsYou.some(a => a.id.startsWith('decision-proposal-')), false, 'unreadable head adds none');
  assert.deepEqual(pendingProposals({}, [pr(1, head)], BASE, () => { throw new Error('x'); }), []);
  assert.deepEqual(proposalsAdded(BASE, BASE + entry('D-003', 'homeowner-approved')), [], 'approved entries are not pending');
});

// ---- decisionApproved enforcement, one case per decision code checks
const REG = (...approved) => ['D-020', 'D-021', 'D-024', 'D-025'].map(id => `## ${id} — x\n- Status: ${approved.includes(id) ? 'homeowner-approved' : 'agent-proposal'}\n`).join('\n');
test('ENFORCED_DECISIONS lists exactly the decisions the code gates, and each id is checked via decisionApproved', () => {
  assert.deepEqual(Object.keys(ENFORCED_DECISIONS).sort(), ['D-020', 'D-021', 'D-024', 'D-025']);
  assert.equal(CARRY_DECISION, 'D-025'); assert.equal(INDEPENDENCE_DECISION, 'D-024');
  const src = fs.readFileSync(path.join(ROOT, 'supervisor/team.mjs'), 'utf8');
  for (const id of ['D-021', 'D-024', 'D-025']) assert.match(src, new RegExp(`${id}'`), `${id} is referenced by a gate in team.mjs`);
  for (const id of Object.keys(ENFORCED_DECISIONS)) { assert.equal(decisionApproved(REG(id), id), true); assert.equal(decisionApproved(REG(), id), false); }
});

const H2 = n => String(n).repeat(40);
function carryWorld(t, register) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cfg = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [5] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } }, board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const pull = { number: 10, title: 't', headRefName: 'claude/issue-5-x', headRefOid: H2(2), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] };
  const comments = [];
  const gh = { listPulls: async () => [pull], getPull: async () => pull, listIssues: async () => [], listMergedPulls: async () => [], comment: async (n, b) => comments.push(b), hasComment: async () => false };
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh, jobs: { listActive: async () => [], get: async () => null, create: async () => ({ id: 'a'.repeat(32) }) }, git: { rangeEqual: async () => true }, register, clock: { now: () => 1000 } });
  team.s.verdicts[`10:${H2(1)}`] = { verdict: 'PASS', reviewer: 'codex', job: 'j1', findings: [], at: 1 };
  const job = { kind: 'rebase', pr: 10, head: H2(1), base: 'main', rebase: { newHead: H2(2), resolvedConflicts: false } };
  return { team, job, pull, comments };
}
test('D-025: a PASS carries only while D-025 is homeowner-approved', async t => {
  const on = carryWorld(t, REG('D-025')); const rep = {};
  await on.team.carryVerdict('r1', on.job, rep);
  assert.equal(on.team.s.verdicts[`10:${H2(2)}`].verdict, 'PASS'); assert.equal(rep.carried[0].carried, true);
  const off = carryWorld(t, REG('D-020')); const rep2 = {};
  await off.team.carryVerdict('r1', off.job, rep2);
  assert.equal(off.team.s.verdicts[`10:${H2(2)}`], undefined); assert.equal(off.comments.length, 0);
  // an already-carried verdict stops merging if D-025 is no longer approved
  const entryV = on.team.s.verdicts[`10:${H2(2)}`];
  assert.equal(on.team.carryOk(entryV, on.pull), true);
  on.team.register = REG('D-020'); assert.equal(on.team.carryOk(entryV, on.pull), false);
  assert.equal(on.team.carryOk({ verdict: 'PASS' }, on.pull), true, 'a non-carried verdict is unaffected');
});
test('D-020, D-021 and D-024 gates follow the register', t => {
  const t0 = carryWorld(t, REG('D-024')).team;
  assert.equal(t0.independenceApproved(), true); assert.equal(t0.interimMergeAllowed(), true);
  t0.register = REG('D-021'); assert.equal(t0.independenceApproved(), false); assert.equal(t0.interimMergeAllowed(), true);
  t0.register = REG(); assert.equal(t0.independenceApproved(), false); assert.equal(t0.interimMergeAllowed(), false);
  assert.equal(decisionApproved(REG(), t0.c.access.decision), false, 'D-020 unapproved refuses full access');
  assert.equal(decisionApproved(REG('D-020'), t0.c.access.decision), true);
});

test('parser divergence cannot hide an approval: a second Status line or an unreadable heading is a violation and never approved', () => {
  const dup = BASE.replace('- Status: agent-proposal\n', '- Status: agent-proposal\n- Status: homeowner-approved\n');
  assert.ok(decisionViolations(BASE, dup).some(x => /Status lines/.test(x)));
  assert.equal(decisionApproved(dup, 'D-002'), false);
  const shadow = `## D-002 – shadow\n- Status: homeowner-approved\n\n` + BASE;
  assert.ok(decisionViolations(BASE, shadow).some(x => /cannot read/.test(x)));
  assert.equal(decisionApproved(shadow, 'D-002'), false);
  const colon = BASE + '## D-003: x\n- Status: homeowner-approved\n\n';
  assert.ok(decisionViolations(BASE, colon).length > 0);
  assert.equal(decisionApproved(BASE, 'D-001'), true);
});

test('readHeadRegister does not cache a failed read', async () => {
  const { readHeadRegister } = await import('../supervisor/planning.mjs');
  const src = tmpDir('hr-src-'), clone = tmpDir('hr-clone-');
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  git(src, 'init', '-q'); fs.mkdirSync(path.join(src, 'docs')); fs.writeFileSync(path.join(src, 'docs/DECISIONS.md'), BASE);
  git(src, 'add', '.'); git(src, 'commit', '-qm', 'x'); const sha = git(src, 'rev-parse', 'HEAD');
  git(clone, 'init', '-q');
  const pr = { number: 99991, headRefOid: sha };
  assert.equal(readHeadRegister({ repo_path: clone }, pr), '');
  git(clone, 'fetch', '-q', src, 'HEAD');
  assert.equal(readHeadRegister({ repo_path: clone }, pr), BASE);
});
