// Issue #1187: the work item format is documented once, linked from AGENTS.md and from the implement, fix and review prompts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validate } from '../tools/validate-project.mjs';
import { implementPrompt, fixPrompt, ciFixPrompt, reviewPrompt } from '../supervisor/team.mjs';
import { requirementsTableError } from '../supervisor/requirements-table.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const doc = fs.readFileSync(path.join(repo, 'docs/work-items.md'), 'utf8');

test('the document contains each rule the issue lists', () => {
  const required = [
    /## Acceptance items/, /before PR/, /after install/, /## Live checks/, /supervisor\/livechecks\.mjs/,
    /`Homeowner-only` is only for a credential, an approval or a physical act/, /one real data example/,
    /## The requirements table in the pull request/, /One row per acceptance item, and one row per carried follow-up/,
    /cites only lines the PR changes/, /Keep items small/, /another open item also changes/,
    /## How the post condition reads the table/, /supervisor\/requirements-table\.mjs/, /supervisor\/requirements-rows\.mjs/,
    /`Met`/, /`Homeowner-only`/, /`After install`/, /## Who follows what/
  ];
  for (const re of required) assert.match(doc, re);
});

test('the document names no agent', () => {
  assert.doesNotMatch(doc, /\b(claude|codex|opus|sonnet|gpt)\b/i);
});

test('the table rules in the document are the ones the post condition enforces', () => {
  const table = status => `## Requirements check\n| Requirement | Status | Evidence |\n|---|---|---|\n| a | ${status[0]} | ${status[1]} |\n`;
  assert.equal(requirementsTableError(table(['Met', 'f.mjs:1 and a test'])), null);
  assert.equal(requirementsTableError(table(['Homeowner-only', 'needs the homeowner approval'])), null);
  assert.equal(requirementsTableError(table(['After install', 'the overseer checks it'])), null);
  assert.match(requirementsTableError(table(['Homeowner-only', 'tired'])), /Homeowner-only/);
  assert.match(requirementsTableError(table(['After install', 'later'])), /who checks it/);
  assert.equal(requirementsTableError(table(['Not applicable', '#1148 is still open'])), null);
  assert.match(requirementsTableError(table(['Not applicable', 'skipped'])), /Not applicable/);
  const afterInstallRow = '| on Tower after install the page loads | Homeowner-only | needs homeowner approval |';
  assert.match(requirementsTableError(table(['Met', 'x']).replace(/\| a \|.*\n/, afterInstallRow + '\n')), /After install/);
  const doc = fs.readFileSync(path.join(repo, 'docs/work-items.md'), 'utf8');
  for (const word of ['Not applicable', 'still open', 'not merged', 'after install', 'after deploy', 'once installed']) assert.ok(doc.includes(word), word);
  assert.match(requirementsTableError(table(['Partial', 'x'])), /Allowed statuses/);
});

test('the implement, fix, CI fix and review prompts point at the document', () => {
  const pr = { pr: 10, head: 'a'.repeat(40), branch: 'b', repository: 'o/r', inbox: '/i' };
  for (const text of [implementPrompt({ issue: 5, branch: 'b' }), fixPrompt(pr), ciFixPrompt({ ...pr, checks: [] }), reviewPrompt(pr)]) {
    assert.match(text, /docs\/work-items\.md/);
  }
});

test('AGENTS.md links the document', () => {
  assert.match(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf8'), /\]\(docs\/work-items\.md\)/);
});

function copy(mutate) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'work-items-'));
  fs.cpSync(repo, dir, { recursive: true, verbatimSymlinks: true, filter: src => !['.git', 'node_modules'].includes(path.basename(src)) });
  try { mutate(dir); return validate(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('validate-project fails when the document is missing', () => {
  const findings = copy(dir => fs.rmSync(path.join(dir, 'docs/work-items.md')));
  assert.ok(findings.some(f => f.check === 'required-files' && f.message.includes('docs/work-items.md')), JSON.stringify(findings));
});

test('validate-project fails when AGENTS.md does not link the document', () => {
  const findings = copy(dir => {
    const file = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('(docs/work-items.md)', '(docs/other.md)'));
  });
  assert.ok(findings.some(f => f.check === 'work-items'), JSON.stringify(findings));
});

test('the Live checks line forms in the document are the forms livechecks.mjs reads (issue #1204)', async () => {
  const { parseLiveChecks } = await import('../supervisor/livechecks.mjs');
  assert.match(doc, /`GET`, `HEAD` or `POST`/);
  assert.match(doc, /`->` or `→`/);
  const body = '## Live checks\n- GET /a -> 200\n- HEAD /b → 204\n- POST /c -> 403 contains "no"\n- PUT /d -> 200\n';
  assert.deepEqual(parseLiveChecks(body).map(c => c.method), ['GET', 'HEAD', 'POST']);
});

test('the dependency format document says examples go in backticks (issue #1204)', () => {
  assert.match(fs.readFileSync(path.join(repo, 'docs/ai/dependency-format.md'), 'utf8'), /example of the syntax written in prose must go in backticks/);
});
