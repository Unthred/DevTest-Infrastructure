// Issue #1240: a Team over fake GitHub, jobs and git, holding one pull request that has drawn the fix limit. Shared by the split-stuck tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team } from '../../supervisor/team.mjs';
import { stateRoot } from '../../supervisor/core.mjs';

export const REGISTER = '## D-020 — x\n- Status: homeowner-approved\n- Date: 2026-10-30\n';
const red = [{ status: 'COMPLETED', conclusion: 'FAILURE', name: 'tests' }];
const config = (fix = 4) => ({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { roles: { implementer: 2, reviewer: 2 }, overall: 4, max_review_attempts: 2, max_fix_attempts: fix },
  agents: { codex: { provider: 'codex', branch_prefix: 'codex/', issues: [1127] }, claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] } },
  board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });

// pr: { number, branch, head, files }, others: { number: files[] } (other open pull requests), fixRounds: rounds already drawn.
export function stuckWorld(t, { pr, others = {}, fixRounds = 4, fix = 4, verdict = { verdict: 'CHANGES', reviewer: 'claude', at: 500, findings: [{ kind: 'blocking', scope: 'code', text: 'the wiring has no end to end test' }] } } = {}) {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'splitstuck-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = { comments: [], labels: [], created: [], issues: [], closed: [], worktrees: [] };
  const pull = (n, branch, head, labels = []) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', labels, statusCheckRollup: red });
  const files = { [pr.number]: pr.files, ...others };
  const gh = {
    pulls: [pull(pr.number, pr.branch, pr.head), ...Object.keys(others).map(n => pull(Number(n), `claude/issue-${n}-x`, String(n % 10).repeat(40)))],
    issues: [],
    listPulls: async () => gh.pulls, getPull: async n => gh.pulls.find(p => p.number === n) || null, listIssues: async () => gh.issues, listMergedPulls: async () => [],
    listPullFiles: async n => files[n] || [], pullBody: async () => 'body', board: async () => {},
    comment: async (n, body) => calls.comments.push([n, body]), hasComment: async (n, marker) => calls.comments.some(([x, b]) => x === n && b.includes(marker)),
    addLabel: async (n, l) => calls.labels.push([n, l]), removeLabel: async () => {},
    addLabelAsApp: async (n, l) => { calls.labels.push([n, l, 'app']); gh.pulls.find(p => p.number === n)?.labels.push(l); },
    findIssueByMarker: async marker => gh.issues.find(i => i.body?.includes(marker))?.number || null,
    createIssue: async (title, body) => { const number = 2000 + gh.issues.length; gh.issues.push({ number, title, state: 'OPEN', body, labels: [] }); calls.issues.push([number, title, body]); return number; },
  };
  const jobs = { seq: 0, states: {}, listActive: async () => [], get: async id => jobs.states[id] || null,
    create: async spec => { const id = (++jobs.seq).toString(16).padStart(32, '0'); calls.created.push(spec); jobs.states[id] = { id, status: 'queued', provider: spec.provider }; return { id }; } };
  const git = { ensureWorktree: async o => { calls.worktrees.push(o); return o.path; }, worktreeFor: async () => null };
  const team = new Team({ config: config(fix), root: stateRoot(path.join(dir, 'state')), gh, jobs, git, register: REGISTER, clock: { now: () => 1000 } });
  team.s.fixAttempts[`${pr.number}:${pr.head}`] = fixRounds;
  team.s.verdicts[`${pr.number}:${pr.head}`] = verdict;
  if (fixRounds >= fix) team.s.unblock.escalated[pr.number] = true;   // the final escalated round already ran, so the fix limit is drawn
  team.save();
  const draftFile = (ticket, data) => { const d = path.join(team.dir, 'inbox', ticket); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'split-stuck-draft.json'), typeof data === 'string' ? data : JSON.stringify(data)); };
  const finishDraft = async (data) => {
    const [id, rec] = Object.entries(team.s.jobs).find(([, r]) => r.kind === 'split' && r.stuckPr);
    if (data !== null) draftFile(rec.ticket, data);
    jobs.states[id].status = 'completed';
    return team.tick();
  };
  return { team, gh, jobs, calls, dir, finishDraft, draftFile };
}
