// Session-resume argument shapes (issue #20). Pins the argv to what the installed CLIs' own --help documents
// (Claude Code 2.1.316 `--resume <id>`, Codex 0.166.0 `exec resume [SESSION_ID] [PROMPT]`, checked 2026-11-02).
// This is help-level evidence only: that a resumed session continues the same work after a real reset is still unobserved,
// so these tests also pin that resume is never offered while the capability is not `supported`.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as codex from '../supervisor/adapters/codex.mjs';
import * as claude from '../supervisor/adapters/claude.mjs';
import fs from 'node:fs';

const cfg = (resume) => ({ command: ['codex'], manifest: { capabilities: { resume } }, arguments: [], resumeArguments: [] });
const job = { role: 'devtest', sessionId: '00000000-0000-4000-8000-000000000000', access: 'standard', worktree: '/w' };

test('codex resume: every exec option precedes `resume` (the resume subcommand does not accept --cd or --profile), prompt comes from stdin', () => {
  const argv = codex.command(cfg('supported'), job, true);
  const at = argv.indexOf('resume');
  assert.ok(at > 0);
  assert.equal(argv.at(-3), 'resume');
  assert.deepEqual(argv.slice(-3), ['resume', job.sessionId, '-']);
  for (const flag of ['--json', '--profile', '--cd']) assert.ok(argv.indexOf(flag) > -1 && argv.indexOf(flag) < at, flag);
});

test('resume is never offered without a session id or while the capability is unverified', () => {
  assert.ok(!codex.command(cfg('supported'), { ...job, sessionId: null }, true).includes('resume'));
  assert.ok(!codex.command(cfg('unverified'), job, true).includes('resume'));
  assert.ok(!codex.command(cfg('supported'), job, false).includes('resume'));
  assert.equal(codex.command(cfg('unverified'), job, true).at(-1), '-');
});

test('claude resume: `--resume <id>` is appended only for a supported capability, a session id and a resume request', { skip: !fs.existsSync('/mnt/cache/cursor-workspace/ai-rules-live/adapters/generated/claude/unraid/CLAUDE.md') && 'governance rule file absent on this host' }, () => {
  const c = (resume) => ({ command: ['claude'], manifest: { capabilities: { resume } }, arguments: [], resumeArguments: [] });
  const argv = claude.command(c('supported'), job, true);
  assert.deepEqual(argv.slice(-2), ['--resume', job.sessionId]);
  assert.ok(!claude.command(c('unverified'), job, true).includes('--resume'));
  assert.ok(!claude.command(c('supported'), { ...job, sessionId: null }, true).includes('--resume'));
  assert.ok(!claude.command(c('supported'), job, false).includes('--resume'));
});
