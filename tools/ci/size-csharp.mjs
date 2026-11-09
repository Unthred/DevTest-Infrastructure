// Issue #1067: method, class and parameter measures for .cs and .razor files, with the same heuristic approach as size-scan.mjs.
// Comments, strings and character literals are blanked first (newlines kept), then braces are matched and each "{" is classified from the
// text since the previous ";", "{" or "}". Expression-bodied members (=>) have no braces and are not measured. In .razor files only the
// @code and @functions blocks are C#; the markup is skipped.

const TYPE_WORD = /\b(class|struct|record|interface)\s+([A-Za-z_]\w*)/;
const CHAR_LITERAL = /^'(\\[^']+|[^\\'])'/;
const NOT_METHOD = new Set(['if', 'for', 'foreach', 'while', 'switch', 'catch', 'using', 'lock', 'fixed', 'when', 'else', 'try', 'finally', 'do', 'unsafe', 'checked', 'unchecked']);

// Index just past the "#endif" line that closes the conditional whose "#else" or "#elif" line starts at `from`.
function endOfConditional(src, from) {
  let depth = 1;
  let i = from;
  while (i < src.length) {
    const eol = src.indexOf('\n', i);
    const stop = eol < 0 ? src.length : eol;
    const directive = /^\s*#\s*(if|endif)\b/.exec(src.slice(i, stop));
    if (directive) depth += directive[1] === 'if' ? 1 : -1;
    i = stop + 1;
    if (depth === 0) return Math.min(stop, src.length);
  }
  return src.length;
}

const RAW_OPEN = /\$*"{3,}/y;

// End of the preprocessor directive at `i`; an #else or #elif extends to the end of its conditional.
function directiveEnd(src, i) {
  const eol = src.indexOf('\n', i);
  const lineEnd = eol < 0 ? src.length : eol;
  const branch = /^#\s*(else|elif)\b/.test(src.slice(i, lineEnd));
  return branch ? endOfConditional(src, lineEnd + 1) : lineEnd;
}

// Replace comments, strings, char literals and preprocessor lines with spaces, keeping every newline so line numbers survive. Only the
// first branch of an #if is kept: the branches share their closing braces, so counting all of them would never balance. With
// untilBalanced the scan starts at an opening "{" and stops after its matching "}" (used for @code blocks inside razor markup).
function scan(src, from = 0, untilBalanced = false) {
  let out = '';
  let i = from;
  let depth = 0;
  const blank = s => s.replace(/[^\n]/g, ' ');
  const take = n => { out += blank(src.slice(i, i + n)); i += n; };
  while (i < src.length) {
    const rest = src.slice(i, i + 4);
    // The delimiter holds three or more quotes, so it is read from the source, not from the 4-character window.
    RAW_OPEN.lastIndex = i;
    const raw = RAW_OPEN.exec(src);
    if (src[i] === '#' && /^[ \t]*$/.test(src.slice(src.lastIndexOf('\n', i - 1) + 1, i))) {
      take(directiveEnd(src, i) - i);
    } else if (rest.startsWith('//')) {
      const end = src.indexOf('\n', i);
      take((end < 0 ? src.length : end) - i);
    } else if (rest.startsWith('/*')) {
      const end = src.indexOf('*/', i + 2);
      if (end < 0) throw new Error('unterminated comment');
      take(end + 2 - i);
    } else if (raw) {
      const quotes = raw[0].replace(/\$/g, '');
      const end = src.indexOf(quotes, i + raw[0].length);
      if (end < 0) throw new Error('unterminated raw string');
      take(end + quotes.length - i);
    } else if (/^(\$@|@\$|@)"/.test(rest)) {
      const start = src.indexOf('"', i) + 1;
      let j = start;
      while (j < src.length && !(src[j] === '"' && src[j + 1] !== '"')) j += src[j] === '"' ? 2 : 1;
      if (j >= src.length) throw new Error('unterminated string');
      take(j + 1 - i);
    } else if (src[i] === '"' || (src[i] === '$' && src[i + 1] === '"')) {
      let j = src.indexOf('"', i) + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\n') throw new Error('unterminated string');
        j += src[j] === '\\' ? 2 : 1;
      }
      if (j >= src.length) throw new Error('unterminated string');
      take(j + 1 - i);
    } else if (src[i] === "'" && CHAR_LITERAL.test(src.slice(i, i + 12))) {
      take(CHAR_LITERAL.exec(src.slice(i, i + 12))[0].length);
    } else {
      out += src[i];
      if (src[i] === '{') depth++;
      if (src[i] === '}') depth--;
      i++;
      if (untilBalanced && depth === 0) return { text: out, end: i };
    }
  }
  if (untilBalanced) throw new Error('unclosed @code block');
  return { text: out, end: i };
}

export function blankNonCode(src) {
  return scan(src).text;
}

function countParams(header) {
  const close = header.lastIndexOf(')');
  const open = matchingOpen(header, close);
  const inner = header.slice(open + 1, close);
  if (inner.trim() === '') return 0;
  let depth = 0;
  let commas = 0;
  for (const c of inner) {
    if ('(<[{'.includes(c)) depth++;
    else if (')>]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) commas++;
  }
  return commas + 1;
}

function matchingOpen(text, close) {
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    if (text[j] === ')') depth++;
    else if (text[j] === '(' && --depth === 0) return j;
  }
  return -1;
}

// Leading attribute lists such as [Route("api/x")] are not part of the declaration; their parentheses must not hide a class keyword.
function stripAttributes(header) {
  let h = header.trimStart();
  while (h.startsWith('[')) {
    let depth = 0;
    let j = 0;
    for (; j < h.length; j++) {
      if (h[j] === '[') depth++;
      else if (h[j] === ']' && --depth === 0) break;
    }
    if (depth !== 0) break;
    h = h.slice(j + 1).trimStart();
  }
  return h;
}

// "where T : new()" constraints and ": base(f(a), g(a))" initialisers follow the parameter list; cut them so the header ends at the ")".
function stripTrailers(header) {
  const constraint = /\bwhere\s+\w+\s*:/.exec(header);
  const h = (constraint ? header.slice(0, constraint.index) : header).trimEnd();
  const initialiser = /\s*:\s*(base|this)\s*\(/.exec(h);
  if (!initialiser) return h;
  const open = initialiser.index + initialiser[0].length - 1;
  let depth = 0;
  for (let j = open; j < h.length; j++) {
    if (h[j] === '(') depth++;
    else if (h[j] === ')' && --depth === 0) return j === h.length - 1 ? h.slice(0, initialiser.index).trimEnd() : h;
  }
  return h;
}

function classify(rawHeader) {
  const header = stripAttributes(rawHeader);
  const type = TYPE_WORD.exec(header);
  if (type && !header.slice(0, type.index).includes('(')) return { kind: 'class', name: type[2] };
  const h = stripTrailers(header);
  if (!h.endsWith(')')) return null;
  const open = matchingOpen(h, h.length - 1);
  const word = /([A-Za-z_]\w*)\s*(<[^()]*>)?\s*$/.exec(h.slice(0, open));
  if (!word || NOT_METHOD.has(word[1]) || /\bnew\s*$/.test(h.slice(0, word.index))) return null;
  return { kind: 'function', name: word[1], params: countParams(h) };
}

// Units for a blanked C# text. lineOffset shifts reported lines when the text is a slice of a larger file.
export function measureCsharpUnits(blanked, lineOffset = 0) {
  const stack = [];
  const units = [];
  const seen = new Map();
  let line = 1 + lineOffset;
  let headerStart = 0;
  let headerLine = line;
  for (let i = 0; i < blanked.length; i++) {
    const c = blanked[i];
    if (c === '\n') { line++; continue; }
    if (c === ';') { headerStart = i + 1; headerLine = line; continue; }
    if (c === '{') {
      const header = blanked.slice(headerStart, i).trim();
      const info = classify(header);
      const startLine = headerLine + (blanked.slice(headerStart, i).match(/^\s*/)[0].match(/\n/g)?.length ?? 0);
      stack.push(info ? { ...info, startLine, scope: stack.filter(s => s.name).map(s => s.name) } : { kind: 'block', name: null });
      headerStart = i + 1;
      headerLine = line;
    } else if (c === '}') {
      const top = stack.pop();
      if (top && top.kind !== 'block') {
        const key = `${top.kind}:${[...top.scope, top.name].join('>')}`;
        const n = (seen.get(key) || 0) + 1;
        seen.set(key, n);
        const parent = stack.filter(s => s.kind !== 'block').pop();
        units.push({ kind: top.kind, key: n > 1 ? `${key}#${n}` : key, lines: line - top.startLine + 1, params: top.params ?? 0, startLine: top.startLine, method: top.kind === 'function' && parent?.kind === 'class' });
      }
      headerStart = i + 1;
      headerLine = line;
    }
  }
  if (stack.length > 0) throw new Error('unclosed {');
  return units;
}

// Blocks of C# inside a .razor file: the body of every @code and @functions directive. Only those bodies are tokenised, because markup
// holds quotes and apostrophes that are not C# strings.
function razorBlocks(src) {
  const blocks = [];
  const directive = /@(code|functions)\s*\{/g;
  let m;
  while ((m = directive.exec(src))) {
    const open = m.index + m[0].length - 1;
    const { text, end } = scan(src, open, true);
    blocks.push({ text, lineOffset: src.slice(0, open).split('\n').length - 1 });
    directive.lastIndex = end;
  }
  return blocks;
}

export function measureCsharp(name, src) {
  if (!name.endsWith('.razor')) return measureCsharpUnits(blankNonCode(src));
  return razorBlocks(src).flatMap(b => measureCsharpUnits(b.text, b.lineOffset));
}
