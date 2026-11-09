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

const unitsOf = (name, src) => Object.fromEntries(measureCsharp(name, src).map(u => [u.key, u]));

test('a class with an attribute that takes arguments is measured as a class', () => {
  const src = `[Route("api/x")]\npublic class Big\n{\n    void M()\n    {\n${body(3)}    }\n}\n`;
  const by = unitsOf('Big.cs', src);
  assert.equal(by['class:Big'].lines, 10);
  assert.equal(by['function:Big>M'].lines, 6);
});

test('razor markup quotes and multi-line attribute values do not break the scan', () => {
  const src = `<div class="a\n  b" title='x "y'>it's</div>\n@code {\n    void Click()\n    {\n    }\n}\n<p>"</p>\n`;
  const units = measureCsharp('C.razor', src);
  assert.deepEqual(units.map(u => [u.key, u.startLine]), [['function:Click', 4]]);
});

test('interpolated raw strings are blanked', () => {
  const src = 'class A\n{\n    void M()\n    {\n        var s = $"""\n            {x} } "quoted" {\n            """;\n    }\n}\n';
  assert.equal(unitsOf('A.cs', src)['function:A>M'].lines, 6);
});

test('raw strings with four or more quote delimiters are blanked', () => {
  const src = 'class A\n{\n    void M()\n    {\n        var s = $"""" \n            {x} } """ inner\n            """";\n    }\n}\n';
  assert.equal(unitsOf('A.cs', src)['function:A>M'].lines, 6);
});

test('#if branches that each open a brace count only the first branch', () => {
  const src = 'class A\n{\n#if NET8\n    void M() {\n#else\n    void M(int a) {\n#endif\n        Step();\n    }\n}\n';
  const by = unitsOf('A.cs', src);
  assert.equal(by['function:A>M'].params, 0);
  assert.equal(by['class:A'].lines, 10);
});

test('constructor initialisers and generic constraints with nested parentheses keep the real name and parameters', () => {
  const src = 'class A\n{\n    A(int x, int y) : base(f(x), g(y))\n    {\n    }\n    void G<T>(T a) where T : new()\n    {\n    }\n}\n';
  const by = unitsOf('A.cs', src);
  assert.equal(by['function:A>A'].params, 2);
  assert.equal(by['function:A>G'].params, 1);
  assert.equal(by['function:A>base'], undefined);
  assert.equal(by['function:A>new'], undefined);
});
