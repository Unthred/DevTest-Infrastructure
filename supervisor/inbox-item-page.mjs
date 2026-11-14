// Issue #977: the small page of /inbox/<id> for an item that is not waiting. Issue #1414: it names the card by its reference.
import { referenceText } from '../foreman-mcp/inbox-reference.mjs';

const realIssue = value => (Number.isSafeInteger(value) && value > 0 && value < 900000000 ? value : null);

// `esc` escapes text for HTML; `s` is the item's status record.
export function inboxItemBody(s, esc) {
  const issue = realIssue(s.issue);
  const lines = [
    s.number ? `Reference: ${esc(referenceText(s.number, s.issue))}` : null,
    `Kind: ${esc(s.kind || 'unknown')}`,
    `State: ${esc(s.state || 'unknown')}`,
    s.title ? `Title: ${esc(String(s.title).slice(0, 200))}` : null,
    issue ? `GitHub issue: <a href="/work/issue/${issue}">#${issue}</a>` : null,
    s.reason ? `Reason: ${esc(String(s.reason).slice(0, 300))}` : null,
  ];
  return `<p><code>${esc(s.id)}</code></p><ul>${lines.filter(Boolean).map(line => `<li>${line}</li>`).join('')}</ul>`;
}
