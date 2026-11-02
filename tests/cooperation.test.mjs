// Issue #9: branch/worktree identity and exclusive-file conflicts between open branches.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { check, checkConflicts, checkIdentity, exclusiveKind, parseBranch, worktreeName } from '../tools/cooperation.mjs';

const tool = new URL('../tools/cooperation.mjs', import.meta.url).pathname;
const pr = (number, headRefName, ...files) => ({ number, headRefName, files: files.map((p) => ({ path: p })) });

test('branch names parse per D-018 and bad ones are rejected', () => {
  assert.deepEqual(parseBranch('claude/issue-9-09-parallel-agent'), { agent: 'claude', issue: 9, slug: '09-parallel-agent' });
  for (const bad of ['main', 'claude/issue-x-a', 'claude/9-a', 'issue-9-a', '', null]) assert.equal(parseBranch(bad), null);
});
test('worktree must match branch owner and issue', () => {
  assert.equal(worktreeName('claude', 9), 'DevTest-Infrastructure-claude-9');
  assert.deepEqual(checkIdentity('claude/issue-9-x', '/mnt/user/projects/DevTest-Infrastructure-claude-9/'), []);
  assert.match(checkIdentity('claude/issue-9-x', '/mnt/user/projects/DevTest-Infrastructure-codex-9')[0], /must be DevTest-Infrastructure-claude-9/);
  assert.match(checkIdentity('claude/issue-9-x', '/mnt/user/projects/DevTest-Infrastructure')[0], /one writer per worktree/);
  assert.match(checkIdentity('feature', null)[0], /D-018/);
});
test('exclusive files: migrations, secrets, register, handover; ordinary files are not', () => {
  for (const f of ['supervisor/migrations/002-x.mjs', 'broker/vault.mjs', '.env.local', 'a/server.key', 'docs/DECISIONS.md', 'docs/ai/CURRENT_HANDOVER.md']) assert.ok(exclusiveKind(f), f);
  for (const f of ['README.md', 'tests/a.test.mjs', 'supervisor/core.mjs']) assert.equal(exclusiveKind(f), null, f);
});
test('two open branches changing the same migration conflict; disjoint or ordinary overlap does not', () => {
  const others = [pr(5, 'codex/issue-5-a', 'supervisor/migrations/002-x.mjs', 'README.md')];
  assert.match(checkConflicts('claude/issue-9-a', ['supervisor/migrations/002-x.mjs'], others)[0], /migration\) is also changed by PR #5/);
  assert.deepEqual(checkConflicts('claude/issue-9-a', ['supervisor/migrations/003-y.mjs'], others), []);
  assert.deepEqual(checkConflicts('claude/issue-9-a', ['README.md'], others), []);
});
test('a second owner of the same issue is refused; the branch itself is ignored', () => {
  assert.match(checkConflicts('codex/issue-9-b', [], [pr(7, 'claude/issue-9-a')])[0], /already owned by PR #7/);
  assert.deepEqual(checkConflicts('claude/issue-9-a', ['broker/x.mjs'], [pr(7, 'claude/issue-9-a', 'broker/x.mjs')]), []);
});
test('check combines identity and conflicts', () => {
  const r = check({ branch: 'claude/issue-9-a', worktree: '/x/wrong', files: ['broker/a'], others: [pr(2, 'codex/issue-2-b', 'broker/a')] });
  assert.equal(r.length, 2);
});
test('CLI: exit 0 clean, 1 on conflict, 2 on usage or unreadable input', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coop-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'p.json'); fs.writeFileSync(f, JSON.stringify([pr(5, 'codex/issue-5-a', 'broker/a')]));
  const run = (...a) => spawnSync('node', [tool, ...a], { encoding: 'utf8' });
  assert.equal(run('--branch', 'claude/issue-9-a', '--files', 'README.md', '--others', f).status, 0);
  const bad = run('--branch', 'claude/issue-9-a', '--files', 'broker/a', '--others', f); assert.equal(bad.status, 1); assert.match(bad.stderr, /FAIL/);
  assert.equal(run().status, 2);
  assert.equal(run('--branch', 'claude/issue-9-a', '--others', path.join(dir, 'missing.json')).status, 2);
});
