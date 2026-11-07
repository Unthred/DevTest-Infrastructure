// Issue #853 requirement 4: unticked "Homeowner steps" in a PR body are a Needs you item until done.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';
import { buildView } from '../supervisor/dashboard.mjs';

const NOW = 1_800_000_000_000;
const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] } } };
const pr = (n, body) => ({ number: n, title: `t${n}`, body, headRefName: `claude/issue-${n}-x`, headRefOid: String(n).repeat(40).slice(0, 40), baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });

async function view(t, pulls) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const gh = { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n), listIssues: async () => [], listMergedPulls: async () => [], comment: async () => {}, hasComment: async () => false, findIssueByMarker: async () => null, board: async () => {}, addLabel: async () => {}, removeLabel: async () => {} };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'x'.repeat(32) }) };
  const team = new Team({ config, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null }, register: '## D-020 — x\n- Status: homeowner-approved\n', clock: { now: () => NOW } });
  return buildView({ config, root: team.root, jobs: [], events: [], state: team.s, register: '', cache: { tick: { at: NOW - 1000, status: 'ok', error: null, lastOkAt: NOW - 1000 }, pulls, issues: [] }, snapshots: [], now: NOW });
}

test('an unticked homeowner step is a Needs you item; ticked, None or absent are not', async t => {
  const v = await view(t, [pr(1, '## Homeowner steps\n- [ ] Restart the widget\n'), pr(2, '## Homeowner steps\n- [x] Done already\n'), pr(3, '## Homeowner steps\n- None\n'), pr(4, 'no heading')]);
  const ids = v.attention.map(a => a.id).filter(i => i.startsWith('homeowner-steps-'));
  assert.deepEqual(ids, ['homeowner-steps-1']);
  assert.match(v.attention.find(a => a.id === 'homeowner-steps-1').text, /Restart the widget/);
});
