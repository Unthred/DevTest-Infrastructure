// Issue #1067: the size check, its parser heuristic and the ratchet, against real temporary trees.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { measureUnits, tokenize, measureFile } from '../tools/ci/size-scan.mjs';
import { compare } from '../tools/ci/size-ratchet.mjs';
import { reviewPrompt, fixPrompt, implementPrompt } from '../supervisor/team.mjs';
import { run } from '../tools/ci/check-size.mjs';

const CLI = new URL('../tools/ci/check-size.mjs', import.meta.url).pathname;
const REPO = new URL('..', import.meta.url).pathname;
// The check prints one row per warning; node's 1 MiB default buffer kills the child once that table grows past it (issue #1474).
const MAX_BUFFER = 64 * 1024 * 1024;
const DEFAULT_BUFFER = 1024 * 1024;
const TAIL_CHARS = 2000;

// Runs the size check as a child process; the message says why a run failed instead of printing the whole table.
function runCli(args, maxBuffer = MAX_BUFFER) {
  const r = spawnSync('node', [CLI, ...args], { encoding: 'utf8', maxBuffer });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  const why = r.status === null ? `no exit status, error ${r.error && r.error.code}` : `exit status ${r.status}`;
  return { status: r.status, output, message: `${why}; last ${TAIL_CHARS} characters of ${output.length}:\n${output.slice(-TAIL_CHARS)}` };
}

// A function of exactly `n` lines (header, n-2 statements, closing brace).
const fn = (name, n) => `function ${name}() {\n${'  step();\n'.repeat(n - 2)}}\n`;
// A file made of filler one-liners so it is over the 500-line file threshold.
const bigFile = body => `${'const a = 1;\n'.repeat(520)}${body}`;

function tree(t, files) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'size-1067-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

function check(root, ...args) {
  const lines = [];
  const code = run(['--root', root, ...args], l => lines.push(l));
  return { code, text: lines.join('\n') };
}

test('functions, methods, arrows and classes are measured with their lines and parameters', () => {
  const u = measureUnits(`class K {\n  m(a, b) {\n    x();\n  }\n}\nconst f = (a, b, c) => {\n  y();\n};\nfunction g({ a, b }, [c, d], e = 1,) {\n}\n`);
  const by = Object.fromEntries(u.map(x => [x.key, x]));
  assert.equal(by['class:K'].lines, 5);
  assert.equal(by['function:K>m'].lines, 3);
  assert.equal(by['function:K>m'].params, 2);
  assert.equal(by['function:K>m'].method, true);
  assert.equal(by['function:f'].params, 3);
  assert.equal(by['function:g'].params, 3, 'destructured parameters count once, a trailing comma is not a parameter');
});

test('strings, template literals with nested braces, comments and regexes do not confuse the brace matching', () => {
  const src = [
    'function a() {',
    '  const s = "}{"; const t = `x ${ {k: 1}.k } ${`in ${1}`} }`;',
    '  // } comment {',
    '  /* } */',
    '  return /[}]\\/{/.test(s) ? 1 : 2 / 3;',
    '}',
    'function b() {',
    '}',
  ].join('\n');
  const u = measureUnits(src);
  assert.deepEqual(u.map(x => [x.key, x.lines]), [['function:a', 6], ['function:b', 2]]);
});

test('a duplicate name gets an ordinal, and a nested function is qualified by its parent', () => {
  const keys = measureUnits('function a() {\n  const inner = () => {\n  };\n}\nfunction a() {\n}\n').map(x => x.key);
  assert.deepEqual(keys, ['function:a>inner', 'function:a', 'function:a#2']);
});

test('unbalanced and unterminated source is a parse error', () => {
  assert.throws(() => tokenize('function a() {'), /unclosed/);
  assert.throws(() => tokenize('}'), /unbalanced/);
  assert.throws(() => tokenize('const s = "abc\n'), /unterminated string/);
  assert.throws(() => tokenize('const t = `abc'), /unterminated template/);
  assert.throws(() => tokenize('/* open'), /unterminated comment/);
});

test('measureFile reports only units over their threshold, a long line and the file length', () => {
  const r = measureFile('a.mjs', `${fn('small', 50)}${fn('big', 51)}const x = '${'y'.repeat(170)}';\n`);
  const units = r.over.map(o => o.unit);
  assert.equal(units.length, 2);
  assert.ok(units.includes('a.mjs::function:big'));
  assert.ok(units.some(u => /^a\.mjs::long-line:/.test(u)));
  const many = measureFile('b.mjs', 'function p(a, b, c, d, e, f, g) {\n}\n');
  assert.equal(many.over[0].unit, 'b.mjs::function:p::params');
  assert.equal(measureFile('c.mjs', 'x;\n'.repeat(500)).over.length, 0);
  assert.equal(measureFile('c.mjs', 'x;\n'.repeat(501)).over[0].kind, 'file');
  assert.equal(measureFile('Counter.razor', 'x\n'.repeat(251)).over[0].threshold, 250);
});

test('a line over 160 characters is reported', t => {
  const root = tree(t, { 'a.mjs': `const x = '${'z'.repeat(200)}';\n` });
  const r = check(root);
  assert.equal(r.code, 0, 'a new long line in a healthy file is only a warning');
  assert.match(r.text, /a\.mjs::long-line:/);
  assert.match(r.text, /warning/);
});

test('a parse error fails and names the file', t => {
  const root = tree(t, { 'ok.mjs': 'x;\n', 'bad/broken.mjs': 'function f() {\n' });
  const r = check(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /bad\/broken\.mjs: parse error: unclosed/);
});

test('a baselined function that grows fails', t => {
  const root = tree(t, { 'a.mjs': bigFile(fn('long', 60)) });
  assert.equal(check(root, '--init-baseline').code, 0);
  fs.writeFileSync(path.join(root, 'a.mjs'), bigFile(fn('long', 61)));
  const r = check(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /a\.mjs::function:long .*\| 50 .*\| 60 .*\| 61 .*FAIL \(grew\)/);
});

test('a baselined function that shrinks passes and the smaller baseline is printed and can be written', t => {
  const root = tree(t, { 'a.mjs': bigFile(fn('long', 60)) });
  check(root, '--init-baseline');
  fs.writeFileSync(path.join(root, 'a.mjs'), bigFile(fn('long', 55)));
  const r = check(root);
  assert.equal(r.code, 0);
  assert.match(r.text, /smaller/);
  assert.match(r.text, /"a\.mjs::function:long": \{"kind":"function","threshold":50,"size":55\}/);
  assert.equal(check(root, '--update-baseline').code, 0);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'tools/ci/size-baseline.json'), 'utf8'));
  assert.equal(saved.units['a.mjs::function:long'].size, 55);
  fs.writeFileSync(path.join(root, 'a.mjs'), bigFile(fn('long', 56)));
  assert.equal(check(root).code, 1, 'after the baseline shrank, regrowing to the old size fails');
});

test('a function that drops under the threshold leaves the baseline', t => {
  const root = tree(t, { 'a.mjs': bigFile(fn('long', 60)) });
  check(root, '--init-baseline');
  fs.writeFileSync(path.join(root, 'a.mjs'), bigFile(fn('long', 10)));
  const r = check(root, '--update-baseline');
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'tools/ci/size-baseline.json'), 'utf8')).units['a.mjs::function:long'], undefined);
});

test('a new long function in a healthy file warns without failing', t => {
  const root = tree(t, { 'a.mjs': fn('ok', 10) });
  check(root, '--init-baseline');
  fs.writeFileSync(path.join(root, 'a.mjs'), fn('ok', 10) + fn('fresh', 70));
  const r = check(root);
  assert.equal(r.code, 0);
  assert.match(r.text, /warning/);
  assert.match(r.text, /a\.mjs::function:fresh/);
});

test('a new long function in a file already over the file threshold fails', t => {
  const root = tree(t, { 'a.mjs': bigFile(fn('ok', 10)) });
  check(root, '--init-baseline');
  fs.writeFileSync(path.join(root, 'a.mjs'), bigFile(fn('ok', 10) + fn('fresh', 70)));
  const r = check(root);
  assert.equal(r.code, 1);
  assert.match(r.text, /crossed a threshold in a file already over the file threshold/);
});

test('a baselined file that grows, and a baselined long line that gets longer, fail', t => {
  const root = tree(t, { 'a.mjs': bigFile(`const x = '${'z'.repeat(200)}';\n`) });
  check(root, '--init-baseline');
  fs.appendFileSync(path.join(root, 'a.mjs'), 'const b = 2;\n');
  assert.match(check(root).text, /a\.mjs::file .*FAIL/);
  fs.writeFileSync(path.join(root, 'a.mjs'), bigFile(`const x = '${'z'.repeat(250)}';\n`));
  assert.match(check(root).text, /a\.mjs::long-line:[0-9a-f]+ .*FAIL/);
});

test('compare is pure: unchanged sizes give no failures, warnings or shrinks', () => {
  const cur = [{ unit: 'a.mjs::file', kind: 'file', threshold: 500, size: 600, line: 1 }];
  const r = compare(cur, { units: { 'a.mjs::file': { kind: 'file', threshold: 500, size: 600 } } });
  assert.deepEqual([r.failures.length, r.warnings.length, r.shrinks.length], [0, 0, 0]);
});

test('test fixtures are not scanned', t => {
  const root = tree(t, { 'tests/fixtures/x/big.mjs': 'x;\n'.repeat(900), 'a.mjs': 'x;\n' });
  assert.match(check(root).text, /no unit grew/);
});

test('the CLI exits 1 on a failure and 2 on a bad argument', t => {
  const root = tree(t, { 'a.mjs': bigFile(fn('long', 60)) });
  runCli(['--root', root, '--init-baseline']);
  fs.writeFileSync(path.join(root, 'a.mjs'), bigFile(fn('long', 70)));
  assert.equal(runCli(['--root', root]).status, 1);
  const bad = runCli(['--nope']);
  assert.equal(bad.status, 2);
  assert.match(bad.message, /exit status 2; last \d+ characters of \d+:\n[\s\S]*\S/, 'the message shows the end of the output');
});

test('a check that prints more than the default buffer still gives its exit status (issue #1474)', t => {
  const files = {};
  for (let f = 0; f < 70; f += 1) {
    files[`many/f${f}.mjs`] = Array.from({ length: 100 }, (_, i) => `const v${f}_${i} = '${'z'.repeat(200)}';\n`).join('');
  }
  const r = runCli(['--root', tree(t, files)]);
  assert.equal(r.status, 0, r.message);
  assert.ok(r.output.length > DEFAULT_BUFFER, `the tree must print more than ${DEFAULT_BUFFER} characters, got ${r.output.length}`);
});

test('without the larger buffer the same run has no exit status and the message names the error code', t => {
  const files = { 'a.mjs': Array.from({ length: 4000 }, (_, i) => `const v${i} = '${'z'.repeat(200)}';\n`).join('') };
  const r = runCli(['--root', tree(t, files)], 1024);
  assert.equal(r.status, null);
  assert.match(r.message, /no exit status, error ENOBUFS/);
});

test('a new long line in a healthy file that already has long lines warns without failing', t => {
  const old = `const old = '${'z'.repeat(200)}';\n`;
  const root = tree(t, { 'a.mjs': old });
  check(root, '--init-baseline');
  fs.writeFileSync(path.join(root, 'a.mjs'), `${old}const fresh = '${'q'.repeat(300)}';\n`);
  const r = check(root);
  assert.equal(r.code, 0, r.text);
  assert.match(r.text, /warning/);
});

test('growth of a baselined long line fails even when another long line is removed or shortened', t => {
  const long = (name, n) => `const ${name} = '${'z'.repeat(n)}';\n`;
  const root = tree(t, { 'a.mjs': long('first', 300) + long('second', 200) });
  check(root, '--init-baseline');
  fs.writeFileSync(path.join(root, 'a.mjs'), long('second', 240));
  assert.equal(check(root).code, 1, 'removing one line must not pay for lengthening another');
  fs.writeFileSync(path.join(root, 'a.mjs'), long('first', 260) + long('second', 240));
  assert.match(check(root).text, /second|long-line/);
  assert.equal(check(root).code, 1);
});

test('deleting a line that shares its start with another long line does not fail as growth', t => {
  const same = n => `const dup = '${'z'.repeat(n)}';\n`;
  const root = tree(t, { 'a.mjs': same(200) + same(260) });
  check(root, '--init-baseline');
  fs.writeFileSync(path.join(root, 'a.mjs'), same(260));
  assert.equal(check(root).code, 0, check(root).text);
});

test('renaming the start of a long line in a file over the file threshold, without growth, passes', t => {
  const long = (name, n) => `const ${name} = '${'z'.repeat(n)}';\n`;
  const root = tree(t, { 'a.mjs': bigFile(long('first', 200)) });
  check(root, '--init-baseline');
  fs.writeFileSync(path.join(root, 'a.mjs'), bigFile(long('rename', 199)));
  assert.equal(check(root).code, 0, check(root).text);
  check(root, '--update-baseline');
  assert.equal(check(root).code, 0);
});

test('the table is printed even when no unit changed', t => {
  const root = tree(t, { 'a.mjs': bigFile('') });
  check(root, '--init-baseline');
  const r = check(root);
  assert.match(r.text, /unit\s+\| threshold \| before \| after/);
  assert.match(r.text, /a\.mjs::file .*unchanged/);
});

test('the committed baseline passes on this repository and stays at or below the measured figures', () => {
  const r = runCli(['--root', REPO]);
  assert.equal(r.status, 0, r.message);
  const base = JSON.parse(fs.readFileSync(path.join(REPO, 'tools/ci/size-baseline.json'), 'utf8'));
  // Upper bounds, so a committed shrink stays green. Measured on main 4312c5c (issue #1067): team.mjs 3652 lines, 155 methods,
  // 244 lines over 200 characters and 42 over 400; dashrender.mjs 1039 lines, 55 over 400. The bounds below add the merges since.
  const team = base.files['supervisor/team.mjs'];
  assert.ok(team.lines <= 3850 && team.methods <= 170 && team.linesOver200 <= 264 && team.linesOver400 <= 43, JSON.stringify(team));
  assert.ok(team.lines >= 1000, 'the baseline records team.mjs');
  const dash = base.files['supervisor/dashrender.mjs'];
  assert.ok(dash.lines <= 1044 && dash.linesOver400 <= 57, JSON.stringify(dash));
});

test('the review prompt names the new blocking class and the fix and implement prompts name the check', () => {
  const review = reviewPrompt({ pr: 10, head: 'a'.repeat(40), branch: 'b', repository: 'o/r', inbox: '/i' });
  assert.match(review, /scope violation, new architectural deterioration in the changed code \(docs\/coding-standards\.md/);
  assert.match(review, /pre-existing debt the change did not worsen is a follow-up/);
  const step = /node tools\/ci\/check-size\.mjs and follow docs\/coding-standards\.md/;
  assert.match(fixPrompt({ pr: 10, head: 'a'.repeat(40), branch: 'b' }), step);
  assert.match(implementPrompt({ issue: 5, branch: 'b' }), step);
  const agents = fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8');
  assert.ok(agents.includes('## Coding standards (full text: docs/coding-standards.md)\nWrite code another developer'));
});
