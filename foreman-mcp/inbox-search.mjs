// Pure Inbox search shared by the dashboard and Foreman MCP. Search terms are
// deliberately derived from human-visible fields, never from paths or hashes.

const punctuation = /[\p{P}\p{S}]+/gu;
const marks = /\p{M}/gu;
const word = /[\p{L}\p{N}]+/gu;

export function normaliseInboxText(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .toLocaleLowerCase('en-GB')
    .replace(marks, '')
    .replace(punctuation, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const inboxSearchTerms = query => normaliseInboxText(query).split(' ').filter(Boolean);

export function inboxSearchText(record = {}) {
  return [record.title, record.body, record.prompt, record.why, record.reason,
    record.kind, record.state, record.issue, record.pr, record.target,
    ...(Array.isArray(record.links) ? record.links : [])].join(' ');
}

export function matchesInboxSearch(record, query) {
  const terms = inboxSearchTerms(query);
  if (!terms.length) return true;
  const haystack = normaliseInboxText(inboxSearchText(record));
  return terms.every(term => haystack.includes(term));
}

export function highlightInboxText(value, query) {
  const terms = inboxSearchTerms(query);
  if (!terms.length) return [{ text: String(value ?? ''), matched: false }];
  const text = String(value ?? '');
  const parts = [];
  let cursor = 0;
  for (const match of text.matchAll(word)) {
    const start = match.index ?? 0;
    if (start > cursor) parts.push({ text: text.slice(cursor, start), matched: false });
    parts.push({ text: match[0], matched: terms.some(term => normaliseInboxText(match[0]).includes(term)) });
    cursor = start + match[0].length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), matched: false });
  return parts;
}
