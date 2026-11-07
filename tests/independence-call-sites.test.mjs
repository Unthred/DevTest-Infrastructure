// Issue #651 (follow-up to #591, hardened in #729): independenceRefusal is the one check for decisions about an actual review. The only
// code allowed to reference independentOf or writersOf is listed here, so a new use fails this test until it is reviewed and added.
//
// The scanner is a lint-style guard, not a parser. It blanks comments, strings and regex literals, then tracks brace nesting so the
// owner of a use is the outermost named function, class method (getter, setter, static, #private, field arrow, multi-line or
// default-valued parameters included) or const around it. A bare reference (import alias, stored method reference, bracket access
// with a literal name) counts as a use and needs the same listing. A computed name built at runtime (this[name]) is not detectable.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Each permitted owner carries the reason it may bypass independenceRefusal.
const PERMITTED = {
  independentOf: {
    independenceRefusal: 'the one check for decisions about an actual review',
    strandsReviewer: 'judges a hypothetical writer set (actual writers plus the one considered), not an actual review',
  },
  writersOf: {
    independenceRefusal: 'supplies the actual writers to the one check',
    strandsReviewer: 'builds the hypothetical writer set from the actual writers',
    unblockModels: 'lists hypothetical reviewer models that would be independent; it decides nothing about an actual review',
    writerUnknown: 'asks whether a writer model is unrecorded on a provider; a fact lookup, not an independence decision',
    secondOpinionOwed: 'asks whether the reviewer shares a writer provider to decide if an extra review is owed; the review itself still goes through independenceRefusal',
  },
};
const NAMES = Object.keys(PERMITTED);

// Replace comments, string contents and regex literals with spaces (newlines kept). A string that is exactly a watched name is kept
// so this['writersOf'] is still seen. Template literal text is blanked but ${ } expressions stay code.
export function blank(src) {
  let out = '', i = 0, last = '';
  const tpl = [];
  const keep = (s) => { out += s; const t = s.trim(); if (t) last = t.slice(-1); };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') { out += ' '; i++; } continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; out += src.slice(i, end).replace(/[^\n]/g, ' '); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      const body = src.slice(i + 1, j);
      out += NAMES.includes(body) ? ' ' + body + ' ' : src.slice(i, j + 1).replace(/[^\n]/g, ' ');
      i = j + 1; last = 'a'; continue;
    }
    if (c === '`') { // template text up to the next ${ or closing backtick
      let j = i + 1;
      while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j).replace(/[^\n]/g, ' ');
      if (src[j] === '$') { out += '  '; tpl.push(0); i = j + 2; last = '('; } else { out += ' '; i = j + 1; last = 'a'; }
      continue;
    }
    if (tpl.length && c === '{') { tpl[tpl.length - 1]++; keep(c); i++; continue; }
    if (tpl.length && c === '}') {
      if (tpl[tpl.length - 1] === 0) { // back into template text
        tpl.pop(); out += ' '; let j = i + 1;
        while (j < src.length && src[j] !== '`' && !(src[j] === '$' && src[j + 1] === '{')) j += src[j] === '\\' ? 2 : 1;
        out += src.slice(i + 1, j).replace(/[^\n]/g, ' ');
        if (src[j] === '$') { out += '  '; tpl.push(0); i = j + 2; last = '('; } else { out += ' '; i = j + 1; last = 'a'; }
        continue;
      }
      tpl[tpl.length - 1]--; keep(c); i++; continue;
    }
    if (c === '/' && (last === '' || '(,=:[!&|?{};+-*%<>~^'.includes(last) || /(?:^|[^\w$])(?:return|typeof|case)\s*$/.test(out.slice(-12)))) { // regex literal
      let j = i + 1, cls = false;
      while (j < src.length && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++; }
      j++; while (/[a-z]/.test(src[j] || '')) j++;
      out += src.slice(i, j).replace(/[^\n]/g, ' '); i = j; last = 'a'; continue;
    }
    keep(c); i++;
  }
  return out;
}

// The declared name of a block opened by header text h, given whether the enclosing block is a class body.
function nameOf(h, inClass) {
  h = h.trim();
  let m = /(?:^|[^\w$.])function\s*\*?\s*([\w$]+)/.exec(h);
  if (m) return { name: m[1] };
  m = /^(?:export\s+)?(?:default\s+)?class\s+([\w$]+)/.exec(h);
  if (m) return { name: m[1], cls: true };
  if (/\bclass\b[^(]*$/.test(h) && !inClass) return { name: '(class)', cls: true };
  m = /^(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=/.exec(h);
  if (m) return { name: m[1] };
  if (inClass) {
    m = /^(?:(?:static|async|get|set)\s+(?=[\w$#*[]))*\*?\s*(#?[\w$]+|\[[^\]]*\])\s*[(=]/.exec(h);
    if (m && !/^(?:if|for|while|switch|catch|return)$/.test(m[1])) return { name: m[1] };
    if (/^static\s*$/.test(h)) return { name: 'static{}' };
  }
  return null;
}

// Every use of independentOf or writersOf (call or bare reference, not a definition), with its owner and 1-based line.
export function callSites(src) {
  const code = blank(src), sites = [], stack = []; // frames: { name, cls }
  const lineAt = (p) => code.slice(0, p).split('\n').length;
  const headerBefore = (p) => { // text from the previous ; { } at paren depth 0 up to p
    let d = 0, k = p - 1;
    for (; k >= 0; k--) {
      const ch = code[k];
      if (ch === ')' || ch === ']') d++; else if (ch === '(' || ch === '[') d--;
      else if (d <= 0 && (ch === ';' || ch === '{' || ch === '}')) break;
    }
    return code.slice(k + 1, p);
  };
  const ownerOf = () => { for (const f of stack) if (f.name && !f.cls) return f.name; return '(module)'; };
  const re = new RegExp(`(?<![\\w$])(${NAMES.join('|')})(?![\\w$])|[{}]`, 'g');
  let m;
  while ((m = re.exec(code))) {
    if (m[0] === '{') { const inClass = stack.length > 0 && stack[stack.length - 1].cls; stack.push(nameOf(headerBefore(m.index), inClass) || {}); continue; }
    if (m[0] === '}') { stack.pop(); continue; }
    const fn = m[1], before = headerBefore(m.index).trim(), after = code.slice(m.index + fn.length);
    if (/(?:^|\s)(?:function\s*\*?|(?:const|let|var))$/.test(before)) continue; // function or const definition
    if (before === '' || /^(?:(?:static|async|get|set)(?:\s+|$))*\*?$/.test(before)) { // possible method definition: name(...) {
      let d = 0, k = m.index + fn.length, found = false;
      while (code[k] === ' ' || code[k] === '\n') k++;
      if (code[k] === '(') {
        for (; k < code.length; k++) { if (code[k] === '(') d++; else if (code[k] === ')' && --d === 0) { found = true; break; } }
        if (found && /^\s*\{/.test(code.slice(k + 1))) continue;
      }
    }
    sites.push({ fn, owner: ownerOf(), line: lineAt(m.index), call: /^\s*\(/.test(after) });
  }
  return sites;
}

const files = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? (e.name === 'node_modules' ? [] : files(path.join(dir, e.name))) : /\.(mjs|js)$/.test(e.name) ? [path.join(dir, e.name)] : []);

const permitted = (fn, owner) => Object.hasOwn(PERMITTED[fn], owner);

test('issue #651: only the permitted methods reference independentOf or writersOf', () => {
  const bad = [];
  for (const dir of ['supervisor', 'tools']) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const f of files(dir)) {
      for (const s of callSites(fs.readFileSync(path.join(root, f), 'utf8'))) {
        if (!permitted(s.fn, s.owner)) bad.push(`${f}:${s.line} ${s.owner} ${s.call ? 'calls' : 'references'} ${s.fn}`);
      }
    }
  }
  assert.deepEqual(bad, [], 'new references need review: use independenceRefusal for decisions about an actual review, or add the owner to PERMITTED with a reason');
});

test('issue #729: every permitted owner states a reason', () => {
  for (const [fn, owners] of Object.entries(PERMITTED)) {
    for (const [o, why] of Object.entries(owners)) assert.ok(typeof why === 'string' && why.length > 20, `${fn} owner ${o} needs a reason`);
  }
});

test('issue #651: the scanner sees the known call sites and rejects an unlisted one', () => {
  const real = callSites(fs.readFileSync(path.join(root, 'supervisor/team.mjs'), 'utf8'));
  for (const [fn, owners] of Object.entries(PERMITTED)) {
    for (const o of Object.keys(owners)) assert.ok(real.some(s => s.fn === fn && s.owner === o), `${o} should call ${fn}`);
  }
  const fake = callSites('export class T {\n  decideReview(pr) {\n    return independentOf({ provider: 1 }, this.writersOf(pr));\n  }\n}\n');
  assert.deepEqual(fake.map(s => [s.fn, s.owner]).sort(), [['independentOf', 'decideReview'], ['writersOf', 'decideReview']]);
  assert.ok(fake.every(s => !permitted(s.fn, s.owner)));
  // Definitions and comments are not uses.
  assert.deepEqual(callSites('export const independentOf = (a, b) => 1;\n  writersOf(pr) {\n    // independentOf(x) writersOf(y)\n  }\n'), []);
  assert.deepEqual(callSites('export function independentOf(a, b) { return 1; }\nclass T {\n  async writersOf(pr = f()) {\n    return "writersOf(x)";\n  }\n}\n'), []);
});

test('issue #729: method headers the old line regex missed are attributed correctly', () => {
  const owners = (src) => callSites(src).map(s => s.owner);
  // The probe from the review: the private method must not inherit strandsReviewer.
  assert.deepEqual(owners('class T {\n  strandsReviewer() {}\n  #priv(pr) { this.writersOf(pr) }\n}\n'), ['#priv']);
  for (const [name, head] of [
    ['getter', 'get g()'], ['setter', 'set s(v)'], ['static', 'static st(a)'], ['async generator', 'async *ag()'],
    ['default with parens', 'dp(now = this.clock.now(), f = () => true)'], ['multi-line params', 'ml(a,\n    b)'],
  ]) assert.deepEqual(owners(`class T {\n  strandsReviewer() {}\n  ${head} {\n    return this.writersOf(1);\n  }\n}\n`), [head.replace(/^(?:static |async |get |set )*\*?/, '').split('(')[0]], name);
  assert.deepEqual(owners('class T {\n  strandsReviewer() {}\n  fa = (pr) => this.writersOf(pr);\n  fb = (pr) => {\n    return this.writersOf(pr);\n  };\n}\n'), ['(module)', 'fb']); // a braceless field arrow has no frame, so it is unowned and fails closed
  assert.deepEqual(owners('class T {\n  constructor(a = f()) {\n    this.writersOf(a);\n  }\n}\n'), ['constructor']);
  // A nested block or callback keeps the enclosing method as owner.
  assert.deepEqual(owners('class T {\n  m(x) {\n    if (x) { return x.map(y => { return this.writersOf(y); }); }\n  }\n}\n'), ['m']);
  // Template expressions and regexes with quotes do not confuse the scanner.
  assert.deepEqual(owners('class T {\n  a() { return /\'/.test(`x${this.writersOf(1)}y`); }\n  b() { return "it\'s"; }\n}\n'), ['a']);
});

test('issue #729: indirect references are flagged', () => {
  const fns = (src) => callSites(src).map(s => s.fn);
  assert.deepEqual(fns("import { independentOf as io } from './team.mjs';\n"), ['independentOf']);
  assert.deepEqual(fns("class T {\n  m(pr) { return this['writersOf'](pr); }\n}\n"), ['writersOf']);
  assert.deepEqual(fns('class T {\n  m(pr) { const w = this.writersOf; return w.call(this, pr); }\n}\n'), ['writersOf']);
  assert.ok(callSites('class T {\n  m(pr) { const w = this.writersOf; }\n}\n').every(s => !s.call));
  // Mentions in unrelated strings and comments are not references.
  assert.deepEqual(fns('const s = "call writersOf later"; // writersOf\n'), []);
});
