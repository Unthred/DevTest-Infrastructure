// Issue #1414: the short reference people use for an Inbox card ("C142"), and with the issue number once the item is posted
// ("C142, issue #1411"). Pure; imports nothing, so the MCP server and the dashboard share one rule. The 32 character id stays the key.
const PLACEHOLDER_ISSUE = 900000000;   // supervisor/inbox.mjs placeholderIssue: ids at or above this are not real issues
const validNumber = value => Number.isSafeInteger(value) && value > 0;

export const referenceOf = number => (validNumber(number) ? `C${number}` : null);

export function referenceText(number, issue) {
  const reference = referenceOf(number);
  if (!reference) return null;
  return validNumber(issue) && issue < PLACEHOLDER_ISSUE ? `${reference}, issue #${issue}` : reference;
}

// "C142" or "c142" as the overseer types it; null for anything else.
export function numberFromReference(text) {
  const match = /^c(\d{1,9})$/i.exec(String(text ?? '').trim());
  return match ? Number(match[1]) : null;
}
