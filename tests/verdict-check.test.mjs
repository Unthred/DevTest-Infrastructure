// Issue #1056: verdict-check and ingest share one validation path; mechanical repairs; the prompt asks for the check.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkVerdictFile, readInboxVerdict, repairVerdict, validateVerdict, reviewPrompt } from '../supervisor/team.mjs';

const HEAD = 'a1b2c3d4e5'.repeat(4);
const good = () => ({ pr: 7, headSha: HEAD, verdict: 'PASS', findings: [], commandsRun: ['node --test'] });
const expect = { pr: 7, head: HEAD, checklist: false };
const made = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'vc-')); made.push(d); return d; };
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });
const write = (obj) => { const d = tmp(); const f = path.join(d, 'verdict.json'); fs.writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj)); return f; };
const cli = (f, extra = []) => spawnSync(process.execPath, ['supervisor/cli.mjs', 'verdict-check', f, '--pr', '7', '--head', HEAD, ...extra], { encoding: 'utf8' });

test('a valid file passes and an invalid file fails naming the field', () => {
  assert.ok(checkVerdictFile(write(good()), expect).verdict);
  assert.match(checkVerdictFile(write({ ...good(), commandsRun: [] }), expect).error, /commandsRun/);
  assert.match(checkVerdictFile(write({ ...good(), verdict: 'MAYBE' }), expect).error, /verdict must be/);
  assert.match(checkVerdictFile(write({ ...good(), pr: 8 }), expect).error, /different PR/);
  assert.equal(checkVerdictFile(write('{nope'), expect).error, 'unreadable verdict file');
});

test('the CLI and the ingest read agree on a fixture set', () => {
  const fixtures = [good(), { ...good(), commandsRun: [] }, { ...good(), headSha: 'f'.repeat(40) }, { ...good(), extra: 1 }, { ...good(), headSha: HEAD.slice(0, 8) },
    { pr: 7, headSha: HEAD, verdict: 'PASS', findings: [], commandsRun: ['x'], requirement: [] }];
  for (const v of fixtures) {
    const f = write(v), copy = write(v);
    const c = cli(f);
    const ticket = 'e'.repeat(32), root = tmp();
    fs.mkdirSync(path.join(root, 'team', 'inbox', ticket), { recursive: true });
    fs.copyFileSync(copy, path.join(root, 'team', 'inbox', ticket, 'verdict.json'));
    const r = readInboxVerdict(root, ticket, expect);
    assert.equal(c.status === 0, !r.error, JSON.stringify(v));
    if (r.error) assert.ok(c.stderr.includes(r.error));
  }
});

test('verdict-check does not rewrite the file it checks', () => {
  const f = write({ ...good(), headSha: HEAD.slice(0, 8) });
  const before = fs.readFileSync(f, 'utf8');
  const r = checkVerdictFile(f, expect);
  assert.ok(r.verdict && r.repairs.length);
  assert.equal(fs.readFileSync(f, 'utf8'), before);
});

test('a short headSha is repaired by ingest, recorded, and keeps the original', () => {
  const ticket = 'd'.repeat(32), root = tmp(), dir = path.join(root, 'team', 'inbox', ticket);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ ...good(), headSha: HEAD.slice(0, 9).toUpperCase() }));
  const r = readInboxVerdict(root, ticket, expect);
  assert.equal(r.verdict.headSha, HEAD);
  assert.match(r.repairs[0], /headSha/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'verdict.json'), 'utf8')).headSha, HEAD);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'verdict.original.json'), 'utf8')).headSha, HEAD.slice(0, 9).toUpperCase());
  // a second read (ingest after the post-condition) still reports the repair
  assert.ok(readInboxVerdict(root, ticket, expect).repairs.length);
});

test('a field-name typo is repaired; ambiguous or wrong cases are not', () => {
  assert.ok(checkVerdictFile(write({ pr: 7, headSha: HEAD, verdict: 'PASS', findings: [], commandRun: ['x'] }), expect).repairs[0].includes('commandsRun'));
  assert.ok(checkVerdictFile(write({ pr: 7, headsha: HEAD, verdict: 'PASS', findings: [], commandsRun: ['x'] }), expect).repairs[0].includes('headSha'));
  // a headSha for a different head is never repaired
  assert.match(checkVerdictFile(write({ ...good(), headSha: 'deadbeef' }), expect).error, /different head/);
  // too short a prefix
  assert.match(checkVerdictFile(write({ ...good(), headSha: HEAD.slice(0, 5) }), expect).error, /different head/);
  // unknown field with no near match
  assert.match(checkVerdictFile(write({ ...good(), banana: 1 }), expect).error, /unknown field: banana$/);
  // the target field is already present: renaming would clobber it
  assert.match(checkVerdictFile(write({ ...good(), commandRun: ['y'] }), expect).error, /unknown field: commandRun$/);
  // a repair that does not make the file valid is not applied
  assert.match(checkVerdictFile(write({ pr: 7, headSha: HEAD, verdict: 'PASS', findings: [], commandRun: [] }), expect).error, /unknown field/);
});

test('repairVerdict never touches the verdict word or findings', () => {
  const v = { ...good(), verdict: 'pass' };
  assert.deepEqual(repairVerdict(v, expect).repairs, []);
  assert.match(validateVerdict(v, expect), /PASS or CHANGES/);
});

test('the CLI prints OK or the error and sets the exit code', () => {
  assert.equal(cli(write(good())).status, 0);
  const bad = cli(write({ ...good(), commandsRun: [] }));
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /commandsRun/);
  assert.notEqual(spawnSync(process.execPath, ['supervisor/cli.mjs', 'verdict-check'], { encoding: 'utf8' }).status, 0);
});

test('the review prompt requires running verdict-check', () => {
  const p = reviewPrompt({ pr: 7, head: HEAD, branch: 'b', repository: 'o/r', inbox: '/i', requirementsFile: '/i/req.md' });
  assert.match(p, /ai-supervisor verdict-check \/i\/verdict\.json --pr 7 --head a1b2c3d4e5/);
  assert.match(p, /--checklist/);
});

test('the CLI needs no state root: it works where the default one cannot be created (CI)', () => {
  const blocker = write('x');   // a regular file, so a state root beneath it can never be created
  const env = { ...process.env, AI_SUPERVISOR_STATE_ROOT: path.join(blocker, 'state') };
  const r = spawnSync(process.execPath, ['supervisor/cli.mjs', 'verdict-check', write(good()), '--pr', '7', '--head', HEAD], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
});

test('a full 40-character upper-case headSha is repaired', () => {
  const r = checkVerdictFile(write({ ...good(), headSha: HEAD.toUpperCase() }), expect);
  assert.equal(r.verdict?.headSha, HEAD);
  assert.match(r.repairs[0], /headSha/);
});

test('the repair write leaves no temporary file and the CLI and ingest agree with --checklist', () => {
  const ticket = 'e'.repeat(32), root = tmp(), dir = path.join(root, 'team', 'inbox', ticket);
  fs.mkdirSync(dir, { recursive: true });
  const full = { ...good(), requirements: [{ requirement: 'r', status: 'met', evidence: 'e' }], descriptionClaims: [{ claim: 'c', status: 'true', evidence: 'e' }] };
  fs.writeFileSync(path.join(dir, 'verdict.json'), JSON.stringify({ ...full, headSha: HEAD.slice(0, 8) }));
  const ex = { ...expect, checklist: true };
  assert.ok(readInboxVerdict(root, ticket, ex).verdict);
  assert.ok(!fs.existsSync(path.join(dir, 'verdict.json.tmp')));
  assert.equal(cli(path.join(dir, 'verdict.json'), ['--checklist']).status, 0);
  const noReq = write(good());   // a checklist is required: both refuse, with the same error
  assert.equal(cli(noReq, ['--checklist']).status, 1);
  assert.match(cli(noReq, ['--checklist']).stderr, new RegExp(checkVerdictFile(noReq, ex).error.slice(0, 20)));
});

test('the repair prompt lets the repair run use verdict-check', () => {
  assert.match(fs.readFileSync('supervisor/team.mjs', 'utf8'), /except \/root\/bin\/ai-supervisor verdict-check \$\{inbox\}\/verdict\.json/);
});

test('blocked-report counts blocked review jobs, tokens and repairs per day', async () => {
  const { blockedReport, renderBlockedReport } = await import('../supervisor/blocked-report.mjs');
  const t = s => Date.parse(s + 'T12:00:00Z');
  const jobs = [
    { kind: 'review', status: 'blocked', createdAt: t('2026-11-04'), usage: { inputTokens: 1000000, outputTokens: 500000 } },
    { kind: 'review', status: 'blocked', createdAt: t('2026-11-04'), usage: { inputTokens: 500000, outputTokens: 0 } },
    { kind: 'review', status: 'completed', createdAt: t('2026-11-05'), verdictRepairs: ['x'] },
    { kind: 'implement', status: 'blocked', createdAt: t('2026-11-05') },
  ];
  const rep = blockedReport(jobs, { from: t('2026-11-03'), to: t('2026-11-06') });
  assert.deepEqual(rep.days.map(d => [d.day, d.blocked, d.tokens, d.repaired]), [['2026-11-03', 0, 0, 0], ['2026-11-04', 2, 2000000, 0], ['2026-11-05', 0, 0, 1], ['2026-11-06', 0, 0, 0]]);
  assert.match(renderBlockedReport(rep), /\| 2026-11-04 \| 2 \| 2\.00M \| 0 \|/);
});
