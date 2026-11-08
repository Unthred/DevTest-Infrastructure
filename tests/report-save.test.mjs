// Issue #882: `ai-supervisor reports-dir` and `report-save`. The real CLI runs against a temporary reports folder and state root; the saved
// report is then listed and read by the real foreman_reports reader. Secret-shaped fixtures are assembled at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createReports, FINISHED_MARKER } from '../foreman-mcp/reports.mjs';
import { reportsDir, saveReport } from '../supervisor/reportsave.mjs';
import { validateTeamConfig, applyLocalOverride } from '../supervisor/team.mjs';

const cli = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'supervisor', 'cli.mjs');
const tmp = t => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rsave-'))); t.after(() => { fs.chmodSync(d, 0o700); fs.rmSync(d, { recursive: true, force: true }); }); return d; };
function run(args, { env = {}, input, state } = {}) {
  const e = { ...process.env, ...env }; delete e.AI_SUPERVISOR_REPORTS_DIR; Object.assign(e, env);
  return spawnSync(process.execPath, [cli, ...args, '--state-root', state], { env: e, input, encoding: 'utf8' });
}
const isRoot = process.getuid?.() === 0;

test('reports-dir prints the configured folder; report-save writes a report the reader lists and reads', t => {
  const base = tmp(t), dir = path.join(base, 'reports'), state = path.join(base, 'state'); fs.mkdirSync(dir); fs.mkdirSync(state, { mode: 0o700 });
  const env = { AI_SUPERVISOR_REPORTS_DIR: dir };
  const d = run(['reports-dir'], { env, state }); assert.equal(d.status, 0); assert.equal(d.stdout.trim(), dir);
  const s = run(['report-save', 'test.md', '-'], { env, state, input: '# Test\n\nAll fine.\n' });
  assert.equal(s.status, 0, s.stderr); assert.equal(s.stdout.trim(), path.join(dir, 'test.md'));
  const reports = createReports(dir);
  const listed = reports.list(); assert.deepEqual(listed.reports.map(r => [r.name, r.finished]), [['test.md', true]]);
  assert.match(reports.read('test.md', 5000), /STATUS: finished[\s\S]*All fine\./);
  assert.equal(fs.statSync(path.join(dir, 'test.md')).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(dir), ['test.md'], 'no temporary file is left behind');
});

test('report-save from a file, replacing an earlier report, adds the finished marker once', t => {
  const base = tmp(t), dir = path.join(base, 'r'); fs.mkdirSync(dir);
  const src = path.join(base, 'in.md'); fs.writeFileSync(src, `first\n\n${FINISHED_MARKER}\n`);
  saveReport(dir, 'a.md', fs.readFileSync(src, 'utf8'));
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8').split(FINISHED_MARKER).length, 2);
  saveReport(dir, 'a.md', 'second');
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), `second\n\n${FINISHED_MARKER}\n`);
  const state = path.join(base, 'st'); fs.mkdirSync(state, { mode: 0o700 });
  const r = run(['report-save', 'b.txt', src], { env: { AI_SUPERVISOR_REPORTS_DIR: dir }, state }); assert.equal(r.status, 0, r.stderr);
  assert.equal(createReports(dir).list().count, 2);
});

test('not configured: both commands exit non-zero with a plain reason', t => {
  const state = tmp(t);
  for (const args of [['reports-dir'], ['report-save', 'x.md', '-']]) {
    const r = run(args, { state, input: 'text' });
    assert.equal(r.status, 3); assert.match(r.stderr, /not configured/); assert.equal(r.stdout, '');
  }
});

test('configured through team.local.json reports_dir; relative or missing folders are refused', t => {
  const base = tmp(t), dir = path.join(base, 'r'), state = path.join(base, 's'); fs.mkdirSync(dir); fs.mkdirSync(state, { mode: 0o700 });
  fs.writeFileSync(path.join(state, 'team.local.json'), JSON.stringify({ reports_dir: dir }));
  const r = run(['reports-dir'], { state }); assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout.trim(), dir);
  assert.throws(() => reportsDir({ env: {}, configured: 'relative/dir' }), /absolute/);
  assert.throws(() => reportsDir({ env: {}, configured: path.join(base, 'gone') }), /does not exist/);
  const file = path.join(base, 'plain'); fs.writeFileSync(file, 'x');
  assert.throws(() => reportsDir({ env: {}, configured: file }), /not a directory/);
  assert.throws(() => applyLocalOverride({}, { reports_dir: 'rel' }), /absolute/);
  assert.throws(() => validateTeamConfig({ ...JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8')), reports_dir: 'rel' }), /reports_dir/);
});

test('not writable: refused with a plain reason and nothing written', { skip: isRoot && 'root bypasses directory modes' }, t => {
  const base = tmp(t), dir = path.join(base, 'r'), state = path.join(base, 's'); fs.mkdirSync(dir); fs.mkdirSync(state, { mode: 0o700 }); fs.chmodSync(dir, 0o550);
  const env = { AI_SUPERVISOR_REPORTS_DIR: dir };
  for (const args of [['reports-dir'], ['report-save', 'x.md', '-']]) {
    const r = run(args, { env, state, input: 'text' }); assert.equal(r.status, 3); assert.match(r.stderr, /not writable/);
  }
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('bad names are refused and nothing is written', t => {
  const base = tmp(t), dir = path.join(base, 'r'), state = path.join(base, 's'); fs.mkdirSync(dir); fs.mkdirSync(state, { mode: 0o700 });
  const env = { AI_SUPERVISOR_REPORTS_DIR: dir };
  for (const name of ['../x.md', '/etc/x.md', 'sub/x.md', '.hidden.md', 'x.sh', 'x', 'x.md/', `${'a'.repeat(81)}.md`, 'a b.md', '%2e%2e.md']) {
    const r = run(['report-save', name, '-'], { env, state, input: 'text' });
    assert.equal(r.status, 3, name); assert.match(r.stderr, /not a valid report name/, name);
  }
  assert.equal(run(['report-save'], { env, state, input: 'text' }).status, 3);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('secret-shaped text is refused without echoing it; plain text with the word token is fine', t => {
  const base = tmp(t), dir = path.join(base, 'r'), state = path.join(base, 's'); fs.mkdirSync(dir); fs.mkdirSync(state, { mode: 0o700 });
  const env = { AI_SUPERVISOR_REPORTS_DIR: dir };
  const secret = 'gh' + 'p_' + crypto.randomBytes(20).toString('hex');
  const bad = run(['report-save', 's.md', '-'], { env, state, input: `found ${secret} in a log\n` });
  assert.equal(bad.status, 3); assert.match(bad.stderr, /secret-shaped/); assert.ok(!bad.stderr.includes(secret) && !bad.stdout.includes(secret));
  assert.deepEqual(fs.readdirSync(dir), []);
  const pw = run(['report-save', 'p.md', '-'], { env, state, input: `${'pass' + 'word'}=${crypto.randomBytes(8).toString('hex')}\n` });
  assert.equal(pw.status, 3);
  assert.equal(run(['report-save', 'ok.md', '-'], { env, state, input: 'the token budget was fine\n' }).status, 0);
});

test('a report over the reader cap is refused; a symlink at the name is replaced, not followed', t => {
  const base = tmp(t), dir = path.join(base, 'r'); fs.mkdirSync(dir);
  assert.throws(() => saveReport(dir, 'big.md', 'x'.repeat(300 * 1024)), /larger than/);
  const victim = path.join(base, 'victim'); fs.writeFileSync(victim, 'keep');
  fs.symlinkSync(victim, path.join(dir, 'l.md'));
  saveReport(dir, 'l.md', 'hello');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  assert.ok(fs.lstatSync(path.join(dir, 'l.md')).isFile());
});

test('not writable, simulated so it also runs as root: the plain reason is given', t => {
  const dir = tmp(t), denied = Object.assign(new Error('denied'), { code: 'EACCES' });
  const fsApi = { ...fs, accessSync: () => { throw denied; } };
  assert.throws(() => reportsDir({ env: {}, configured: dir, fsApi }), /not writable by this user/);
});
