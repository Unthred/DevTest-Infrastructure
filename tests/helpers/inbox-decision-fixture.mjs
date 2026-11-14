// Issue #1477: the decision cards of 14 Nov 2026 as the real dashboard raises them, from a saved cache and team state, so the /inbox page
// shows the cards the homeowner saw: split-stuck for PR #1175 (Approve split, Reject split, Unpark), fixlimit for PR #1146 (Extra fix round,
// Close as superseded with its input, Unpark), split-parked for PR #1139 (Unpark only) and homeowner-pr for PR #1192 (Park only).
// Written next to an Inbox built by inbox-views-fixture.mjs, so a prompt row sits beside them.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const head = n => String(n).padStart(40, 'a');
const PROPOSAL = ['# A fixture decision proposal', '', '- Status: agent-proposal', '- Date: 2026-11-14', '- Source: issue #1192', '- Decision: x', '- Rationale: x', '- Rejected: x', '- Superseded-by: none', ''].join('\n');
const git = (repo, ...args) => {
  const r = spawnSync('git', ['-C', repo, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
// A small independent repository whose head adds the decision proposal file, so Foreman raises "decision-proposal" for PR #1192 next to its
// homeowner-pr card (the Inbox lists a decision card only when one of its causes is a decision; the row keeps the homeowner-pr card).
function proposalRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(dir, 'docs', 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs', 'DECISIONS.md'), '# Decisions\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'main');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  fs.writeFileSync(path.join(dir, 'docs', 'decisions', '1192-a-fixture-proposal.md'), PROPOSAL);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'proposal');
  return git(dir, 'rev-parse', 'HEAD');
}
const pull = (number, labels, checks = []) => ({ number, title: `Work item ${number}`, state: 'OPEN', headRefName: `claude/issue-${number}-x`, headRefOid: head(number), labels, statusCheckRollup: checks });
const FAILING = [{ status: 'COMPLETED', conclusion: 'FAILURE' }];
const GITHUB_APP = { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' };   // Park needs the app configured; the file is never read

export const DECISION_CARDS = {
  'split-stuck-1175': ['Approve split', 'Reject split', 'Unpark'],
  'fixlimit-1146': ['Extra fix round', 'Close as superseded', 'Unpark'],
  'split-parked-1139': ['Unpark'],
  'homeowner-pr-1192': ['Park'],
};

// Writes the dashboard cache and the team state under `root`; returns the config fields the cards need.
export function writeDecisionState(root, now = Date.now()) {
  const proposalHead = proposalRepo(path.join(root, 'repo'));
  fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dashboard'), { recursive: true });
  const pulls = [pull(1175, ['parked'], FAILING), pull(1146, ['parked', 'needs-homeowner'], FAILING), pull(1139, ['parked'], FAILING), { ...pull(1192, ['needs-homeowner'], FAILING), headRefOid: proposalHead }];
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: now - 60000, status: 'ok', lastOkAt: now - 60000 }, fetchedAt: now - 60000, pulls, issues: [] }));
  const split = (status, extra = {}) => ({ status, cause: 'fix-limit', reason: '3 fix rounds', parked: true, filed: [], ...extra });
  const stuckSplits = {
    1175: split('proposed', { items: [{ title: 'Part one', files: ['a.mjs'] }, { title: 'Part two', files: ['b.mjs'] }] }),
    1139: split('failed', { items: [], error: 'the draft was refused' }),
  };
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ fixAttempts: { [`1146:${head(1146)}`]: 3 }, verdicts: {}, jobs: {}, stuckSplits }));
  return { github_app: GITHUB_APP, repo_path: path.join(root, 'repo') };
}
