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
const mergedFor = (merged, d) => (merged || []).filter(m => m.number === d || (m.closingIssuesReferences || []).some(r => r?.number === d) || issueOfBranch(m.headRefName) === d)
  .map(m => ({ state: 'MERGED', mergeSha: m.mergeCommit?.oid ?? m.mergeSha ?? null }));

// A closed prerequisite outside the cached merged list: its closing pull requests are read by number and remembered once merged.
async function findMergedPulls(team, issue) {
  if (issue.state !== 'CLOSED' || typeof team.gh.getPull !== 'function') return;
  for (const ref of issue.closedByPullRequestsReferences || []) {
    if (!ref?.number || team.depPulls.has(ref.number) || (team.merged || []).some(m => m.number === ref.number)) continue;
    try {
      const pr = await team.gh.getPull(ref.number);
      if (String(pr?.state).toUpperCase() === 'MERGED') team.depPulls.set(ref.number, pr);
    } catch { /* unknown, never met */ }
  }
}

export async function refreshDependencies(team, issues, prs) {
  const open = (issues || []).filter(i => i.state === 'OPEN');
  const byNo = new Map((issues || []).map(i => [i.number, i]));
  const wanted = new Set();
  for (const i of open) for (const d of parseDependsOn(i.body, i.number).numbers) wanted.add(d);
  // A prerequisite outside the cached lists is fetched by number; a closed one is remembered, an open one is asked again each pass.
  team.depFetched ??= new Map();
  team.depPulls ??= new Map();   // merged pull requests found by number, for prerequisites older than the cached merged list
  for (const d of wanted) {
    if (byNo.has(d)) continue;
    const kept = team.depFetched.get(d);
    if (kept?.state === 'CLOSED') { byNo.set(d, kept); await findMergedPulls(team, kept); continue; }
    if (typeof team.gh.getIssue !== 'function') continue;
    try {
      const got = await team.gh.getIssue(d);
      if (got) { team.depFetched.set(d, got); byNo.set(d, got); await findMergedPulls(team, got); }
    } catch { /* unknown, never met */ }
  }
  const { installedSha, isAncestor } = environment(team);
  const lookup = d => {
    const openPr = (prs || []).find(p => p.number === d);
    if (openPr) return { pr: { state: 'OPEN' } };
    const issue = byNo.get(d) || null, candidates = mergedFor([...(team.merged || []), ...team.depPulls.values()], d);
    const best = candidates.find(c => prerequisiteState({ issue, pr: c, installedSha, isAncestor }) === 'installed') || candidates[candidates.length - 1] || null;
    return { issue, pr: best };
  };
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

// The exclusion record for an issue whose prerequisites are not all installed (see Team.exclusion).
export function dependencyExclusion(team, number) {
  const e = dependencyEntry(team, number);
  if (!e || e.met) return null;
  return { kind: 'dependency', refs: e.dependsOn.filter(d => d.state !== 'installed').map(d => d.number), text: waitText(e) };
}

// The issue a lane job or action belongs to: its issue, or the issue named in its pull request's branch.
export function issueOfAction(team, act) {
  if (Number.isSafeInteger(act.issue)) return act.issue;
  const pr = act.pr != null ? (team.view?.prs || []).find(p => p.number === act.pr) : null;
  return issueOfBranch(act.branch || pr?.headRefName);
}

// Every lane honours the gate: implement, review, fix, rebase, merge and the rest wait while their issue has an unmet prerequisite.
export function dependencyGate(team, act) {
  const n = issueOfAction(team, act), e = n != null ? dependencyEntry(team, n) : null;
  return e && !e.met ? { kind: 'dependency', why: waitText(e) } : null;
}

// A job already running whose issue gained an unmet prerequisite stops cleanly. It is not a failure: the stop is marked so ingest counts no attempt.
export async function enforceDependencies(team, report) {
  if (!team.dependencies || typeof team.jobs.stop !== 'function') return;
  for (const j of await team.jobs.listActive()) {
    const rec = team.s.jobs[j.id];
    if (!rec || rec.dependencyStop || rec.kind === 'inbox' && !Number.isSafeInteger(rec.issue)) continue;
    const n = issueOfAction(team, { issue: rec.issue, pr: rec.pr, branch: rec.branch }), e = n != null ? dependencyEntry(team, n) : null;
    if (!e || e.met || !(e.malformed || e.cycle || e.dependsOn.some(d => DEFINITE.has(d.state)))) continue;
    rec.dependencyStop = { at: team.clock.now(), reasons: e.reasons };
    team.save();
    await team.jobs.stop(j.id);
    (report.actions ||= []).push({ type: 'dependency-stop', result: `stopped job ${j.id.slice(0, 8)} on #${n}: ${waitText(e)}; it waits and uses no attempt` });
  }
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
// Needs you items: a malformed line, a loop, and a prerequisite closed as not planned (the line needs repointing).
export function dependencyAttention(cache) {
  const out = [], issues = cache?.dependencies?.issues || {}, seen = new Set();
  for (const [key, e] of Object.entries(issues)) {
    const n = Number(key), ref = { kind: 'issue', n };
    if (e.malformed) out.push({ id: `dependency-malformed-${n}`, text: `#${n}: the Depends on line is malformed (${e.malformed})`, ref, action: 'Edit the issue so it has one line like "Depends on: #12, #15". Foreman does not guess, so the issue waits until then.' });
    if (e.cycle && !seen.has(e.cycle.join(','))) { seen.add(e.cycle.join(',')); out.push({ id: `dependency-cycle-${e.cycle.join('-')}`, text: `Dependency loop: ${e.cycle.map(c => `#${c}`).join(' -> ')} -> #${e.cycle[0]}; none of them can start`, ref: { kind: 'issue', n: e.cycle[0] }, action: 'Remove one Depends on reference to break the loop.' }); }
    for (const d of e.dependsOn || []) if (d.state === 'closed_not_planned') out.push({ id: `dependency-notplanned-${n}-${d.number}`, text: `#${n} waits on #${d.number}, which was closed as not planned or superseded`, ref, action: `Repoint the Depends on line of #${n} to the issue that replaced #${d.number}, or remove it.` });
  }
  return out;
}

// What the dashboard needs, in one object so it adds no import.
export const dependencyTools = {
  fromPlain: dependencyFromPlain,
  attention: dependencyAttention,
  exclusion: dependencyExclusion
};
