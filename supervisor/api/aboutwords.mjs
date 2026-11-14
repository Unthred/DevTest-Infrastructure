// Issue #1448: the plain wording and grouping of the changes shown by the About model. Pure functions of issue and pull request
// text; nothing here reads a file or the network. The model (models/about.mjs) joins them to the install records.
import { readTier } from '../tier.mjs';

export const MAX_TEXT = 300;
const SKIPPED_LINE = /^(#{1,6}\s|<!--|Tier\s*:|Prerequisites?\b|\*{0,2}Depends\s+on\*{0,2}\s*:)/i;
const LEADING_ITEM_NUMBER = /^\s*V2[\s-]*(?:item[\s-]*)?\d+[\s:.–—-]*/i;
// A code word closing a title is one capitalised word after a lower case one ("... gives the version Aboutfacts").
// A capitalised word after a capitalised word is a name ("Home Assistant") and stays.
const TRAILING_CODE_WORD = /^(.*\b[a-z][a-z0-9]*)\s+[A-Z][a-z0-9]+$/;

export const groupOf = tier => (tier === 0 ? 'fixed' : tier === 5 ? 'screens' : tier === 6 ? 'tidying' : 'improved');

export function cleanTitle(title) {
  let text = String(title ?? '').replace(LEADING_ITEM_NUMBER, '').replace(/\s+/g, ' ').trim();
  const trimmed = TRAILING_CODE_WORD.exec(text);
  if (trimmed) text = trimmed[1];
  return text.slice(0, MAX_TEXT);
}

// The first sentence of the first paragraph that is not a Tier line, a prerequisite line, a heading or a comment marker.
export function firstSentence(body) {
  const lines = String(body ?? '').split(/\r?\n/).map(l => l.trim());
  const start = lines.findIndex(l => l && !SKIPPED_LINE.test(l) && /[A-Za-z]/.test(l));
  if (start < 0) return '';
  const paragraph = [];
  for (const line of lines.slice(start)) {
    if (!line || SKIPPED_LINE.test(line)) break;
    paragraph.push(line);
  }
  const text = paragraph.join(' ');
  const end = /[.!?](?=\s|$)/.exec(text);
  return (end ? text.slice(0, end.index + 1) : text).slice(0, MAX_TEXT).trim();
}

// One change of an install. `pr` and `issue` are index items (or undefined when the index does not know them).
export function describeChange(number, pr, issue) {
  const text = firstSentence(issue?.body) || cleanTitle(issue?.title) || cleanTitle(pr?.title) || `Pull request ${number}`;
  const tier = readTier({ title: issue?.title || pr?.title || '', body: issue?.body ?? '' }).tier;
  return { text, group: groupOf(tier), pr: number, issue: issue?.number ?? null };
}
