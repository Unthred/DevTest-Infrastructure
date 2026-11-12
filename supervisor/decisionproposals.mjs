// Issue #1229: the decision proposals open pull requests add (a numbered register entry, or a docs/decisions file named for its issue)
// and the words of the Needs you card for each. A file proposal is named by its file, never by a number that can change.
import { proposalsAdded } from './decisions.mjs';
import { fileProposalsAdded } from './decisionfiles.mjs';
import { readHeadRegister, readHeadDecisionFiles, readMainDecisionFiles } from './planning.mjs';
import { redact } from './redact.mjs';

// Never throws: an unreadable head adds none.
export function pendingProposals(config, pulls, mainRegister, read = readHeadRegister, readFiles = readHeadDecisionFiles, readMain = readMainDecisionFiles) {
  const out = [];
  let mainFiles = null;
  for (const p of pulls || []) {
    if (p.isDraft) continue;
    let text = ''; try { text = read(config, p) || ''; } catch { text = ''; }
    for (const e of proposalsAdded(mainRegister, text)) out.push({ ...e, pr: p.number });
    try {
      const files = readFiles(config, p);
      if (files.size) for (const e of fileProposalsAdded(mainFiles ??= readMain(config), files)) out.push({ ...e, pr: p.number });
    } catch { /* an unreadable head adds no proposal */ }
  }
  return out;
}

// The card's headline and what to do, for one proposal and the text of the pull request that adds it.
export function proposalWords(p, prText) {
  const text = `Decision ${p.id} (${redact(p.title, 120)}) is an agent proposal awaiting your sign-off, added by ${prText}${p.file ? ` as ${p.file}` : ''}`;
  const action = p.file
    ? `To approve, comment "homeowner-approval: ${p.id}" on the pull request. Foreman then assigns the decision its number once; the name ${p.id} never changes. Or reject the PR.`
    : `To approve, comment "homeowner-approval: ${p.id}" on the pull request and set the entry to "Status: homeowner-approved" with its Source linking that comment, or reject the PR.`;
  return { text, action };
}
