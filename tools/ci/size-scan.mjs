// Issue #1067: measure functions, classes, files and lines of JavaScript source without a parser dependency.
// This is a documented heuristic, not a full parser: it tokenises (strings, template literals, comments, regex literals), matches braces
// and classifies each "{" from the tokens before it. Arrow functions with an expression body have no braces and are not measured as
// functions (the line-length check still sees them). Any unbalanced or unterminated construct raises an error that names the file.

import { createHash } from 'node:crypto';

export const THRESHOLDS = { function: 50, class: 400, file: 500, razor: 250, params: 6, line: 160 };

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'await']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);
const WORD = /[A-Za-z0-9_$]/;

// Turn source text into tokens: { t: 'id' | 'num' | 'str' | 'regex' | 'p', v, line }.
export function tokenize(src) {
  const tokens = [];
  const braces = [];            // 'b' for a block brace, 't' for a template ${ opened inside a template literal
  let i = 0;
  let line = 1;
  const fail = what => { throw new Error(`${what} at line ${line}`); };
  const push = (t, v, at = line) => tokens.push({ t, v, line: at });
  const prevSignificant = () => tokens[tokens.length - 1];

  function readQuoted(q) {
    const at = line;
    i++;
    while (i < src.length && src[i] !== q) {
      if (src[i] === '\\') i++;
      if (src[i] === '\n') fail('unterminated string');
      i++;
    }
    if (i >= src.length) fail('unterminated string');
    i++;
    push('str', q, at);
  }

  // Read template text up to the closing backtick or the next ${ ; returns true when a ${ opened.
  function readTemplate() {
    const at = line;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '\n') line++;
      if (c === '`') { i++; push('str', '`', at); return false; }
      if (c === '$' && src[i + 1] === '{') { i += 2; braces.push('t'); push('str', '`', at); return true; }
      i++;
    }
    return fail('unterminated template literal');
  }

  function regexAllowed() {
    const p = prevSignificant();
    if (!p) return true;
    if (p.t === 'num' || p.t === 'str' || p.t === 'regex') return false;
    if (p.t === 'id') return REGEX_AFTER_WORD.has(p.v);
    return !(p.v === ')' || p.v === ']');
  }

  function readRegex() {
    const start = i;
    i++;
    let inClass = false;
    while (i < src.length && src[i] !== '\n') {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) {
        i++;
        while (i < src.length && /[a-z]/.test(src[i])) i++;
        push('regex', '/');
        return true;
      }
      i++;
    }
    i = start;
    return false;
  }

  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#' && i === 0 && src[1] === '!') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) fail('unterminated comment');
      for (let k = i; k < end; k++) if (src[k] === '\n') line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") { readQuoted(c); continue; }
    if (c === '`') { i++; readTemplate(); continue; }
    if (c === '/' && regexAllowed() && readRegex()) continue;
    if (WORD.test(c)) {
      const start = i;
      while (i < src.length && WORD.test(src[i])) i++;
      const v = src.slice(start, i);
      push(/^[0-9]/.test(v) ? 'num' : 'id', v);
      continue;
    }
    if (c === '=' && src[i + 1] === '>') { push('p', '=>'); i += 2; continue; }
    if (c === '{') braces.push('b');
    if (c === '}') {
      const kind = braces.pop();
      if (kind === undefined) fail('unbalanced "}"');
      if (kind === 't') { i++; readTemplate(); continue; }
    }
    push('p', c);
    i++;
  }
  if (braces.length) fail('unclosed "{"');
  return tokens;
}

// Index of the "(" that matches the ")" at tokens[close], or -1.
function matchingOpen(tokens, close) {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const v = tokens[k].t === 'p' ? tokens[k].v : '';
    if (v === ')' || v === ']' || v === '}') depth++;
    else if (v === '(' || v === '[' || v === '{') { depth--; if (depth === 0) return v === '(' ? k : -1; }
  }
  return -1;
}

// Count parameters between tokens[open] "(" and tokens[close] ")" at nesting depth one.
function countParams(tokens, open, close) {
  if (close === open + 1) return 0;
  let depth = 0;
  let commas = 0;
  let lastWasComma = false;
  for (let k = open + 1; k < close; k++) {
    const t = tokens[k];
    const v = t.t === 'p' ? t.v : '';
    if ('([{'.includes(v) && v) depth++;
    else if (')]}'.includes(v) && v) depth--;
    else if (v === ',' && depth === 0) { commas++; lastWasComma = true; continue; }
    lastWasComma = false;
  }
  return commas + 1 - (lastWasComma ? 1 : 0);
}

const isP = (t, v) => t && t.t === 'p' && t.v === v;

// Name an arrow or anonymous function from what it is assigned to: `const name = ...` or `name: ...`.
function assignedName(tokens, startIdx) {
  const before = tokens[startIdx - 1];
  const named = tokens[startIdx - 2];
  if (before && (isP(before, '=') || isP(before, ':')) && named && (named.t === 'id' || named.t === 'str')) return named.v;
  return null;
}

// Classify the "{" at tokens[k]: { kind: 'function', name, params, startLine } | { kind: 'class', name, startLine } | { kind: 'block' }.
function classify(tokens, k) {
  const prev = tokens[k - 1];
  if (!prev) return { kind: 'block' };
  if (isP(prev, ')')) {
    const open = matchingOpen(tokens, k - 1);
    if (open < 1) return { kind: 'block' };
    const word = tokens[open - 1];
    const params = countParams(tokens, open, k - 1);
    if (word.t === 'id' && CONTROL.has(word.v)) return { kind: 'block' };
    if (word.t === 'id' && word.v === 'function') {
      return { kind: 'function', name: assignedName(tokens, open - 1) || '<anonymous>', params, startLine: word.line };
    }
    if (isP(word, '*') && tokens[open - 2]?.v === 'function') return { kind: 'function', name: '<generator>', params, startLine: tokens[open - 2].line };
    if (word.t === 'id') {
      const fn = tokens[open - 2];
      if (fn && fn.t === 'id' && fn.v === 'function') return { kind: 'function', name: word.v, params, startLine: fn.line };
      return { kind: 'function', name: word.v, params, startLine: word.line };
    }
    return { kind: 'block' };
  }
  if (isP(prev, '=>')) {
    const before = tokens[k - 2];
    let start = k - 2;
    let params = 1;
    if (isP(before, ')')) { start = matchingOpen(tokens, k - 2); params = start < 0 ? 0 : countParams(tokens, start, k - 2); }
    if (start < 0) return { kind: 'block' };
    const label = assignedName(tokens, start - (tokens[start - 1]?.v === 'async' ? 1 : 0));
    return { kind: 'function', name: label || '<arrow>', params, startLine: tokens[label ? start - 2 : start].line };
  }
  for (let j = k - 1; j >= 0 && k - j < 40; j--) {
    const t = tokens[j];
    if (t.t === 'p' && ';{}'.includes(t.v)) break;
    if (t.t === 'id' && t.v === 'class') {
      const next = tokens[j + 1];
      return { kind: 'class', name: next?.t === 'id' && next.v !== 'extends' ? next.v : '<class>', startLine: t.line };
    }
  }
  return { kind: 'block' };
}

// Every brace-bodied function and class in the source, with lines, parameters and a stable qualified key.
export function measureUnits(src) {
  const tokens = tokenize(src);
  const stack = [];
  const units = [];
  const seen = new Map();
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (t.t !== 'p') continue;
    if (t.v === '{') {
      const info = classify(tokens, k);
      const scope = stack.filter(s => s.name).map(s => s.name);
      stack.push({ ...info, name: info.kind === 'block' ? null : info.name, scope, open: k });
    } else if (t.v === '}') {
      const top = stack.pop();
      if (!top || top.kind === 'block') continue;
      const base = [...top.scope, top.name].join('>');
      const key = `${top.kind}:${base}`;
      const n = (seen.get(key) || 0) + 1;
      seen.set(key, n);
      const parent = stack.filter(s => s.kind !== 'block').pop();
      units.push({
        kind: top.kind,
        key: n > 1 ? `${key}#${n}` : key,
        lines: t.line - top.startLine + 1,
        params: top.params ?? 0,
        startLine: top.startLine,
        method: top.kind === 'function' && parent?.kind === 'class',
      });
    }
  }
  return units;
}

// File-level lines: wc -l semantics (a final line without a newline still counts).
export function countLines(text) {
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

export function longLines(text, limit = THRESHOLDS.line) {
  const out = [];
  text.split('\n').forEach((l, idx) => { const len = l.replace(/\r$/, '').length; if (len > limit) out.push({ line: idx + 1, length: len }); });
  return out;
}

// One unit per long line, keyed by the start of its text so a line keeps its identity when other lines move or change.
// A line whose start is edited is a new unit; a repeated start gets an ordinal.
function longLineKeys(text, long) {
  const rows = text.split('\n');
  const seen = new Map();
  return long.map(l => {
    const start = rows[l.line - 1].trim().slice(0, 60);
    const hash = createHash('sha1').update(start).digest('hex').slice(0, 8);
    const n = (seen.get(hash) || 0) + 1;
    seen.set(hash, n);
    return { key: `long-line:${hash}${n > 1 ? `#${n}` : ''}`, length: l.length, line: l.line };
  });
}

// All measurements for one file as a flat list of units over their threshold, plus per-file stats.
export function measureFile(name, text) {
  const isJs = /\.(mjs|js|cjs)$/.test(name);
  const lines = countLines(text);
  const long = longLines(text);
  const over = [];
  const fileLimit = name.endsWith('.razor') ? THRESHOLDS.razor : THRESHOLDS.file;
  if (lines > fileLimit) over.push({ unit: `${name}::file`, kind: 'file', threshold: fileLimit, size: lines, line: 1 });
  for (const l of longLineKeys(text, long)) {
    over.push({ unit: `${name}::${l.key}`, kind: 'long-line', threshold: THRESHOLDS.line, size: l.length, line: l.line });
  }
  let methods = 0;
  if (isJs) {
    for (const u of measureUnits(text)) {
      if (u.method && u.lines > 1) methods++;   // one-line accessors are not counted
      const limit = u.kind === 'class' ? THRESHOLDS.class : THRESHOLDS.function;
      if (u.lines > limit) over.push({ unit: `${name}::${u.key}`, kind: u.kind, threshold: limit, size: u.lines, line: u.startLine });
      if (u.kind === 'function' && u.params > THRESHOLDS.params) {
        over.push({ unit: `${name}::${u.key}::params`, kind: 'params', threshold: THRESHOLDS.params, size: u.params, line: u.startLine });
      }
    }
  }
  const all = text.split('\n').map(l => l.replace(/\r$/, '').length);
  const stats = { lines, methods, linesOver200: all.filter(n => n > 200).length, linesOver400: all.filter(n => n > 400).length };
  return { over, stats };
}
