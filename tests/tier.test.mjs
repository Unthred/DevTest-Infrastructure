// Issue #1415: the tier reader, the pool order through the real Team, and the explanation text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readTier, orderByTier } from '../supervisor/tier.mjs';
import { explainIssue, collectAssignments } from '../supervisor/issueassign.mjs';
import { Team } from '../supervisor/team.mjs';

const issue = (number, body = '', title = `Issue ${number}`) => ({ number, title, body, state: 'OPEN', labels: [] });

test('a Tier line gives that tier; no line is 4; follow-ups title is 6 unless a line says otherwise', () => {
  assert.deepEqual(readTier(issue(1, 'Tier: 0\n\ntext')), { tier: 0, warning: null });
  assert.deepEqual(readTier(issue(1, 'a\r\nTier: 6\r\n')), { tier: 6, warning: null });
  assert.equal(readTier(issue(1, 'no line')).tier, 4);
  assert.equal(readTier(issue(1, '', 'Review follow-ups for #5')).tier, 6);
  assert.equal(readTier(issue(1, 'Tier: 2', 'Review follow-ups for #5')).tier, 2);
});

test('invalid Tier lines give tier 4 with a warning: value 9, text after the digit, two lines', () => {
  for (const body of ['Tier: 9', 'Tier: 3 soon', 'Tier: 1\nTier: 2']) {
    const r = readTier(issue(1, body));
    assert.equal(r.tier, 4, body); assert.match(r.warning, /Tier line ignored/);
  }
  assert.equal(readTier(issue(1, 'Tier: 9', 'Review follow-ups x')).tier, 6);
});

test('real case: #1331 tier 0 is ahead of #1325 (5), #1327 (6), #1330 (3); equal tiers use number order', () => {
  const list = [issue(1325, 'Tier: 5'), issue(1327, 'Tier: 6'), issue(1330, 'Tier: 3'), issue(1331, 'Tier: 0'), issue(1332, 'Tier: 3')];
  assert.deepEqual(orderByTier(list), [1331, 1330, 1332, 1325, 1327]);
});

const fakeTeam = (issues, lists = {}) => {
  const t = Object.create(Team.prototype);
  t.c = { agents: { claude: { issues: lists.claude || [] }, codex: { issues: [] } } };
  t.s = { unblock: { queued: {} } };
  t.view = { issues, prs: [] };
  return t;
};

test('through the real Team: the pool starts #1331 first; an agent own list is not reordered', () => {
  const issues = [issue(1325, 'Tier: 5'), issue(1327, 'Tier: 6'), issue(1330, 'Tier: 3'), issue(1331, 'Tier: 0'),
    issue(1400, 'Tier: 6'), issue(1401, 'Tier: 0')];
  assert.deepEqual(fakeTeam(issues).unlisted(), [1331, 1401, 1330, 1325, 1327, 1400]);
  const t = fakeTeam(issues, { claude: [1327, 1325] });
  assert.deepEqual(t.issuesOf('claude'), [1327, 1325]);
  assert.deepEqual(t.unlisted(), [1331, 1401, 1330, 1400]);
  assert.deepEqual(t.candidates('claude'), [1327, 1325, 1331, 1401, 1330, 1400]);
});

test('the explanation names tier and place; a bad Tier line warns and does not hold', () => {
  const issues = [issue(1325, 'Tier: 5'), issue(1331, 'Tier: 0'), issue(1340, 'Tier: 9')];
  const t = fakeTeam(issues);
  Object.assign(t, { delivered: new Set(), timeZone: 'UTC', held: {}, modes: {}, limitedOf: () => null, pauseText: () => null,
    modelFor: () => ({ model: 'm' }), exclusion: () => null });
  const rows = collectAssignments(t, { cache: { issues, pulls: [] }, plan: [], states: {}, activeJobs: [] });
  const by = n => rows.find(r => r.number === n);
  assert.match(by(1331).rule, /tier 0, place 1 of 3 ready issues/);
  assert.match(by(1340).rule, /tier 4, place 2 of 3 ready issues.*Tier line ignored/);
  assert.equal(by(1340).tierWarning !== null, true);
  assert.notEqual(by(1340).wait.kind, 'dependency'); assert.equal(by(1340).fault, null);
});

test('an issue in an agent list shows its tier next to its list position', () => {
  const r = explainIssue({ number: 7, zone: 'UTC', running: false, prText: null, exclusion: null, startedEarlier: false, capText: null, planned: null,
    tier: { tier: 2, warning: null }, owner: { agent: 'claude', rule: 'listed', rank: 2, of: 5 },
    agents: [{ name: 'claude', canImplement: true, model: 'm', out: null, busy: false, hold: null }] });
  assert.match(r.rule, /position 2 of 5\); tier 2$/);
});

// The real plan of a tick (same harness as the auto-queue tests): one free slot per agent, so the first two issues of the order start.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stateRoot } from '../supervisor/core.mjs';

test('the real plan of a tick starts #1331 (tier 0) before #1325, #1327 and #1330; an own list is kept', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = async lists => {
    const issues = [issue(1325, 'Tier: 5'), issue(1327, 'Tier: 6'), issue(1330, 'Tier: 3'), issue(1331, 'Tier: 0')];
    const agent = (p, own) => ({ provider: p, branch_prefix: `${p}/`, issues: own });
    const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
      limits: { roles: { implementer: 1, reviewer: 1 }, overall: 1, max_review_attempts: 2, max_fix_attempts: 2 },
      agents: { claude: agent('claude', lists.claude), codex: agent('codex', lists.codex) } };
    const gh = { listPulls: async () => [], listIssues: async () => issues, listMergedPulls: async () => [] };
    const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'a'.repeat(32) }) };
    const team = new Team({ config, root: stateRoot(path.join(dir, `s${Math.random()}`)), gh, jobs,
      git: { ensureWorktree: async o => o.path, worktreeFor: async () => null },
      register: '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n', clock: { now: () => 1000 } });
    return (await team.plan()).filter(a => a.type === 'implement').map(a => a.issue);
  };
  assert.equal((await run({ claude: [], codex: [] }))[0], 1331);
  assert.equal((await run({ claude: [1327], codex: [] }))[0], 1327, 'a listed issue still goes first to its owner');
});
