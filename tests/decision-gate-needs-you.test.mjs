// Issue #249: an unapproved decision that holds back reviewed PRs is one Needs you item, named in the overseer note.
// No GitHub call and no model call.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildView } from '../supervisor/dashboard.mjs';

const NOW = 1_800_000_000_000;
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];
const config = () => ({
  schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
  agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [] } } });
const pr = (n, branch, head, extra = {}) => ({ number: n, title: `pr ${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', statusCheckRollup: green, labels: [], ...extra });
const reg = status => `## D-020 — a\n- Status: homeowner-approved\n\n## D-024 — Review independence by session and model\n- Status: ${status}\n- Decision: A review is independent by model. More text.\n- Rationale: x\n`;
const verdict = (n, h, extra = {}) => ({ [`${n}:${h}`]: { verdict: 'PASS', reviewer: 'claude', independent: true, at: NOW - 1000, head: h, pr: n, findings: [], ...extra } });
const root = t => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-')); t.after(() => fs.rmSync(r, { recursive: true, force: true })); fs.chmodSync(r, 0o700); return r; };
const run = (t, { register, pulls, verdicts }) => buildView({ config: config(), root: root(t), jobs: [], events: [], state: { verdicts }, register,
  cache: { tick: { at: NOW - 60000, status: 'ok', error: null, lastOkAt: NOW - 60000 }, pulls, issues: [] }, snapshots: [], now: NOW });
const two = () => ({ pulls: [pr(201, 'claude/issue-1-a', H(1), { title: 'first' }), pr(203, 'claude/issue-2-b', H(2), { title: 'second' })], verdicts: { ...verdict(201, H(1)), ...verdict(203, H(2)) } });

test('an agent-proposal gating decision with waiting PRs raises exactly one item listing them and how to approve', async t => {
  const v = await run(t, { register: reg('agent-proposal'), ...two() });
  const items = v.panels.needsYou.filter(a => a.id === 'decision-D-024');
  assert.equal(items.length, 1);
  const [it] = items;
  assert.match(it.text, /D-024 \(Review independence by session and model\)/);
  assert.match(it.text, /201/); assert.match(it.text, /203/);
  assert.match(it.tried, /A review is independent by model\./);
  assert.doesNotMatch(it.tried, /More text/);
  assert.match(it.decision, /docs\/DECISIONS\.md on main/);
  assert.match(it.decision, /Status: homeowner-approved/);
  assert.equal(it.links.length, 2);
});
test('the overseer note names the decision and what it unblocks', async t => {
  const v = await run(t, { register: reg('agent-proposal'), ...two() });
  const note = v.panels.needsYou.find(a => a.id === 'decision-D-024').overseer;
  assert.match(note, /D-024/); assert.match(note, /201/); assert.match(note, /Status: homeowner-approved/);
});
test('no item once the decision is homeowner-approved', async t => {
  const v = await run(t, { register: reg('homeowner-approved'), ...two() });
  assert.equal(v.attention.some(a => a.id.startsWith('decision-')), false);
});
test('a proposal that gates nothing raises none: no PASS, red CI, draft, conflict or a different-provider PASS', async t => {
  const base = two();
  const cases = {
    'no verdict': { ...base, verdicts: {} },
    'red CI': { ...base, pulls: base.pulls.map(p => ({ ...p, statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] })) },
    'draft': { ...base, pulls: base.pulls.map(p => ({ ...p, isDraft: true })) },
    'conflict': { ...base, pulls: base.pulls.map(p => ({ ...p, mergeable: 'CONFLICTING' })) },
    'other provider reviewed': { ...base, verdicts: { ...verdict(201, H(1), { reviewer: 'codex', independent: false }), ...verdict(203, H(2), { reviewer: 'codex', independent: false }) } },
    'no PRs': { pulls: [], verdicts: {} }
  };
  for (const [name, c] of Object.entries(cases)) {
    const v = await run(t, { register: reg('agent-proposal'), ...c });
    assert.equal(v.attention.some(a => a.id.startsWith('decision-')), false, name);
  }
});
test('a PASS recorded for an older head does not count', async t => {
  const v = await run(t, { register: reg('agent-proposal'), pulls: [pr(201, 'claude/issue-1-a', H(1))], verdicts: verdict(201, H(9)) });
  assert.equal(v.attention.some(a => a.id.startsWith('decision-')), false);
});
