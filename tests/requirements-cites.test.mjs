import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { citeGateError } from '../supervisor/requirements-cite-gate.mjs';
import { citedPaths, parseCites, parseDiff, requirementsCiteProblems } from '../supervisor/requirements-cites.mjs';
import { issueAcceptanceItems } from '../supervisor/requirements-issue-items.mjs';
import { tablePostcondition } from '../supervisor/requirements-table.mjs';
import { createJob, drive, stateRoot } from '../supervisor/core.mjs';

const fixture = name => fs.readFileSync(new URL(`./fixtures/requirements-cites/${name}`, import.meta.url), 'utf8');
const DIFF = [
  'diff --git a/supervisor/new-thing.mjs b/supervisor/new-thing.mjs',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/supervisor/new-thing.mjs',
  '@@ -0,0 +1,20 @@',
  '+export const x = 1;',
  'diff --git a/supervisor/old.mjs b/supervisor/old.mjs',
  '--- a/supervisor/old.mjs',
  '+++ b/supervisor/old.mjs',
  '@@ -10,2 +10,3 @@',
  ' context',
  '+changed',
  'diff --git a/tests/new-thing.test.mjs b/tests/new-thing.test.mjs',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/tests/new-thing.test.mjs',
  '@@ -0,0 +1,3 @@',
  "+test('does the thing', () => {});",
  "+test('rejects the other thing', () => {});"
].join('\n');
const lines = n => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');
const headFiles = () => new Map([
  ['supervisor/new-thing.mjs', lines(20)],
  ['supervisor/old.mjs', lines(30)],
  ['supervisor/untouched.mjs', lines(30)],
  ['tools/validate-project.mjs', lines(30)],
  ['tests/new-thing.test.mjs', "test('does the thing', () => {});\ntest('rejects the other thing', () => {});\n\n"]
]);
const table = rows => `## Requirements check\n\n| Requirement | Status | Evidence |\n| --- | --- | --- |\n${rows.map(r => `| ${r.join(' | ')} |`).join('\n')}\n`;
const problems = (rows, extra = {}) => requirementsCiteProblems({ body: table(rows), diff: DIFF, headFiles: headFiles(), issueBody: '', ...extra });
const good = ['Does the thing', 'Met', '`supervisor/new-thing.mjs:3`; test `does the thing` in `tests/new-thing.test.mjs`; `node --test tests/new-thing.test.mjs`'];

test('a valid table passes', () => {
  assert.deepEqual(problems([good, ['Old change', 'Met', '`supervisor/old.mjs:11`; `node tools/validate-project.mjs`']]), []);
});

test('a cite to a file that is not in the PR head fails with row, cite and reason', () => {
  const found = problems([['Gone', 'Met', '`supervisor/missing.mjs:4`; `node --test`']]);
  assert.equal(found.length, 1);
  assert.equal(found[0].row, 'Gone');
  assert.match(found[0].reason, /does not exist in the pull request head/);
});

test('a cite to a line outside every changed hunk fails; a test file is exempt', () => {
  const found = problems([['Drifted', 'Met', '`supervisor/old.mjs:25`'], ['Untouched file', 'Met', '`supervisor/untouched.mjs:5`'], ['Test', 'Met', '`tests/new-thing.test.mjs:2`']]);
  assert.deepEqual(found.map(p => p.row), ['Drifted', 'Untouched file']);
  assert.match(found[0].reason, /outside every hunk/);
});

test('a bare line number continues the file before it', () => {
  assert.deepEqual(parseCites('`supervisor/old.mjs:11`, `:25`')[0].lines, [[11, 11], [25, 25]]);
  assert.equal(problems([['Two lines', 'Met', '`supervisor/old.mjs:11`, `:25`']]).length, 1);
});

test('a named test missing from the cited test file fails', () => {
  const found = problems([['Missing test', 'Met', 'test `does not exist anywhere` in `tests/new-thing.test.mjs`']]);
  assert.equal(found.length, 1);
  assert.match(found[0].reason, /named test does not appear/);
});

test('a command that is not an allowed verification command fails', () => {
  const found = problems([['Command', 'Met', '`supervisor/new-thing.mjs:2`; `gh pr view 1139 --json body`']]);
  assert.equal(found.length, 1);
  assert.match(found[0].reason, /not an allowed verification command/);
  assert.deepEqual(problems([['Slot', 'Met', '`/root/bin/ai-supervisor test-slot run -- node --test tests/new-thing.test.mjs`']]), []);
});

test('the row count must equal the issue acceptance items; a missing or extra row is named', () => {
  const issue = '## Wanted\n1. First thing\n2. Second thing\n3. Third thing\n\n## Tests\n- not counted\n';
  assert.equal(issueAcceptanceItems(issue).length, 3);
  const missing = problems([good, good], { issueBody: issue });
  assert.equal(missing.length, 1);
  assert.match(missing[0].reason, /3 acceptance items, the table has 2 rows; no row for "Third thing"/);
  const extra = problems([good, good, good, ['Surplus', 'Met', '`supervisor/old.mjs:11`']], { issueBody: issue });
  assert.equal(extra.length, 1);
  assert.equal(extra[0].row, 'Surplus');
  assert.deepEqual(problems([good, good, good], { issueBody: issue }), []);
});

test('a stated count of new modules, files or tests must match the diff', () => {
  const wrong = problems([['Code split', 'Met', 'Adds 3 new modules; `supervisor/new-thing.mjs:2`']]);
  assert.match(wrong[0].reason, /states 3 modules but the diff has 1/);
  assert.deepEqual(problems([['Code split', 'Met', 'Adds 1 new module and 2 new tests; `supervisor/new-thing.mjs:2`']]), []);
  assert.deepEqual(problems([["Files", "Met", "two new files; `supervisor/new-thing.mjs:2`"]]).map(p => p.cite), []);
});

test('real tables from PR 1139 and PR 1175 are read row by row', () => {
  const t1139 = fixture('pr1139.md');
  const paths = citedPaths(t1139);
  assert.ok(paths.includes('supervisor/homeownersteps.mjs'));
  assert.ok(paths.includes('tests/pass-speed.test.mjs'));
  const found = requirementsCiteProblems({ body: t1139, diff: '', headFiles: new Map(paths.map(p => [p, lines(400)])), issueBody: '' });
  assert.ok(found.some(p => /gh pr view/.test(p.cite) && /not an allowed verification command/.test(p.reason)));
  assert.ok(found.some(p => /outside every hunk/.test(p.reason)));
  const t1175 = fixture('pr1175.md');
  assert.ok(parseCites(t1175.split('\n')[3]).length === 0);
  assert.ok(citedPaths(t1175).includes('supervisor/inboxcause.mjs'));
  const missing = requirementsCiteProblems({ body: t1175, diff: '', headFiles: new Map(), issueBody: '' });
  assert.ok(missing.some(p => /does not exist/.test(p.reason)));
});

test('parseDiff reads new files and hunk ranges', () => {
  const files = parseDiff(DIFF);
  assert.equal(files.get('supervisor/new-thing.mjs').added, true);
  assert.deepEqual(files.get('supervisor/old.mjs').ranges, [[10, 12]]);
});

test('the gate reads the PR through plain data, and a read failure never blames the author', async () => {
  const body = table([['Gone', 'Met', '`supervisor/missing.mjs:4`']]);
  const gh = { pullDiff: async () => DIFF, fileAtRef: async () => null, getIssue: async () => ({ body: '' }) };
  const message = await citeGateError({ number: 5, headRefOid: 'a'.repeat(40) }, body, gh);
  assert.match(message, /row "Gone": supervisor\/missing\.mjs:4: .*does not exist/);
  assert.equal(await citeGateError({ number: 5, headRefOid: 'a'.repeat(40) }, body, { ...gh, pullDiff: async () => { throw new Error('x'); } }), null);
  assert.equal(await citeGateError({ number: 5 }, body, {}), null);
});

test('the post-condition marks a cite failure for repair; a clean table passes', async () => {
  const gh = { pullDiff: async () => DIFF, fileAtRef: async p => headFiles().get(p) ?? null };
  const pr = { number: 5, headRefOid: 'a'.repeat(40), isDraft: false };
  const job = { kind: 'implement' };
  const bad = table([['Gone', 'Met', '`supervisor/missing.mjs:4`']]);
  assert.equal(await tablePostcondition({}, job, pr, async () => bad, gh), false);
  assert.equal(job.citeRepair, true);
  assert.match(job.postconditionDetail, /does not exist/);
  const ok = { kind: 'implement' };
  assert.equal(await tablePostcondition({}, ok, pr, async () => table([good]), gh), true);
  assert.equal(ok.citeRepair, undefined);
});

test('a cite repair stays in the same job, is limited to 2, and is not a fix round', async t => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cite-repair-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync('git', ['-C', path.join(dir, 'repo'), ...a], { encoding: 'utf8' });
  fs.mkdirSync(path.join(dir, 'repo'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'a@b.invalid');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(dir, 'repo', 'r'), 'x');
  git('add', 'r');
  git('commit', '-qm', 'i');
  git('worktree', 'add', '-qb', 'claude/issue-23-x', path.join(dir, 'wt'));
  const manifest = { schema_version: 1, id: 'codex', display_name: 'p', adapter_version: '0.1.0', launch: { command: 'codex', args: [] }, access: { standard: [], full: ['--FULL'] },
    capabilities: { launch: 'supported', resume: 'unverified', session_status: 'unverified', usage_limit_detection: 'unverified', reset_time_parsing: 'unverified', checkpoint: 'supported', non_interactive: 'supported' },
    billing: { model: 'subscription', fallback_to_other_billing: false } };
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify(manifest));
  const registry = path.join(dir, 'reg.json');
  fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { codex: { adapter: 'codex', manifest: 'codex.json' } } }));
  let now = Date.parse('2026-10-30T10:00:00Z');
  const clock = { now: () => now, sleep: async ms => { now += ms; } };
  const root = stateRoot(path.join(dir, 'state'));
  const spec = { role: 'devtest', provider: 'codex', repository: path.join(dir, 'repo'), worktree: path.join(dir, 'wt'), issue: 23, scope: 's', allowed_actions: ['read'], prompt: 'p', autoRestart: true, postcondition: { kind: 'pr_opened' } };
  const job = await createJob(root, spec, registry, clock);
  let runs = 0;
  const check = async j => { j.postconditionDetail = 'cites wrong'; j.citeRepair = true; return false; };
  const result = await drive(root, job, registry, clock, async () => { runs++; return { code: 0 }; }, 6, check);
  assert.equal(result.status, 'blocked');
  assert.equal(runs, 3);
  assert.equal(result.citeRepairs, 2);
  assert.ok(!result.incompleteRetries);
  
});

test('a ## Requirements section counts as acceptance items, with Acceptance and Live checks', () => {
  const issue = '## Requirements\n1. One\n2. Two\n3. Three\n\n## Acceptance\n- Tests: a\n- On Tower after install: b\n\n## Live checks\n- GET /x -> 200\n';
  assert.equal(issueAcceptanceItems(issue).length, 6);
});

test('the mandated full-suite command is not read as a named test', () => {
  const full = ['Does the thing', 'Met', '`supervisor/new-thing.mjs:3`; test `does the thing` in `tests/new-thing.test.mjs`; `/root/bin/ai-supervisor test-slot run -- node --test "tests/**/*.test.mjs"`'];
  assert.deepEqual(problems([full]), []);
});
