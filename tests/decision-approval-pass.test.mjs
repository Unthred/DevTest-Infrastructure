// Issue #1229: Foreman assigns the D number when the owner approves. Real git (a bare origin and a clone), the real approval step, and the
// real Team.tickPass as the entry point; only GitHub and the job store are faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Team } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const NAME = '1164-queue-control';
const URL_ = 'https://github.com/o/r/pull/9#issuecomment-77';
const FILE = `# Queue control\n- Status: agent-proposal\n- Date: 2026-11-12\n- Source: issue #1164\n- Decision: x\n- Rationale: y\n- Rejected: z\n- Superseded-by: none\n`;

function world(t, comments) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'decapp-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { encoding: 'utf8' }).trim();
  const origin = path.join(dir, 'origin.git'), seed = path.join(dir, 'seed'), repo = path.join(dir, 'repo');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  fs.mkdirSync(path.join(seed, 'docs/decisions'), { recursive: true });
  fs.writeFileSync(path.join(seed, 'docs/DECISIONS.md'), '# Decision register\n\n## D-041 — old\n- Status: homeowner-approved\n');
  fs.writeFileSync(path.join(seed, `docs/decisions/${NAME}.md`), FILE);
  g(seed, 'add', '.'); g(seed, 'commit', '-q', '-m', 'seed'); g(seed, 'push', '-q', origin, 'main');
  execFileSync('git', ['clone', '-q', origin, repo]);
  const posted = [];
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: repo, worktree_base: dir, access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: 2 },
    models: { agents: { claude: { fix: { model: 'sonnet' }, strong: { model: 'opus' } } } },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [1164] } }, board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } };
  const gh = { listPulls: async () => [], listIssues: async () => [], listMergedPulls: async () => [{ number: 9, headRefName: 'claude/issue-1164-queue-control', closingIssuesReferences: [{ number: 1164 }] }],
    prComments: async n => (n === 9 ? comments : []), comment: async (n, body) => posted.push([n, body]), hasComment: async () => false, findIssueByMarker: async () => null, createIssue: async () => 1, board: async () => {}, getPull: async () => null };
  const jobs = { listActive: async () => [], get: async () => null, create: async () => ({ id: 'x' }) };
  const team = new Team({ config, root: stateRoot(path.join(dir, 'state')), gh, jobs, git: { ensureWorktree: async o => o.path, worktreeFor: async () => null },
    register: '## D-020 — x\n- Status: homeowner-approved\n', clock: { now: () => 1_000_000 }, alert: async () => {} });
  const onMain = () => execFileSync('git', ['-C', origin, 'show', `main:docs/decisions/${NAME}.md`], { encoding: 'utf8' });
  return { team, posted, onMain, origin, g, repo };
}
const ownerSays = body => ({ login: 'o', createdAt: new Date(1000).toISOString(), url: URL_, body });

test('a tick assigns the next D number once on main when the owner approved by file name, and a second tick changes nothing', async t => {
  const w = world(t, [ownerSays(`homeowner-approval: ${NAME}`)]);
  const r = await w.team.tickPass();
  assert.deepEqual(r.skipped.filter(s => /decision approval/.test(s.what || '')), []);
  assert.match(w.onMain(), /- Status: homeowner-approved/);
  assert.match(w.onMain(), /- Number: D-042/);
  assert.match(w.onMain(), new RegExp(`approved at ${URL_}`));
  assert.match(execFileSync('git', ['-C', w.origin, 'show', 'main:docs/decisions/INDEX.md'], { encoding: 'utf8' }), /D-042/);
  assert.equal(w.posted.length, 1);
  w.g(w.repo, 'fetch', '-q', 'origin');
  const head = w.g(w.origin, 'rev-parse', 'main');
  await w.team.tickPass();
  assert.equal(w.g(w.origin, 'rev-parse', 'main'), head, 'the second pass adds no commit');
  assert.equal(w.posted.length, 1);
});

test('a tick assigns nothing without the owner\'s approval comment, or on a comment from someone else', async t => {
  const w = world(t, [{ ...ownerSays(`homeowner-approval: ${NAME}`), login: 'someone-else' }, ownerSays('looks fine')]);
  const before = w.g(w.origin, 'rev-parse', 'main');
  await w.team.tickPass();
  assert.equal(w.g(w.origin, 'rev-parse', 'main'), before);
  assert.match(w.onMain(), /agent-proposal/);
});

test('an approval comment with no url is refused and recorded, and main is unchanged', async t => {
  const w = world(t, [{ ...ownerSays(`homeowner-approval: ${NAME}`), url: '' }]);
  const before = w.g(w.origin, 'rev-parse', 'main');
  const r = await w.team.tickPass();
  assert.equal(w.g(w.origin, 'rev-parse', 'main'), before);
  assert.ok(r.skipped.some(s => /decision approval/.test(s.what) && /no comment url/.test(s.reason)), JSON.stringify(r.skipped));
});
