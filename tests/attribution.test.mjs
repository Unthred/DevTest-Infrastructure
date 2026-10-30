// tools/ci/validate-commit-attribution.sh: AI attribution in commit messages or the PR body fails; ordinary mentions do not.
// Forbidden strings are assembled at run time so this file stays clean under its own scan and the project validator.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = new URL('../tools/ci/validate-commit-attribution.sh', import.meta.url).pathname;
const j = (...p) => p.join('');
const git = (cwd, ...a) => { const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };

function repoWith(t, messages) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q', '-b', 'main'); git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  for (const m of messages) git(dir, 'commit', '-q', '--allow-empty', '-m', m);
  return { dir, base };
}
const run = (r, { body } = {}) => spawnSync('bash', [script, r.base, 'HEAD'], { cwd: r.dir, encoding: 'utf8', env: { ...process.env, ...(body === undefined ? {} : { PR_BODY: body }) } });

const bad = {
  'AI co-author trailer (Claude)': `Fix thing\n\nunrelated body line\n${j('Co-Authored-', 'By')}: ${j('Cla', 'ude')} Sonnet <${j('noreply@', 'anthropic.com')}>`,
  'AI co-author trailer (Codex)': `Fix thing\n\nunrelated body line\n${j('co-authored-', 'by')}: ${j('Co', 'dex')} <bot@example.invalid>`,
  'generated-with footer': `Fix thing\n\nunrelated body line\n${j('🤖 Gener', 'ated with')} [${j('Claude ', 'Code')}](https://example.invalid)`,
  'italic generated-by footer': `Fix thing\n\nunrelated body line\n_${j('Gener', 'ated by')} [${j('Claude ', 'Code')}](https://example.invalid)_`,
  'session link': `Fix thing\n\nunrelated body line\nhttps://${j('claude', '.ai/code')}/session_0123456789`,
  'made-with footer': `Fix thing\n\nunrelated body line\n${j('Made-', 'with')}: ${j('Cur', 'sor')}`,
  'bot e-mail only': `Fix thing\n\nunrelated body line\nSigned-off-by: x <${j('cursoragent', '@cursor.com')}>`
};

test('each AI attribution shape in a commit message fails, naming only the offending line', t => {
  for (const [label, message] of Object.entries(bad)) {
    const r = run(repoWith(t, ['clean first', message]));
    assert.equal(r.status, 1, label); assert.match(r.stderr, /FAIL: AI attribution in commit/, label);
    assert.ok(!r.stderr.includes("unrelated body line"), `${label}: only the offending line is echoed`);
  }
});

test('other AI-tool session links and bot e-mails fail in a commit and in the PR body', t => {
  const lines = [`https://${j('chat', 'gpt.com')}/share/example-session`, `https://${j('chat.open', 'ai.com')}/share/abc`, `https://${j('gemini.google', '.com')}/share/abc`,
    `https://${j('claude', '.ai')}/share/abc`, `Signed-off-by: x <${j('no', 'reply@openai.com')}>`, `Signed-off-by: x <${j('co', 'dex-bot@openai.com')}>`];
  for (const line of lines) {
    const r = repoWith(t, [`Fix thing\n\nunrelated body line\n${line}`]);
    assert.equal(run(r).status, 1, line); assert.equal(run(r, { body: `Closes #1\n${line}` }).status, 1, line);
  }
});

test('an unresolvable ref is fatal, never a green check', t => {
  const r = repoWith(t, ['clean']);
  for (const args of [[r.base, 'no-such-ref'], ['no-such-ref', 'HEAD']]) {
    const x = spawnSync('bash', [script, ...args], { cwd: r.dir, encoding: 'utf8' });
    assert.equal(x.status, 1, args.join(' ')); assert.match(x.stderr, /not a commit/); assert.ok(!x.stdout.includes('OK:'));
  }
});

test('the diagnostic never echoes the commit subject', t => {
  const x = run(repoWith(t, [`Unrelated subject marker\n\n${j('Gener', 'ated with')} ${j('Claude ', 'Code')}`]));
  assert.equal(x.status, 1); assert.ok(!x.stderr.includes('Unrelated subject marker'), x.stderr);
});

test('clean history and ordinary mentions pass', t => {
  const ok = [
    'Fix the Claude adapter parser for truncated lines',
    'Add Codex preflight\n\nThe codex binary is resolved by absolute path.',
    'Docs: generated with protoc, not by hand',
    'Co-authored-by: Alice Example <alice@example.invalid>',
    'Handle AIR flow sensor timeouts'
  ];
  const r = run(repoWith(t, ok));
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /OK: validate-commit-attribution/);
  assert.equal(run(repoWith(t, [])).status, 0);   // empty range
});

test('the pull request body is checked too, and only when present', t => {
  const r = repoWith(t, ['clean']);
  assert.equal(run(r, { body: 'Closes #1\n\nSummary of the change.' }).status, 0);
  assert.equal(run(r, { body: '' }).status, 0);
  for (const [label, line] of [['footer', `${j('🤖 Gener', 'ated with')} [${j('Claude ', 'Code')}](https://example.invalid)`], ['session link', `https://${j('claude', '.ai/code')}/session_abc`]]) {
    const x = run(r, { body: `Closes #1\n\n${line}` });
    assert.equal(x.status, 1, label); assert.match(x.stderr, /in the pull request body/, label); assert.ok(!x.stderr.includes('Closes #1'));
  }
});

test('only commits in the range are scanned', t => {
  const r = repoWith(t, [bad['generated-with footer'], 'clean tip']);
  const tip = git(r.dir, 'rev-parse', 'HEAD');
  assert.equal(spawnSync('bash', [script, tip, 'HEAD'], { cwd: r.dir, encoding: 'utf8' }).status, 0);   // nothing after the tip
  assert.equal(run(r).status, 1);                                                                     // the bad one is in base..HEAD
});

test('the CI workflow runs the check on pull requests with full history and the body passed through the environment', () => {
  const ci = fs.readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(ci, /validate-commit-attribution\.sh/); assert.match(ci, /fetch-depth: 0/);
  assert.match(ci, /PR_BODY: \$\{\{ github\.event\.pull_request\.body \}\}/);
  assert.match(ci, /types: \[opened, synchronize, reopened, edited\]/);
  assert.ok(!/run: .*\$\{\{ github\.event\.pull_request\.body/.test(ci), 'the body is never interpolated into a shell command');
});

test('AGENTS.md states the rule', () => {
  const a = fs.readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8');
  assert.match(a, /No AI attribution/); assert.match(a, /validate-commit-attribution/);
});
