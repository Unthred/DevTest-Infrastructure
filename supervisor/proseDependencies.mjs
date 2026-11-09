// Issue #1023 (moved out of team.mjs unchanged, issue #1103): prose dependencies and the open items an issue waits on.
// Issue #1023: dependencies written in prose: "Depends on #N", "after PR N", "after #N merges" (a list may follow: "#4, PR 5 and #6").
// Returns { prs, numbers }: `prs` were written as PR N, `numbers` as a bare #N that may name an issue or a pull request (resolved
// when the queue is built). A bare "after #N" counts only when it says what it waits for ("merges", "closes", "lands").
const DEP_ITEM = String.raw`(?:(?:PR|pull request)\s*#?\d+|#\d+)`;
const DEP_LIST = String.raw`${DEP_ITEM}(?:\s*(?:,|and|&)\s*${DEP_ITEM})*`;
export function proseDependencies(body) {
  const text = String(body || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const prs = new Set(), numbers = new Set();
  const take = (list, bare) => { for (const m of list.matchAll(/(?:(?:PR|pull request)\s*#?(\d+))|#(\d+)/gi)) { if (m[1]) prs.add(Number(m[1])); else if (bare) numbers.add(Number(m[2])); } };
  for (const m of text.matchAll(new RegExp(String.raw`\bdepends?\s+on\s+(${DEP_LIST})`, 'gi'))) take(m[1], true);
  for (const m of text.matchAll(new RegExp(String.raw`\bafter\s+(${DEP_LIST})(\s+(?:has\s+|have\s+|is\s+|are\s+|being\s+)?(?:merge[sd]?|land(?:s|ed)?|clos(?:es|ed)))?`, 'gi'))) take(m[1], !!m[2]);
  for (const p of prs) numbers.delete(p);
  return { prs: [...prs], numbers: [...numbers] };
}
// The open items an issue waits on: prose dependencies and the items an earlier implement job reported (`declared`). An item is open
// while it is an open issue or an open pull request; a merged or closed one, or one nobody knows, no longer holds the issue.
export function waitingOnRefs(issue, issueByNo, prs, declared = []) {
  const pd = issue.proseDependencies ?? proseDependencies(issue.body);
  const open = d => issueByNo.get(d)?.state === 'OPEN' || (prs || []).some(p => p.number === d);
  return [...new Set([...pd.prs, ...pd.numbers, ...declared])].filter(open).sort((a, b) => a - b);
}
