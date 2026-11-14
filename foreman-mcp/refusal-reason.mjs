// Issue #1372: the reason foreman_propose gives at submit time for a field its own redactor would change. It names the field, the rule and the
// line on which the match starts, then one sentence on how to reword, and quotes no character of the text. Pure. This module imports nothing
// from supervisor/, so the rule names are those the Inbox uses for the same shapes (supervisor/inbox-refusal.mjs) and a test compares them.
import { RULES } from './redact.mjs';

// One entry per RULES entry, in the same order: the rule name and its rewording sentence.
export const RULE_NAMES = [
  { name: 'private key block', advice: 'Remove the key block and say only that a key is involved.' },
  { name: 'service key prefix', advice: 'Name the service instead of writing the key, or cut the run after the prefix.' },
  { name: 'service key prefix', advice: 'Name the service instead of writing the key, or cut the run after the prefix.' },
  { name: 'service key prefix', advice: 'Name the service instead of writing the key, or cut the run after the prefix.' },
  { name: 'cloud key prefix', advice: 'Say which cloud account is meant instead of writing the key id.' },
  { name: 'service key prefix', advice: 'Name the service instead of writing the key, or cut the run after the prefix.' },
  { name: 'bearer scheme', advice: 'Say that the request is authenticated; leave out the scheme word and what follows it.' },
  { name: 'address with password', advice: 'Write the address without its user and secret part.' },
  { name: 'word then separator', advice: 'Use a different word, or reword so no colon or equals sign comes right after that word.' },
  { name: 'word then separator', advice: 'Use a different word, or reword so no colon, equals sign or space comes right after that flag.' },
];

// { name, advice, line } for the first rule that changes the text, or null when none does.
export function ruleAndLine(text) {
  const whole = String(text ?? '');
  for (let i = 0; i < RULES.length; i++) {
    const re = new RegExp(RULES[i][0].source, RULES[i][0].flags.replace('g', ''));
    const at = whole.search(re);
    if (at >= 0) return { ...RULE_NAMES[i], line: whole.slice(0, at).split('\n').length };
  }
  return null;
}

export function secretShapedRefusal(field, text) {
  const hit = ruleAndLine(text);
  if (!hit) return `${field} contains secret-shaped text; remove it`;
  return `${field} contains secret-shaped text: rule "${hit.name}" matched on line ${hit.line}. ${hit.advice}`;
}
