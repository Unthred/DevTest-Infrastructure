const LINE = /^[ \t]*(?:[-*][ \t]+)?\**depends[ \t]+on\**[ \t]*:\**[ \t]*(.*?)[ \t]*$/i;
const DECLARATION = /\bdepends[ \t]+on\b[ \t]*:/i;
const LIST = /^#\d+(?:[ \t]*,[ \t]*#\d+)*$/;
export const DEPENDS_ON_EXAMPLE = 'Depends on: #12, #15';

const withoutCode = body => String(body || '').replace(/```[\s\S]*?```/g, m => m.replace(/[^\n]/g, ' ')).replace(/`[^`\n]*`/g, m => ' '.repeat(m.length));
const hasOpenQuote = text => {
  let straight = false;
  let curly = 0;
  for (const character of text) {
    if (character === '"') straight = !straight;
    if (character === '“') curly++;
    if (character === '”') curly = Math.max(0, curly - 1);
  }
  return straight || curly > 0;
};
const quotedDeclaration = line => /^\s*>/.test(line) || hasOpenQuote(line.slice(0, line.search(DECLARATION)));
const declarations = body => withoutCode(body).split('\n').filter(line => DECLARATION.test(line) && !quotedDeclaration(line));

export function dependencyRefusal(parsed) {
  return `${parsed.malformed}; use exactly "${DEPENDS_ON_EXAMPLE}", or omit the line when there are no prerequisites`;
}

// { numbers, malformed, line }. No line means no prerequisites. Foreman holds ambiguity rather than inferring intent.
export function parseDependsOn(body, self = null) {
  const declared = declarations(body);
  const lines = declared.filter(line => LINE.test(line));
  if (!declared.length) return { numbers: [], malformed: null, line: null };
  if (lines.length > 1) return { numbers: [], malformed: 'more than one Depends on line', line: lines[0].trim() };
  if (!lines.length) return { numbers: [], malformed: 'the Depends on line must stand on its own line, not inside a sentence', line: declared[0].trim() };
  const line = lines[0].trim();
  const rest = (LINE.exec(lines[0])?.[1] ?? '').replace(/\*+$/, '').trim();
  if (!LIST.test(rest)) return { numbers: [], malformed: `the Depends on line must be a comma-separated list such as "${DEPENDS_ON_EXAMPLE}"`, line };
  const numbers = [...new Set([...rest.matchAll(/#(\d+)/g)].map(m => Number(m[1])))];
  if (!numbers.every(Number.isSafeInteger) || numbers.some(n => n < 1)) return { numbers: [], malformed: 'an issue number is out of range', line };
  if (self != null && numbers.includes(self)) return { numbers: [], malformed: 'an issue cannot depend on itself', line };
  return { numbers, malformed: null, line };
}
