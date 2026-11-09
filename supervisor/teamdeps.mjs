// Issue #1103: dependency gating for every lane, applied to a Team. The decisions are pure (dependencies.mjs); this file gathers the
// facts (issues, pull requests, the installed version), keeps the "waiting since" record and carries out the mid-run stop.
// Functions take the Team so team.mjs gains only call sites, never behaviour.
import { parseDependsOn, evaluateDependencies, prerequisiteState, waitText } from './dependencies.mjs';
import { installedShaOf, gitAncestor } from './depinstalled.mjs';

const issueOfBranch = b => { const m = /\/issue-(\d+)(\D|$)/.exec(b || ''); return m ? Number(m[1]) : null; };
// Any unmet state stops a running job (rule 4), `unknown` included: a failed lookup is never met. The stop uses no attempt, so it costs nothing.
const DEFINITE = new Set(['open', 'merged_not_installed', 'closed_not_planned', 'unknown']);

// Tests and the tick may set team.depEnv = { installedSha(), isAncestor(a, b) }; otherwise the real install and repository are read.
function environment(team) {
  const env = team.depEnv || {};
  team.depGit ??= gitAncestor(team.c.repo_path);
  return { installedSha: env.installedSha ? env.installedSha() : installedShaOf(team.root), isAncestor: env.isAncestor || team.depGit };
}

// The merged pull requests that settled prerequisite `d`: the PR itself, or the ones that close issue `d`.
const closesIssue = (m, d) => (m.closingIssuesReferences || []).some(r => r?.number === d);
const mergedFor = (merged, d) => (merged || [])
  .filter(m => m.number === d || closesIssue(m, d) || issueOfBranch(m.headRefName) === d)
  .map(m => ({ state: 'MERGED', mergeSha: m.mergeCommit?.oid ?? m.mergeSha ?? null }));

// Pull requests found by number are remembered: merged ones in team.depPulls, ones closed without a merge in team.depClosed.
function noteSettledPull(team, pr, closes = null) {
  const state = String(pr?.state).toUpperCase();
  // The issue that named this pull request as its closer is recorded on it, so the match does not depend on the pull request's own list.
  if (state === 'MERGED') {
    const refs = [...(pr.closingIssuesReferences || []), { number: closes }];
    team.depPulls.set(pr.number, closes == null ? pr : { ...pr, closingIssuesReferences: refs });
  } else if (state === 'CLOSED') team.depClosed.add(pr.number);
}

// A closed prerequisite: its closing pull requests are read by number, whether or not the issue was in the cached list.
async function findMergedPulls(team, issue) {
  if (issue.state !== 'CLOSED' || typeof team.gh.getPull !== 'function') return;
  for (const ref of issue.closedByPullRequestsReferences || []) {
    if (!ref?.number || team.depPulls.has(ref.number) || (team.merged || []).some(m => m.number === ref.number)) continue;
    try { noteSettledPull(team, await team.gh.getPull(ref.number), issue.number); } catch { /* unknown, never met */ }
  }
}

// A number that names a pull request, not an issue: `gh issue view` gives MERGED, or CLOSED with no reason. Read it as a pull request.
async function findPullByNumber(team, issue) {
  const state = String(issue.state).toUpperCase();
  const asPull = state === 'MERGED' || (state === 'CLOSED' && !issue.stateReason);
  if (!asPull || typeof team.gh.getPull !== 'function' || team.depPulls.has(issue.number) || team.depClosed.has(issue.number)) return;
  try {
    const pr = await team.gh.getPull(issue.number);
    if (pr && pr.number === issue.number) noteSettledPull(team, pr);
  } catch { /* unknown, never met */ }
}

// Closed results do not change, so they are kept in the state file and the next pass (a new Team) does not ask GitHub again.
// Only the fields the decision reads are kept. depFetched: closed issues, depPulls: merged pull requests, depClosed: pull requests closed unmerged.
const keepIssue = i => ({
  number: i.number,
  state: i.state,
  stateReason: i.stateReason ?? null,
  closedByPullRequestsReferences: i.closedByPullRequestsReferences || [],
});
const keepPull = p => ({
  number: p.number,
  state: p.state,
  headRefName: p.headRefName ?? '',
  mergeCommit: p.mergeCommit ?? null,
  closingIssuesReferences: p.closingIssuesReferences || [],
});
function loadRemembered(team) {
  if (team.depFetched) return team.s.depCache;
  const kept = team.s.depCache ||= { issues: {}, pulls: {}, closed: [] };
  team.depFetched = new Map(Object.values(kept.issues).map(i => [i.number, i]));
  team.depPulls = new Map(Object.values(kept.pulls).map(p => [p.number, p]));
  team.depClosed = new Set(kept.closed);
  return kept;
}
function rememberedChanged(team, kept) {
  const issues = Object.fromEntries([...team.depFetched].filter(([, i]) => i.state === 'CLOSED').map(([n, i]) => [n, keepIssue(i)]));
  const pulls = Object.fromEntries([...team.depPulls].map(([n, p]) => [n, keepPull(p)]));
  const closed = [...team.depClosed].sort((a, b) => a - b);
  const next = JSON.stringify({ issues, pulls, closed });
  if (next === JSON.stringify(kept)) return false;
  Object.assign(kept, { issues, pulls, closed });
  return true;
}

// `merged` defaults to the merged list the planner loaded; the stop step passes its own.
export async function refreshDependencies(team, issues, prs, merged = team.merged) {
  if (team.depFromCache) return team.dependencies;   // the dashboard's copy restored from the tick: cached issues carry no body, so it cannot be recomputed
  const open = (issues || []).filter(i => i.state === 'OPEN');
  const byNo = new Map((issues || []).map(i => [i.number, i]));
  const wanted = new Set();
  for (const i of open) for (const d of parseDependsOn(i.body, i.number).numbers) wanted.add(d);
  // A prerequisite outside the cached lists is fetched by number; a closed one is remembered, an open one is asked again each pass.
  const remembered = loadRemembered(team);
  for (const d of wanted) {
    if (!byNo.has(d)) {
      const kept = team.depFetched.get(d);
      if (kept?.state === 'CLOSED') byNo.set(d, kept);
      else if (typeof team.gh.getIssue === 'function') {
        try {
          const got = await team.gh.getIssue(d);
          if (got) { team.depFetched.set(d, got); byNo.set(d, got); }
        } catch { /* unknown, never met */ }
      }
    }
    const found = byNo.get(d);
    if (found) { await findMergedPulls(team, found); await findPullByNumber(team, found); }
  }
  const { installedSha, isAncestor } = environment(team);
  const lookup = d => {
    const openPr = (prs || []).find(p => p.number === d);
    if (openPr) return { pr: { state: 'OPEN' } };
    const issue = byNo.get(d) || null, candidates = mergedFor([...(merged || []), ...team.depPulls.values()], d);
    const installed = candidates.find(c => prerequisiteState({ issue, pr: c, installedSha, isAncestor }) === 'installed');
    const best = installed || candidates[candidates.length - 1] || (team.depClosed.has(d) ? { state: 'CLOSED' } : null);
    return { issue, pr: best };
  };
  if (rememberedChanged(team, remembered)) team.save();
  const result = evaluateDependencies({ issues: open, lookup, installedSha, isAncestor });
  const now = team.clock.now(), wait = (team.s.depWait ||= {});
  for (const [n, e] of result.byIssue) {
    if (e.met) delete wait[n];
    else if (!wait[n]) wait[n] = { since: now };
    e.since = wait[n]?.since ?? null;
  }
  for (const n of Object.keys(wait)) if (!result.byIssue.has(Number(n))) delete wait[n];
  team.dependencies = { ...result, installedSha, evaluatedAt: now };
  return team.dependencies;
}

export function dependencyEntry(team, number) { return team.dependencies?.byIssue.get(number) || null; }

// The prerequisites of an issue that are still open, from its Depends on line (the one dependency source).
export function openDependencies(team, number) {
  return (dependencyEntry(team, number)?.dependsOn || []).filter(d => d.state === 'open').map(d => d.number);
}

// The exclusion record for an issue whose prerequisites are not all installed (see Team.exclusion).
export function dependencyExclusion(team, number) {
  const e = dependencyEntry(team, number);
  if (!e || e.met) return null;
  const refs = e.dependsOn.filter(d => d.state !== 'installed').map(d => d.number);
  return { kind: 'dependency', refs, text: waitText(e) };
}

// The issue a lane job or action belongs to: its issue, or the issue named in its pull request's branch.
export function issueOfAction(team, act) {
  if (Number.isSafeInteger(act.issue)) return act.issue;
  const pr = act.pr != null ? (team.view?.prs || []).find(p => p.number === act.pr) : null;
  return issueOfBranch(act.branch || pr?.headRefName);
}

// Every lane honours the gate: implement, review, fix, rebase, merge and the rest wait while their issue has an unmet prerequisite.
export function dependencyGate(team, act) {
  const n = issueOfAction(team, act);
  const e = n != null ? dependencyEntry(team, n) : null;
  return e && !e.met ? { kind: 'dependency', why: waitText(e) } : null;
}

// A job already running whose issue gained an unmet prerequisite stops cleanly. It is not a failure: the stop is marked so ingest counts no attempt.
// The check runs on facts read in this pass: the tick runs it before plan(), and every pass builds a new Team.
export async function enforceDependencies(team, report) {
  if (typeof team.jobs.stop !== 'function') return;
  const active = await team.jobs.listActive();
  if (!active.length) return;
  if (!team.depFromCache) {
    const issues = await team.gh.listIssues(), prs = await team.gh.listPulls(), merged = await (team.gh.listMergedPulls?.() ?? []);
    team.passReads = { issues, prs, merged };   // plan() takes these once instead of reading the same lists again in this pass
    await refreshDependencies(team, issues, prs, merged);
  }
  if (!team.dependencies) return;
  for (const j of active) {
    const rec = team.s.jobs[j.id];
    if (!rec || rec.dependencyStop || rec.kind === 'inbox' && !Number.isSafeInteger(rec.issue)) continue;
    const n = issueOfAction(team, { issue: rec.issue, pr: rec.pr, branch: rec.branch });
    const e = n != null ? dependencyEntry(team, n) : null;
    if (!e || e.met || !(e.malformed || e.cycle || e.dependsOn.some(d => DEFINITE.has(d.state)))) continue;
    // Stop first: if the job ended in that instant the stop throws and nothing is marked or refunded, so the next pass looks again.
    await team.jobs.stop(j.id);
    rec.dependencyStop = { at: team.clock.now(), reasons: e.reasons };
    refundAttempt(team, rec);
    team.save();
    (report.actions ||= []).push({ type: 'dependency-stop', result: `stopped job ${j.id.slice(0, 8)} on #${n}: ${waitText(e)}; it waits and uses no attempt` });
  }
}

// Which attempt counter a lane charges at launch, as [counter, key]; a secret-scan-only fix charges none.
export function chargedCounter(act) {
  switch (act.type) {
    case 'review': return ['reviewAttempts', act.key];
    case 'fix': return ['fixAttempts', act.key];
    case 'continue': return ['continueAttempts', act.pr];
    case 'rebase': return ['rebaseAttempts', act.key];
    case 'cifix': return act.scanOnly ? null : ['fixAttempts', act.key];
    default: return null;
  }
}

// A dependency stop uses no attempt: the attempt the lane charged when the job started is given back, once, as the stop is made.
// A scan-only round is counted in scanOnlyRounds instead; the launch records on the job which kind of fix it was.
function refundAttempt(team, rec) {
  if (rec.escalated && rec.pr != null) delete team.s.unblock?.escalated?.[rec.pr];   // the one final round was not used either
  if (rec.scanOnly) {
    const rounds = team.s.scanOnlyRounds;
    if (rounds?.[rec.pr] > 0) rounds[rec.pr]--;
    return;
  }
  const charged = chargedCounter({ type: rec.kind, key: rec.key, pr: rec.pr });
  const counts = charged ? team.s[charged[0]] : null;
  if (counts && charged[1] != null && counts[charged[1]] > 0) counts[charged[1]]--;
}

// The tick's cap step: the inbox time cap, then the dependency stops (the second runs even when the first throws).
export async function enforceStops(team, report) {
  try { await team.enforceInboxCap(report); } finally { await enforceDependencies(team, report); }
}

// ---- what the dashboard cache carries (plain data) and what readers show
export function dependencyPlain(deps) {
  if (!deps) return null;
  return { evaluatedAt: deps.evaluatedAt, installed: deps.installedSha ? String(deps.installedSha).slice(0, 7) : null,
    issues: Object.fromEntries([...deps.byIssue].filter(([, e]) => e.dependsOn.length || e.malformed).map(([n, e]) => [n, {
      dependsOn: e.dependsOn, malformed: e.malformed, cycle: e.cycle, met: e.met, reasons: e.reasons, since: e.since ?? null }])) };
}
export function dependencyFromPlain(plain) {
  if (!plain?.issues) return null;
  return { byIssue: new Map(Object.entries(plain.issues).map(([n, e]) => [Number(n), e])), installedSha: null, evaluatedAt: plain.evaluatedAt };
}
// Needs you items: a malformed line, a loop, a prerequisite closed as not planned (the line needs repointing) and one closed with no pull request.
export function dependencyAttention(cache) {
  const out = [], issues = cache?.dependencies?.issues || {}, seen = new Set();
  for (const [key, e] of Object.entries(issues)) {
    const n = Number(key), ref = { kind: 'issue', n };
    if (e.malformed) {
      out.push({ id: `dependency-malformed-${n}`, text: `#${n}: the Depends on line is malformed (${e.malformed})`, ref,
        action: 'Edit the issue so it has one line like "Depends on: #12, #15". Foreman does not guess, so the issue waits until then.' });
    }
    if (e.cycle && !seen.has(e.cycle.join(','))) {
      seen.add(e.cycle.join(','));
      const loop = e.cycle.map(c => `#${c}`).join(' -> ');
      out.push({ id: `dependency-cycle-${e.cycle.join('-')}`, text: `Dependency loop: ${loop} -> #${e.cycle[0]}; none of them can start`,
        ref: { kind: 'issue', n: e.cycle[0] }, action: 'Remove one Depends on reference to break the loop.' });
    }
    for (const d of e.dependsOn || []) {
      if (d.unlinked) {
        out.push({
          id: `dependency-unlinked-${n}-${d.number}`,
          text: `#${n} waits on #${d.number}, which was closed as completed with no linked pull request`,
          ref,
          action: `Foreman cannot tell whether #${d.number} is installed. `
            + `Remove it from the Depends on line of #${n}, or name the pull request that delivered it.`,
        });
      }
      if (d.state !== 'closed_not_planned') continue;
      out.push({ id: `dependency-notplanned-${n}-${d.number}`, text: `#${n} waits on #${d.number}, which was closed as not planned or superseded`, ref,
        action: `Repoint the Depends on line of #${n} to the issue that replaced #${d.number}, or remove it.` });
    }
  }
  return out;
}

// What the dashboard needs, in one object so it adds no import.
export const dependencyTools = {
  fromPlain: dependencyFromPlain,
  attention: dependencyAttention,
  exclusion: dependencyExclusion
};
