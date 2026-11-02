// Session-resume argument shapes (issue #20). Pins the argv to what the installed CLIs' own --help documents
// (Claude Code 2.1.316 `--resume <id>`, Codex 0.166.0 `exec resume [SESSION_ID] [PROMPT]`, checked 2026-11-02).
// This is help-level evidence only: that a resumed session continues the same work after a real reset is still unobserved,
// so these tests also pin that resume is never offered while the capability is not `supported`.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as codex from '../supervisor/adapters/codex.mjs';

const cfg = (resume) => ({ command: ['codex'], manifest: { capabilities: { resume } }, arguments: [], resumeArguments: [] });
const job = { role: 'devtest', sessionId: '00000000-0000-4000-8000-000000000000', access: 'standard', worktree: '/w' };

test('codex resume: every exec option precedes `resume` (the resume subcommand does not accept --cd or --profile), prompt comes from stdin', () => {
  const argv = codex.command(cfg('supported'), job, true);
  const at = argv.indexOf('resume');
  assert.ok(at > 0);
  assert.deepEqual(argv.slice(at), ['resume', job.sessionId, '-']);
  for (const flag of ['--json', '--profile', '--cd']) assert.ok(argv.indexOf(flag) > -1 && argv.indexOf(flag) < at, flag);
});

test('resume is never offered without a session id or while the capability is unverified', () => {
  assert.ok(!codex.command(cfg('supported'), { ...job, sessionId: null }, true).includes('resume'));
  assert.ok(!codex.command(cfg('unverified'), job, true).includes('resume'));
  assert.ok(!codex.command(cfg('supported'), job, false).includes('resume'));
  assert.equal(codex.command(cfg('unverified'), job, true).at(-1), '-');
});
