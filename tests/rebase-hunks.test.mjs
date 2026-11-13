// Issue #1228: the rebase push guard compares what each commit changes. Every case drives the real `rebase-push` command (the CLI the
// rebase prompt names) against a scratch repository: a bare remote plus independent clones (D-011). No model call, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { rebasePrompt } from '../supervisor/team.mjs';
import { prepareRebase } from '../supervisor/rebasecheck.mjs';
import { readRefusal } from '../supervisor/rebaserefusal.mjs';
import { parseHunks } from '../supervisor/rebasehunks.mjs';

const G = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false'];
const git = (cwd, ...a) => execFileSync('git', [...G, ...a], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const cli = new URL('../supervisor/cli.mjs', import.meta.url).pathname;
const lines = (...l) => l.join('\n') + '\n';

// base -> feat (one commit "pr change") on the branch; main moves on with `main`; the agent resolves with `resolution`.
function world(t, { file = 'f.txt', base, feat, main, resolution }) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const remote = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  const seed = path.join(dir, 'seed');
  git(dir, 'clone', '-q', remote, seed);
  const put = (text, msg) => { fs.writeFileSync(path.join(seed, file), text); git(seed, 'add', '-A'); git(seed, 'commit', '-q', '-m', msg); };
  put(base, 'base'); git(seed, 'branch', '-M', 'main'); git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'checkout', '-q', '-b', 'feat'); put(feat, 'pr change'); git(seed, 'push', '-q', 'origin', 'feat');
  git(seed, 'checkout', '-q', 'main'); put(main, 'main moves'); git(seed, 'push', '-q', 'origin', 'main');
  const agent = path.join(dir, 'agent');
  git(dir, 'clone', '-q', remote, agent);
  const { oldHead } = prepareRebase({ worktree: agent, branch: 'feat' });
  const w = { dir, remote, agent, file, oldHead };
  try { git(agent, 'rebase', 'origin/main'); } catch { /* a conflict, resolved next */ }
  resolve(w, resolution);
  return w;
}
// Write the file and finish the rebase (or amend the finished commit when the rebase already completed).
function resolve(w, text) {
  fs.writeFileSync(path.join(w.agent, w.file), text);
  git(w.agent, 'add', '-A');
  const rebasing = fs.existsSync(path.join(w.agent, git(w.agent, 'rev-parse', '--git-path', 'rebase-merge')));
  if (rebasing) execFileSync('git', [...G, 'rebase', '--continue'], { cwd: w.agent, env: { ...process.env, GIT_EDITOR: 'true' }, stdio: 'ignore' });
  else git(w.agent, 'commit', '-q', '--amend', '--no-edit');
}
function push(w) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'rhr-'));
  try {
    const out = execFileSync(process.execPath, [cli, 'rebase-push', '--worktree', w.agent, '--branch', 'feat', '--base', 'main', '--old', w.oldHead],
      { encoding: 'utf8', env: { ...process.env, AI_SUPERVISOR_STATE_ROOT: root }, stdio: ['ignore', 'pipe', 'ignore'] });
    return { code: 0, out: JSON.parse(out) };
  } catch (e) { return { code: e.status, out: JSON.parse(e.stdout) }; } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const remoteHead = w => git(w.agent, 'ls-remote', 'origin', 'refs/heads/feat').split(/\s/)[0];

test('a moved hunk is accepted: the PR line sits elsewhere in the result and the push goes through', t => {
  const w = world(t, {
    base: lines('a', 'b', 'c', 'd'), feat: lines('a', 'b', 'feature();', 'c', 'D'), main: lines('a', 'B', 'c', 'd'),
    resolution: lines('a', 'B', 'c', 'D', 'feature();'),
  });
  const p = push(w);
  assert.equal(p.out.pushed, true, JSON.stringify(p.out.lostChanges));
  assert.deepEqual(p.out.lostChanges, []);
});

test('a missing hunk is refused with the commit, the file and the hunk, and the remote head stays', t => {
  const w = world(t, {
    base: lines('a', 'b', 'c', 'd'), feat: lines('a', 'b', 'feature();', 'c', 'D'), main: lines('a', 'B', 'c', 'd'),
    resolution: lines('a', 'B', 'c', 'D'),
  });
  const before = remoteHead(w);
  const p = push(w);
  assert.equal(p.code, 3);
  assert.equal(p.out.reason, 'lost-changes');
  const [f] = p.out.lostChanges;
  assert.equal(f.kind, 'missing');
  assert.equal(f.file, 'f.txt');
  assert.equal(f.subject, 'pr change');
  assert.match(f.commit, /^[0-9a-f]{40}$/);
  assert.match(f.hunk, /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@$/);
  assert.equal(f.text, '+ feature();');
  assert.match(p.out.message, /commit [0-9a-f]{8} "pr change", f\.txt, hunk @@ .* @@: the change is missing \(\+ feature\(\);\)/);
  assert.equal(remoteHead(w), before);
});

test('a change main already made is excluded, not guessed: the PR line main also added need not be in the result twice', t => {
  const w = world(t, {
    base: lines('a', 'b', 'c'), feat: lines('a', 'shared();', 'b', 'mine();', 'c'), main: lines('a', 'shared();', 'b2', 'c'),
    resolution: lines('a', 'shared();', 'b2', 'mine();', 'c'),
  });
  const p = push(w);
  assert.equal(p.out.pushed, true, JSON.stringify(p.out.lostChanges));
});

test('an altered hunk is refused and called altered, not missing', t => {
  const w = world(t, {
    base: lines('a', 'limit = 1', 'c'), feat: lines('a', 'limit = 10', 'c', 'more();'), main: lines('a', 'limit2 = 1', 'c'),
    resolution: lines('a', 'limit2 = 1', 'limit = 11', 'c', 'more();'),
  });
  const p = push(w);
  assert.equal(p.out.pushed, false);
  assert.deepEqual(p.out.lostChanges.map(f => [f.kind, f.text]), [['altered', '+ limit = 10']]);
});

test('a renumbered line is accepted when the old number is one main took; any other number change is refused', t => {
  const base = lines('# Register', '## D-039 old');
  const feat = lines('# Register', '## D-039 old', '## D-040 mine', '- Status: proposal');
  const main = lines('# Register', '## D-039 old', '## D-040 other', '## D-041 other');
  const ok = world(t, { base, feat, main, resolution: lines('# Register', '## D-039 old', '## D-040 other', '## D-041 other', '## D-042 mine', '- Status: proposal') });
  assert.equal(push(ok).out.pushed, true);
  const noMain = world(t, {
    base: lines('x = 1', 'k'), feat: lines('x = 1', 'limit = 10', 'k', 'more();'), main: lines('x = 1', 'other', 'k'),
    resolution: lines('x = 1', 'other', 'limit = 11', 'k', 'more();'),
  });
  const bad = push(noMain);
  assert.equal(bad.out.pushed, false);
  assert.equal(bad.out.lostChanges[0].kind, 'altered');
});

test('regression, PR 1131: supervisor/inbox.mjs "export { ACTIONS };" is not asked back after main exported the const itself', t => {
  const w = world(t, {
    file: 'inbox.mjs',
    base: lines('const ACTIONS = {', '  a: 1,', '};', 'const Z = 1;'),
    feat: lines('const ACTIONS = {', '  a: 1,', '};', 'export { ACTIONS };', 'const Z = 2;'),
    main: lines('export const ACTIONS = {', '  a: 1,', '  b: 2,', '};', 'const Z = 1;'),
    resolution: lines('export const ACTIONS = {', '  a: 1,', '  b: 2,', '};', 'const Z = 2;'),
  });
  const p = push(w);
  assert.equal(p.out.pushed, true, JSON.stringify(p.out.lostChanges));
  assert.equal(remoteHead(w), git(w.agent, 'rev-parse', 'HEAD'));
});

test('issue #580 kept: a list both sides edited and the resolution united is accepted', t => {
  const w = world(t, {
    base: lines('x', "const L = ['a'];", 'y'), feat: lines('x', "const L = ['a', 'b'];", 'y', 'more();'), main: lines('x', "const L = ['a', 'c'];", 'y'),
    resolution: lines('x', "const L = ['a', 'b', 'c'];", 'y', 'more();'),
  });
  const p = push(w);
  assert.equal(p.out.pushed, true, JSON.stringify(p.out.lostChanges));
});

test('issue #640 kept: a call both sides edited on the same line, merged into one, is accepted', t => {
  const w = world(t, {
    base: lines('x', 'call(a);', 'y'), feat: lines('x', 'call(a, opts);', 'y', 'more();'), main: lines('x', 'invoke(a);', 'y'),
    resolution: lines('x', 'invoke(a, opts);', 'y', 'more();'),
  });
  const p = push(w);
  assert.equal(p.out.pushed, true, JSON.stringify(p.out.lostChanges));
});

test('a dropped pure addition is refused even when its tokens appear on another added line (merged rule needs both sides to edit a line)', t => {
  const w = world(t, {
    base: lines('cfg = {', '  a: 1,', '};', 'x', 'y'),
    feat: lines('cfg = {', '  a: 1,', '  strict: true,', '};', 'x', 'if (cfg.strict === true) run();', 'y'),
    main: lines('cfg = {', '  a: 2,', '};', 'x', 'y'),
    resolution: lines('cfg = {', '  a: 2,', '};', 'x', 'if (cfg.strict === true) run();', 'y'),
  });
  const p = push(w);
  assert.equal(p.out.pushed, false);
  assert.equal(p.out.lostChanges[0].kind, 'missing');
  assert.match(p.out.lostChanges[0].text, /strict: true/);
});

test('regression, PR 1192: the register entry D-040 renumbered D-042 after main took D-040 is accepted and pushed', t => {
  const w = world(t, {
    file: 'DECISIONS.md',
    base: lines('## D-039 — old', '- Status: x'),
    feat: lines('## D-039 — old', '- Status: x', '## D-040 — A parked item holds the watch', '- Status: agent-proposal', '- Source: issue #1'),
    main: lines('## D-039 — old', '- Status: x', '## D-040 — A stopped job is never a fault', '- Status: agent-proposal'),
    resolution: lines('## D-039 — old', '- Status: x', '## D-040 — A stopped job is never a fault', '- Status: agent-proposal',
      '## D-042 — A parked item holds the watch', '- Status: agent-proposal', '- Source: issue #1'),
  });
  const p = push(w);
  assert.equal(p.out.pushed, true, JSON.stringify(p.out.lostChanges));
  assert.equal(remoteHead(w), git(w.agent, 'rev-parse', 'HEAD'));
});

const gone = { base: lines('a', 'b', 'c', 'd'), feat: lines('a', 'b', 'feature();', 'c', 'D'), main: lines('a', 'B', 'c', 'd') };

test('repair path with a fake agent: the first push is refused, the agent restores the hunk, the second push is accepted', t => {
  const w = world(t, { ...gone, resolution: lines('a', 'B', 'c', 'D') });
  const first = push(w);
  assert.equal(first.code, 3);
  assert.equal(first.out.attempt, 1);
  assert.equal(first.out.stop, false);
  assert.match(first.out.message, /run rebase-push once more/);
  assert.equal(readRefusal(w.agent, w.oldHead).reason, 'lost-changes');
  // the fake agent restores the named hunk in a commit of its own: the prompt forbids amending
  fs.writeFileSync(path.join(w.agent, w.file), lines('a', 'B', 'c', 'D', 'feature();'));
  git(w.agent, 'commit', '-q', '-am', 'restore feature');
  const second = push(w);
  assert.equal(second.code, 0);
  assert.equal(second.out.pushed, true);
  assert.equal(remoteHead(w), git(w.agent, 'rev-parse', 'HEAD'));
});

test('a second refusal ends the run with the existing stop (rebase-stop)', t => {
  const w = world(t, { ...gone, resolution: lines('a', 'B', 'c', 'D') });
  assert.equal(push(w).out.stop, false);
  resolve(w, lines('a', 'B', 'c', 'D', 'other();'));   // the fake agent restores the wrong thing
  const second = push(w);
  assert.equal(second.code, 3);
  assert.equal(second.out.pushed, false);
  assert.equal(second.out.stop, true);
  assert.match(second.out.message, /second refusal/);
  const note = readRefusal(w.agent, w.oldHead);
  assert.equal(note.reason, 'agent-stop');   // what rebase-stop writes, so the dispatcher stops retrying this head
});

test('the rebase prompt: restore once, never rewrite commits, own-growth failures stop at once, register not special cased', () => {
  const p = rebasePrompt({ pr: 5, head: 'a'.repeat(40), base: 'main', branch: 'feat', inbox: '/x' });
  assert.match(p, /restore that change in the commit it belongs to/);
  assert.match(p, /never amend, squash, reword or reorder commits/);
  assert.match(p, /refused a second time[^.]*rebase-stop/);
  assert.match(p, /size ratchet[^.]*out of scope for a rebase: run rebase-stop at once/);
  assert.doesNotMatch(p, /DECISIONS\.md[^.]*lost/);
});

test('parseHunks keeps no context and names a binary file by its new blob', () => {
  const text = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-old\n+new\ndiff --git a/i b/i\nindex 3..abc 100644\nBinary files a/i and b/i differ\n';
  assert.deepEqual(parseHunks(text), [
    { file: 'x', header: '@@ -1,2 +1,2 @@', removed: ['old'], added: ['new'] },
    { file: 'i', header: 'binary', removed: [], added: ['binary abc'] },
  ]);
});
