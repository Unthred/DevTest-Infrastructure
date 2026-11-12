// Issue #1188: the gate that reads the PR facts and runs the pure cite check. It is the one place that touches GitHub for it,
// so the dispatcher gate (requirements-table.mjs tablePostcondition) and the cite-check tool share requirementsCiteProblems.
import { citeProblemsMessage, citedPaths, requirementsCiteProblems } from './requirements-cites.mjs';


// Returns the one-list message for the author, or null when every cite holds or the facts cannot be read (a read failure is not the author's fault).
export async function citeGateError(pr, body, gh) {
  if (typeof gh?.pullDiff !== 'function' || typeof gh?.fileAtRef !== 'function') return null;
  try {
    const diff = await gh.pullDiff(pr.number);
    const headFiles = new Map();
    for (const path of citedPaths(body)) headFiles.set(path, await gh.fileAtRef(path, pr.headRefOid));
    const issueNumber = pr.closingIssuesReferences?.[0]?.number;
    const issueBody = issueNumber && typeof gh.getIssue === 'function' ? (await gh.getIssue(issueNumber))?.body : '';
    const problems = requirementsCiteProblems({ body, diff, headFiles, issueBody });
    return problems.length ? citeProblemsMessage(problems) : null;
  } catch { return null; }
}
