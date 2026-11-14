// Issue #1372: the credential-shaped rules of the Inbox, each with a short stable name and one sentence on how to reword for it, and the
// refusal reasons built from them. A reason names the field, the rule and the line; it never contains a character of the matched text.
import { KEY, maskingRuleIn } from './redact.mjs';

// Text that looks like a credential. Matching is on the raw text, so it cannot be hidden by a case change. The list is deliberately broad:
// a refused item costs the overseer one rewrite. The last rule (the long unbroken run) is the only one not applied to saved file content.
export const SECRET_RULES = [
  {
    name: 'private key block',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    advice: 'Remove the key block and say only that a key is involved.',
  },
  {
    name: 'service key prefix',
    re: /\b(?:gh[pousr]_|github_pat_|sk-|xox[abprs]-)[A-Za-z0-9_-]{8,}/,
    advice: 'Name the service instead of writing the key, or cut the run after the prefix.',
  },
  {
    name: 'cloud key prefix',
    re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[A-Z0-9]{16}\b/,
    advice: 'Say which cloud account is meant instead of writing the key id.',
  },
  {
    name: 'web token',
    re: /\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/,
    advice: 'Describe the token (what issued it, what it is for) without writing it.',
  },
  {
    name: 'vault token prefix',
    re: /\bhv[sbr]\.[\w-]{8,}/,
    advice: 'Name the vault path instead of writing the token.',
  },
  {
    name: 'bearer scheme',
    re: /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]{12,}/i,
    advice: 'Say that the request is authenticated; leave out the scheme word and what follows it.',
  },
  {
    name: 'address with password',
    re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/i,
    advice: 'Write the address without its user and secret part.',
  },
  {
    name: 'word then separator',
    re: new RegExp(`\\b${KEY}["']?\\s*[:=]\\s*["']?(?!\\[)[^\\s"',;&]{6,}`, 'i'),
    advice: 'Use a different word, or reword so no colon or equals sign comes right after that word.',
  },
  {
    name: 'long unbroken run',
    re: /\b(?![0-9a-f]{40}\b)(?![0-9a-f]{64}\b)[A-Za-z0-9_-]{40,}\b/,
    advice: 'Shorten or break the long unbroken run of letters and digits, or describe it in words.',
  },
];

// The advice for a masking rule (the names are those of MASK_RULES in redact.mjs).
export const MASK_ADVICE = {
  'e-mail address': 'Say which mailbox or person is meant without writing the address.',
  'address with user part': 'Write the address without the part before the at sign.',
  'word then separator': 'Use a different word, or reword so no colon or equals sign comes right after that word.',
  'quoted key and value': 'Describe the setting in words instead of quoting its key and value.',
  'long unbroken run': 'Shorten the long unbroken run of letters and digits, or describe it in words.',
  'web token': 'Describe the token (what issued it, what it is for) without writing it.',
  'cloud key prefix': 'Say which cloud account is meant instead of writing the key id.',
  'vault token prefix': 'Name the vault path instead of writing the token.',
  'service key prefix': 'Name the service instead of writing the key.',
  'bearer scheme': 'Say that the request is authenticated; leave out the scheme word and what follows it.',
};
const MASK_ADVICE_DEFAULT = 'Describe it in words without the literal value.';   // a line cut for length, which no named rule explains

// The text split into lines as the card flattens it (the card redacts each line on its own).
const flatLines = text => String(text ?? '').replace(/\r/g, '').replace(/\t/g, ' ').split('\n');

// { rule, line } for the first credential-shaped rule that matches the field, or null. Rules are tried in list order; for the rule found,
// the line is the one on which its match starts.
export function secretRuleIn(text) {
  const whole = String(text ?? '');
  const rule = SECRET_RULES.find(r => r.re.test(whole));
  if (!rule) return null;
  const at = whole.search(rule.re);
  return { rule, line: whole.slice(0, at).split('\n').length };
}

export const secretShaped = text => SECRET_RULES.some(r => r.re.test(String(text ?? '')));
// File content (a saved worktree) is scanned without the generic long-run rule, which flags ordinary content such as a lock file digest (issue #802).
const FILE_SECRET_RULES = SECRET_RULES.slice(0, -1);
export const secretShapedInFile = text => FILE_SECRET_RULES.some(r => r.re.test(String(text ?? '')));

// The reason for a field refused as credential shaped. The words "secret-shaped" are what the Inbox reasons table maps to its code.
export function secretShapedReason(field, text) {
  const hit = secretRuleIn(text);
  return `${field} contains secret-shaped text: rule "${hit.rule.name}" matched on line ${hit.line}. ${hit.rule.advice}`;
}

// The reason for a field the card would mask. The words "would mask" are what the Inbox reasons table maps to its code. The rule is found
// by the redactor itself, line by line (the card redacts each line on its own); a line the redactor changes only through a cut falls back to line 1.
export function maskedReason(field, text) {
  const lines = flatLines(text);
  const line = lines.findIndex(l => maskingRuleIn(l));
  const rule = maskingRuleIn(lines[line < 0 ? 0 : line]);
  const name = rule ? rule.name : 'long line';
  const advice = (rule && MASK_ADVICE[rule.name]) || MASK_ADVICE_DEFAULT;
  return `${field} contains text the dashboard would mask: rule "${name}" matched on line ${(line < 0 ? 0 : line) + 1}. ${advice}`;
}
