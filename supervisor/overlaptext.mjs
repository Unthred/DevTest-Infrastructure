// Issue #1223: the text of a file overlap hold. It names both sides by number: the held item (an issue, or a pull request with the issue
// of its branch) and the running or planned job it overlaps (its issue, and its pull request when one is open).
const issueOfBranch = branch => {
  const m = /\/issue-(\d+)(\D|$)/.exec(branch || '');
  return m ? Number(m[1]) : null;
};

export function overlapText({ type = 'implement', issue, pr = null, file, other, prs = [] }) {
  const otherPr = (prs || []).find(p => issueOfBranch(p.headRefName) === other);
  const mine = pr != null ? `${type} of PR #${pr} (issue #${issue})` : `issue #${issue}`;
  const theirs = `issue #${other}${otherPr ? ` (PR #${otherPr.number})` : ''}`;
  return `${mine} waits: it is expected to edit ${file}, which the running or planned job for ${theirs} also edits`;
}
