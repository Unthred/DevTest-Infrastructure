// Issue #1229: Foreman's approval pass. A decision file on main that is still an agent-proposal, and whose source issue has a pull request
// carrying the repository owner's "homeowner-approval: <name>" comment, gets its D number once: the pass commits the numbered file and the
// regenerated index to main from a throwaway clone (fast-forward push, never forced). Idempotent: once numbered, the file is no longer a proposal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { approvalsFrom } from './decisions.mjs';
import { parseDecisionFiles, PROPOSAL } from './decisionfiles.mjs';
import { readDecisionRef, approveDecisionFile } from './decisionfilesio.mjs';

const run = (cwd, args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120000 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${String(r.stderr || r.error || '').trim().slice(0, 200)}`);
  return r.stdout.trim();
};

// The pull requests that can carry the approval of a proposal: open or merged, linked to its source issue by closing reference or branch name.
export function pullsOfIssue(pulls, issue) {
  return pulls.filter(p => (p.closingIssuesReferences || []).some(i => i.number === issue) || new RegExp(`issue-${issue}(?!\\d)`).test(p.headRefName || ''));
}

// Commits the approval of one decision file on a fresh clone of origin and pushes it to main. Returns { number }.
export function commitApproval(repoPath, name, approvals, tmpRoot = os.tmpdir()) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'decision-approval-'));
  try {
    const clone = path.join(dir, 'clone');
    run(repoPath, ['clone', '--quiet', '--no-local', '--branch', 'main', run(repoPath, ['remote', 'get-url', 'origin']), clone]);
    const result = approveDecisionFile(clone, name, approvals);
    if (!result.changed) return result;
    run(clone, ['add', 'docs/decisions']);
    run(clone, ['-c', 'user.name=Foreman', '-c', 'user.email=foreman@localhost', 'commit', '--quiet', '-m', `Assign ${result.number} to the approved decision ${name} (#${name.split('-')[0]})`]);
    run(clone, ['push', '--quiet', 'origin', 'HEAD:main']);
    return result;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// One pass. deps: { gh, repoPath, isOwnerComment(comment), owner, commit }. Returns the approvals carried out; a failure on one decision is
// recorded in report.skipped and retried next pass.
export async function approveDecisions(deps, report = {}) {
  const { gh, repoPath, isOwnerComment, owner, commit = commitApproval } = deps;
  const proposals = parseDecisionFiles(readDecisionRef(repoPath, 'origin/main')).filter(p => p.status === PROPOSAL);
  if (!proposals.length || !gh.prComments) return [];
  const pulls = [...await gh.listPulls(), ...await (gh.listMergedPulls?.() ?? [])];
  const done = [];
  for (const p of proposals) {
    try {
      const approvals = new Map();
      for (const pr of pullsOfIssue(pulls, Number(p.name.split('-')[0])))
        for (const [id, list] of approvalsFrom((await gh.prComments(pr.number)).filter(isOwnerComment), owner)) approvals.set(id, [...(approvals.get(id) || []), ...list.map(a => ({ ...a, pr: pr.number }))]);
      const mine = approvals.get(p.name);
      if (!mine?.length) continue;
      const r = commit(repoPath, p.name, approvals);
      if (!r.changed) continue;   // origin/main here was stale: the clone already had the number
      done.push({ name: p.name, number: r.number });
      (report.notified ||= []).push({ decision: p.name, number: r.number });
      await gh.comment(mine[mine.length - 1].pr, `Foreman assigned ${r.number} to the approved decision ${p.name}; it is recorded in docs/decisions/${p.name}.md and the generated index on main.`);
    } catch (error) { (report.skipped ||= []).push({ what: `decision approval ${p.name}`, reason: String(error.message || error).slice(0, 200) }); }
  }
  return done;
}
