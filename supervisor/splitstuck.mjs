// Issue #1240: a pull request stuck at the fix limit (or at the rebase cap with the same cause) is parked, a read-only planning job drafts 2 to
// 4 smaller items, and the homeowner approves or rejects the split on one decision card. Nothing is filed before the approval. The state is
// `team.s.stuckSplits[pr]`; the Team class only calls the entry points below.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redact } from './redact.mjs';
import { park, depsOf } from './controlactions.mjs';
import { descriptionRoundFor } from './descround.mjs';
import { sameCauseCap, capped } from './robust.mjs';
import { readStuckDraft, itemBody, bodyFault, STANDING_OPTIONS } from './splitstuck-draft.mjs';

const HEAD = /^[0-9a-f]{40}$/;
const PROMPT = fs.readFileSync(new URL('./splitstuck-prompt.txt', import.meta.url), 'utf8');

const records = team => (team.s.stuckSplits ||= {});
const agentOf = (team, pr) => Object.entries(team.c.agents).find(([, a]) => typeof pr.headRefName === 'string' && pr.headRefName.startsWith(a.branch_prefix))?.[0] ?? null;
const sourceIssue = pr => Number(/\/issue-(\d+)/.exec(pr.headRefName || '')?.[1]) || null;

// Why this pull request is stuck, or null. The description-only path is tried first (issue #1226): while it can still run, nothing is parked.
export function stuckCause(team, pr) {
  if (pr.isDraft || !HEAD.test(pr.headRefOid || '') || !agentOf(team, pr) || descriptionRoundFor(team, pr)) return null;
  const n = pr.number, max = team.c.limits.max_fix_attempts;
  const rejected = team.s.verdicts[`${n}:${pr.headRefOid}`]?.verdict === 'CHANGES' || team.ciState(pr) === 'red';
  const finalRoundPending = team.escalationPending(n, pr) && !team.carriedHold(pr);   // one final fix round is still to run
  if (rejected && team.fixCount(n) >= max && !finalRoundPending) return { kind: 'fix-limit', text: `${team.fixCount(n)} fix rounds (limit ${max}) have not cleared ${team.rejectionCause(pr)}` };
  const cap = sameCauseCap(team.c.limits);
  const stopped = capped(team.s, { type: 'rebase', subject: n, head: pr.headRefOid }, cap) ? team.s.sameCause[`rebase:${n}`] : null;   // a new head starts the count again
  return stopped ? { kind: 'rebase-cap', text: `rebases of this PR stopped ${stopped.count} times for the same cause (cap ${cap})` } : null;
}

// What the planning job reads besides the issue and the diff: the blocking findings, this PR's files and the files of every other open PR.
async function openFileLists(team, self) {
  const out = new Map();
  for (const p of await team.gh.listPulls()) if (p.number !== self) out.set(p.number, (await team.gh.listPullFiles(p.number)).map(String));
  return out;
}
const findingsOf = (team, n) => Object.entries(team.s.verdicts).filter(([k]) => k.startsWith(`${n}:`))
  .flatMap(([, v]) => (v.findings || []).filter(f => f.kind === 'blocking').map(f => redact(f.text, 400)));

async function writeContext(team, pr, ticket) {
  const others = await openFileLists(team, pr.number);
  const dir = path.join(team.dir, 'inbox', ticket);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const context = { pr: pr.number, thisPrFiles: (await team.gh.listPullFiles(pr.number)).map(String), blockingFindings: findingsOf(team, pr.number), otherOpenPrFiles: Object.fromEntries(others) };
  fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(context, null, 1), { mode: 0o600 });
}

async function startJob(team, pr, rec, report) {
  if (team.s.breaker.global) return;   // the breaker stops every new job; the planning job is started after a resume
  const agent = agentOf(team, pr), a = team.c.agents[agent], ticket = crypto.randomBytes(16).toString('hex');
  await writeContext(team, pr, ticket);
  const wt = await team.git.ensureWorktree({ path: path.join(team.c.worktree_base, `DevTest-Infrastructure-${agent}-splitpr-${pr.number}`), branch: `${a.branch_prefix}splitpr-${pr.number}`, base: 'origin/main' });
  const prompt = PROMPT.replaceAll('{{INBOX}}', path.join(team.dir, 'inbox', ticket)).replaceAll('{{PR}}', String(pr.number)).replaceAll('{{BRANCH}}', pr.headRefName)
    .replaceAll('{{ISSUE}}', rec.issue ? `#${rec.issue}` : 'unknown').replaceAll('{{REASON}}', rec.reason);
  const spec = { role: 'devtest', provider: a.provider, repository: team.c.repo_path, access: team.c.access?.mode === 'full' ? 'full' : 'standard', autoRestart: true,
    kind: 'split', worktree: wt, issue: rec.issue ?? pr.number, scope: `Draft a split of parked PR #${pr.number}; read-only, no code`, allowed_actions: ['read'],
    prompt, postcondition: { kind: 'stuck_split_drafted', ticket } };
  Object.assign(spec, team.modelFor({ agent, key: `split:${pr.number}` }, 'split', report));
  const created = await team.jobs.create(spec);
  team.s.jobs[created.id] = { kind: 'split', agent, key: `split:${pr.number}`, issue: spec.issue, stuckPr: pr.number, ticket, model: spec.model ?? null, effort: spec.effort ?? null,
    modelSource: spec.modelSource ?? null, modelReason: spec.modelReason ?? null, ingested: false, at: team.clock.now() };
  Object.assign(rec, { draftJob: created.id, ticket });
  team.save();
  (report.actions ||= []).push({ type: 'split', agent, issue: pr.number, result: `PR #${pr.number} is parked (${rec.reason}); started the read-only planning job ${created.id.slice(0, 8)}` });
}

// One pass of the tick. The record is written before any effect, so a crash never creates a second card or a second planning job.
export async function stuckSplitPass(team, report, guard = (_, fn) => fn()) {
  const open = await team.gh.listPulls();
  for (const pr of open) {
    const cause = records(team)[pr.number] ? null : stuckCause(team, pr);
    if (!cause) continue;
    await guard(`split stuck ${pr.number}`, async () => {
      const rec = records(team)[pr.number] = { status: 'planning', cause: cause.kind, reason: redact(cause.text, 300), issue: sourceIssue(pr), head: pr.headRefOid, agent: agentOf(team, pr), at: team.clock.now() };
      team.save();
      (report.notified ||= []).push({ pr: pr.number, splitStuck: cause.kind });
    });
  }
  for (const [k, rec] of Object.entries(records(team))) {
    const pr = open.find(p => p.number === Number(k));
    if (rec.status === 'planning' && pr) await guard(`split stuck ${k}`, () => advancePlanning(team, pr, rec, report));
    if (rec.status === 'filed') await guard(`split close ${k}`, () => closeWhenMerged(team, Number(k), rec, pr, report));
  }
}

async function advancePlanning(team, pr, rec, report) {
  if (!rec.parked) {
    const r = await park(pr.number, depsOf(team));
    if (r.outcome === 'refused') { rec.parkError = r.text; team.save(); return; }
    Object.assign(rec, { parked: true, parkedAt: team.clock.now() });
    delete rec.parkError;
    team.save();
    await team.postNotice(pr.number, `split-stuck-parked pr=${pr.number}`, `**Parked.** ${rec.reason}. Foreman starts no further fix, rebase or review job for this PR and keeps its branch. A read-only planning job is drafting a split into smaller items; nothing is filed until the homeowner approves it.`);
  }
  if (!rec.draftJob) await startJob(team, pr, rec, report);
}

// The planning job ended: check its draft against the open pull requests, then show it on the card (the dashboard builds the card from the record).
export async function ingestStuckSplit(team, id, j, job, report) {
  const rec = records(team)[j.stuckPr];
  if (!rec || rec.draftJob !== id || rec.status !== 'planning') return;
  let draft;
  if (job.status !== 'completed') draft = { error: `the planning job ended ${job.status}` };
  else {
    try { draft = readStuckDraft(team.root, j.ticket, await openFileLists(team, j.stuckPr)); } catch (error) { draft = { error: `the open pull request files could not be read (${String(error?.message || error).slice(0, 120)})` }; }
  }
  if (draft.error) { Object.assign(rec, { status: 'failed', error: redact(draft.error, 300) }); team.save(); report.ingested.push({ job: id, pr: j.stuckPr, error: draft.error }); return; }
  Object.assign(rec, { status: 'proposed', items: draft.items, proposedAt: team.clock.now() });
  team.save();
  const list = draft.items.map((x, i) => `${i + 1}. **${x.title}** (${x.files.join(', ')}): ${x.scope}`).join('\n');
  await team.postNotice(j.stuckPr, `split-stuck-proposal pr=${j.stuckPr}`, `**Needs the homeowner: proposed split.** ${rec.reason}. Proposed items:\n\n${list}\n\nChoose Approve split or Reject split on the dashboard card. Nothing is filed until you approve; rejecting leaves this PR parked.`);
  report.ingested.push({ job: id, pr: j.stuckPr, split: draft.items.length });
}

const need = (team, n, ...states) => {
  const rec = records(team)[n];
  if (!rec || !states.includes(rec.status)) throw new Error(`PR #${n} has no split in the state ${states.join(' or ')}${rec ? ` (it is ${rec.status})` : ''}`);
  return rec;
};

// Approve: file the items once through acceptSplit. A repeat after 'filed' changes nothing; a repeat after a crash resumes (the markers find the issues).
export async function approveStuckSplit(team, n) {
  const rec = records(team)[n];
  if (rec?.status === 'filed' || rec?.status === 'closed') return `PR #${n}: the split is already filed as ${rec.filed.map(x => `#${x}`).join(', ')}`;
  need(team, n, 'proposed');
  const children = rec.items.map((x, i) => ({ title: x.title, scope: x.scope, body: itemBody({ item: x, index: i, count: rec.items.length, parent: n, source: rec.issue }), after: x.prerequisite ? x.prerequisite - 1 : null }));
  const fault = children.map(c => bodyFault(c.body)).find(Boolean);
  if (fault) throw new Error(`an item body was refused by the dependency parser: ${fault}`);
  const sp = team.s.splits[n] ||= { status: 'proposed', agent: rec.agent, stuckPr: n, children, at: team.clock.now() };
  // A crash after acceptSplit but before this record was saved leaves the split 'accepted'; resume from its children instead of throwing.
  const issues = sp.status === 'accepted' ? sp.children.map(c => c.issue) : await team.acceptSplit(n);
  Object.assign(rec, { status: 'filed', filed: issues, filedAt: team.clock.now() });
  team.save();
  return `PR #${n}: filed ${sp.children.map(c => `#${c.issue}`).join(', ')}; the PR stays parked until they have merged`;
}

export async function rejectStuckSplit(team, n) {
  const rec = records(team)[n];
  if (rec?.status === 'rejected') return `PR #${n}: the split was already rejected; the PR stays parked`;
  need(team, n, 'proposed');
  Object.assign(rec, { status: 'rejected', rejectedAt: team.clock.now() });
  team.save();
  await team.postNotice(n, `split-stuck-rejected pr=${n}`, `**Split rejected.** Nothing was filed. This PR stays parked. Standing options: ${STANDING_OPTIONS}.`);
  return `PR #${n}: split rejected; nothing filed; the PR stays parked`;
}

// The parked PR is closed as superseded only after every new item has merged, and only by the close as superseded action of issue #1157
// (it saves the branch under saved/, refuses when a superseding item is missing and records who, when and why). This module does not close
// anything itself: when the last item has merged it marks the record `itemsMerged`, and the card asks the homeowner for that action.
async function closeWhenMerged(team, n, rec, pr, report) {
  if (!pr) { rec.status = 'closed'; team.save(); return; }   // closed by the #1157 action, by someone else, or by an earlier pass
  if (rec.itemsMerged || !rec.filed.every(i => team.delivered?.has(i))) return;
  Object.assign(rec, { itemsMerged: true, itemsMergedAt: team.clock.now() });
  team.save();
  (report.notified ||= []).push({ pr: n, splitItemsMerged: rec.filed });
}
