// Issue #1067: method, class and parameter measures for .cs and .razor files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureCsharp } from '../tools/ci/size-csharp.mjs';
import { measureFile } from '../tools/ci/size-scan.mjs';

const body = n => '        Step();\n'.repeat(n);

test('methods, classes and parameters are measured', () => {
  const src = `namespace N;\npublic class Svc\n{\n    public int Run(int a, Dictionary<string, int> b, string c = "x")\n    {\n${body(3)}    }\n    public int Value { get { return 1; } }\n}\n`;
  const by = Object.fromEntries(measureCsharp('Svc.cs', src).map(u => [u.key, u]));
  assert.equal(by['class:Svc'].lines, 10);
  assert.equal(by['function:Svc>Run'].lines, 6);
  assert.equal(by['function:Svc>Run'].params, 3);
  assert.equal(by['function:Svc>Run'].method, true);
  assert.equal(by['function:Svc>get'], undefined);
});

test('braces inside strings, chars and comments do not count', () => {
  const src = `class A\n{\n    void M()\n    {\n        var s = "}{ // not a comment";\n        var v = @"a ""}"" b";\n        var c = '{';\n        // }\n        /* } */\n    }\n}\n`;
  const by = Object.fromEntries(measureCsharp('A.cs', src).map(u => [u.key, u]));
  assert.equal(by['function:A>M'].lines, 8);
});

test('control blocks are not methods and a long method is reported over the threshold', () => {
  const src = `class A\n{\n    void Long()\n    {\n        if (x)\n        {\n${body(60)}        }\n    }\n}\n`;
  const { over } = measureFile('A.cs', src);
  assert.deepEqual(over.map(o => [o.unit, o.kind]), [['A.cs::function:A>Long', 'function']]);
});

test('too many parameters are reported', () => {
  const src = 'class A\n{\n    void M(int a, int b, int c, int d, int e, int f, int g)\n    {\n    }\n}\n';
  assert.deepEqual(measureFile('A.cs', src).over.map(o => [o.kind, o.size]), [['params', 7]]);
});

test('only the @code block of a razor file is measured, with file line numbers', () => {
  const src = `<p>don't {break} here</p>\n@code {\n    void Click()\n    {\n${body(52)}    }\n}\n`;
  const units = measureCsharp('C.razor', src);
  assert.equal(units.length, 1);
  assert.equal(units[0].startLine, 3);
  assert.equal(units[0].lines, 55);
});

test('an unterminated string names the problem', () => {
  assert.throws(() => measureCsharp('A.cs', 'class A { string s = "abc;\n}'), /unterminated string/);
});
