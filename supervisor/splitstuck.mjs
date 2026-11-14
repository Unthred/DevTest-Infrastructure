// Issue #1338: a pull request stuck at the fix limit (or at the rebase cap with the same cause at its current head) is parked, a read-only
// planning job drafts 2 to 4 smaller items, and the homeowner approves or rejects the split on one decision card. Nothing is filed before the
// approval. The state is `team.s.stuckSplits[pr]`; the Team class only calls the entry points below.
// The draft checker, the item body builder and the planning prompt are the ones of issue #1336 (splitstuck-draft.mjs, splitstuck-prompt.txt).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LeaseHeld } from './core.mjs';
import { redact } from './redact.mjs';
import { park, depsOf } from './controlactions.mjs';
import { descriptionRoundFor } from './descround.mjs';
import { sameCauseCap, capped } from './robust.mjs';
import { checkStuckDraft, itemBody, bodyFault, DRAFT_FILE } from './splitstuck-draft.mjs';
import { closeSuperseded } from './closesupersededaction.mjs';
import { STANDING_OPTIONS } from './splitstuck-view.mjs';

const HEAD = /^[0-9a-f]{40}$/;
const PROMPT = fs.readFileSync(new URL('./splitstuck-prompt.txt', import.meta.url), 'utf8');
const MAX_JOB_RETRIES = 1;

const records = team => (team.s.stuckSplits ||= {});
const sourceIssue = pr => Number(/\/issue-(\d+)/.exec(pr.headRefName || '')?.[1]) || null;
function agentOf(team, pr) {
  const found = Object.entries(team.c.agents).find(([, a]) => typeof pr.headRefName === 'string' && pr.headRefName.startsWith(a.branch_prefix));
  return found ? found[0] : null;
}

// The files of every open pull request, by number (the planning job and the draft checker both need them).
async function openFileLists(team) {
  const out = new Map();
  for (const pull of await team.gh.listPulls()) out.set(pull.number, (await team.gh.listPullFiles(pull.number)).map(String));
  return out;
}

// Reads the planning job's draft and checks it with the checker of issue #1336. `context` is the parked PR and the open PR file lists.
export function readStuckDraft(root, ticket, context = {}) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, 'team', 'inbox', String(ticket || 'none'), DRAFT_FILE), 'utf8'));
  } catch {
    return { error: `${DRAFT_FILE} is missing or not JSON` };
  }
  return checkStuckDraft(raw, context);
}

// Why this pull request is stuck, or null. The description only round is tried first (issue #1226): while it can still run, nothing is parked.
export function stuckCause(team, pr) {
  const n = pr.number;
  const unusable = pr.isDraft || !HEAD.test(pr.headRefOid || '') || !agentOf(team, pr) || descriptionRoundFor(team, pr);
  if (unusable) return null;
  const max = team.c.limits.max_fix_attempts;
  const rejected = team.s.verdicts[`${n}:${pr.headRefOid}`]?.verdict === 'CHANGES' || team.ciState(pr) === 'red';
  const finalRoundPending = team.escalationPending(n, pr) && !team.carriedHold(pr);
  if (rejected && team.fixCount(n) >= max && !finalRoundPending) {
    return { kind: 'fix-limit', text: `${team.fixCount(n)} fix rounds (limit ${max}) have not cleared ${team.rejectionCause(pr)}` };
  }
  if (team.s.verdicts[`${n}:${pr.headRefOid}`]?.verdict === 'PASS') return null;
  const cap = sameCauseCap(team.c.limits);
  const stopped = capped(team.s, { type: 'rebase', subject: n, head: pr.headRefOid }, cap) ? team.s.sameCause[`rebase:${n}`] : null;
  return stopped ? { kind: 'rebase-cap', text: `rebases of this PR stopped ${stopped.count} times for the same cause (cap ${cap})` } : null;
}

const blockingFindings = (team, n) => Object.entries(team.s.verdicts)
  .filter(([key]) => key.startsWith(`${n}:`))
  .flatMap(([, verdict]) => (verdict.findings || []).filter(f => f.kind === 'blocking').map(f => redact(f.text, 400)));

// What the planning job reads besides the issue and the diff: the blocking findings, this PR's files and the files of every other open PR.
async function writeContext(team, pr, ticket) {
  const others = await openFileLists(team);
  others.delete(pr.number);
  const dir = path.join(team.dir, 'inbox', ticket);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const context = {
    pr: pr.number,
    thisPrFiles: (await team.gh.listPullFiles(pr.number)).map(String),
    blockingFindings: blockingFindings(team, pr.number),
    otherOpenPrFiles: Object.fromEntries(others)
  };
  fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(context, null, 1), { mode: 0o600 });
}

function planningPrompt(team, pr, rec, ticket) {
  return PROMPT
    .replaceAll('{{INBOX}}', path.join(team.dir, 'inbox', ticket))
    .replaceAll('{{PR}}', String(pr.number))
    .replaceAll('{{BRANCH}}', pr.headRefName)
    .replaceAll('{{ISSUE}}', rec.issue ? `#${rec.issue}` : 'unknown')
    .replaceAll('{{REASON}}', rec.reason);
}

// A held lease is an expected wait (reported by leaseHeld), retried on the next tick; any other error is the guard's.
async function createJob(team, spec, pr, agent, report) {
  try {
    return await team.jobs.create(spec);
  } catch (error) {
    if (!(error instanceof LeaseHeld)) throw error;
    let created = null;
    await team.leaseHeld(error, { type: 'split', pr: pr.number, agent }, report, async () => { created = await team.jobs.create(spec); });
    return created;
  }
}

async function startJob(team, pr, rec, report) {
  if (team.s.breaker.global) return;
  const agent = agentOf(team, pr);
  const a = team.c.agents[agent];
  const ticket = crypto.randomBytes(16).toString('hex');
  await writeContext(team, pr, ticket);
  const worktree = await team.git.ensureWorktree({
    path: path.join(team.c.worktree_base, `DevTest-Infrastructure-${agent}-splitpr-${pr.number}`),
    branch: `${a.branch_prefix}splitpr-${pr.number}`,
    base: 'origin/main'
  });
  const spec = {
    role: 'devtest', provider: a.provider, repository: team.c.repo_path, access: team.c.access?.mode === 'full' ? 'full' : 'standard', autoRestart: true,
    kind: 'split', worktree, issue: rec.issue ?? pr.number, scope: `Draft a split of parked PR #${pr.number}; read-only, no code`, allowed_actions: ['read'],
    prompt: planningPrompt(team, pr, rec, ticket), postcondition: { kind: 'stuck_split_drafted', ticket }
  };
  Object.assign(spec, team.modelFor({ agent, key: `split:${pr.number}` }, 'split', report));
  const created = await createJob(team, spec, pr, agent, report);
  if (!created) return;
  team.s.jobs[created.id] = {
    kind: 'split', agent, key: `split:${pr.number}`, issue: spec.issue, stuckPr: pr.number, ticket, model: spec.model ?? null, effort: spec.effort ?? null,
    modelSource: spec.modelSource ?? null, modelReason: spec.modelReason ?? null, ingested: false, at: team.clock.now()
  };
  Object.assign(rec, { draftJob: created.id, ticket });
  team.save();
  const result = `PR #${pr.number} is parked (${rec.reason}); started the read-only planning job ${created.id.slice(0, 8)}`;
  (report.actions ||= []).push({ type: 'split', agent, issue: pr.number, result });
}

async function advancePlanning(team, pr, rec, report) {
  if (!rec.parked) {
    const parked = await park(pr.number, depsOf(team));
    if (parked.outcome === 'refused') {
      rec.parkError = parked.text;
      team.save();
      return;
    }
    Object.assign(rec, { parked: true, parkedAt: team.clock.now() });
    delete rec.parkError;
    team.save();
    await team.postNotice(pr.number, `split-stuck-parked pr=${pr.number}`,
      `**Parked.** ${rec.reason}. Foreman starts no further fix, rebase or review job for this PR and keeps its branch. `
      + 'A read-only planning job is drafting a split into smaller items; nothing is filed until the homeowner approves it.');
  }
  if (!rec.draftJob) await startJob(team, pr, rec, report);
}

// One pass of the tick. The record is written before any effect, so a second event never creates a second record, job or card.
export async function stuckSplitPass(team, report, guard = (_, fn) => fn()) {
  const open = await team.gh.listPulls();
  for (const pr of open) {
    const cause = records(team)[pr.number] ? null : stuckCause(team, pr);
    if (!cause) continue;
    await guard(`split stuck ${pr.number}`, async () => {
      records(team)[pr.number] = {
        status: 'planning', cause: cause.kind, reason: redact(cause.text, 300), issue: sourceIssue(pr),
        head: pr.headRefOid, agent: agentOf(team, pr), at: team.clock.now()
      };
      team.save();
      (report.notified ||= []).push({ pr: pr.number, splitStuck: cause.kind });
    });
  }
  for (const [number, rec] of Object.entries(records(team))) {
    const pr = open.find(p => p.number === Number(number));
    if (rec.status === 'planning' && pr) await guard(`split stuck ${number}`, () => advancePlanning(team, pr, rec, report));
    if (rec.status === 'filed' && pr) await guard(`split close ${number}`, () => closeWhenMerged(team, pr, rec, report));
  }
}

// Issue #1340: once every filed item has merged, the parked pull request is closed by the close as superseded action (issue #1337), which
// saves the branch first. There is no other close path here. Nothing is closed while any item is open or was closed without a merge.
const isMerged = issue => String(issue?.state).toUpperCase() === 'CLOSED'
  && String(issue?.stateReason ?? 'COMPLETED').toUpperCase().replace(/[\s-]/g, '_') === 'COMPLETED';

async function allMerged(team, filed) {
  for (const n of filed) if (!isMerged(await team.gh.getIssue(n))) return false;
  return true;
}

// The Contents write wording is only for a refusal of the saved copy step; the close step and the checks name their own cause.
const PERMISSION = /resource not accessible by integration|\b403\b/i;
export const CONTENTS_STEP = 'grant the GitHub App Contents write permission so the branch can be saved under saved/; '
  + 'Foreman retries on the next tick and closes nothing until the copy is saved';

export function closeFault(step, error) {
  const cause = redact(String(error?.message || error), 200);
  if (step === 'save' && PERMISSION.test(cause)) {
    return { step, text: `writing the saved copy of the branch was refused (${cause})`, homeownerStep: CONTENTS_STEP };
  }
  return { step, text: step === 'save' ? `writing the saved copy of the branch failed (${cause})` : `the close as superseded action failed (${cause})` };
}

async function closeWhenMerged(team, pr, rec, report) {
  if (!rec.filed?.length || !(await allMerged(team, rec.filed))) return;
  let step = 'close';
  const saveBranch = async (...args) => {
    step = 'save';
    const saved = await team.gh.saveBranch(...args);
    step = 'close';
    return saved;
  };
  const acting = Object.create(team, { gh: { value: { ...team.gh, saveBranch } } });
  try {
    const result = await closeSuperseded(acting, { target: pr.number, superseded_by: rec.filed.join(', '), reason: 'every item of its split has merged' });
    Object.assign(rec, { status: 'closed', closedAt: team.clock.now() });
    delete rec.closeError;
    team.save();
    (report.actions ||= []).push({ type: 'split-close', issue: pr.number, result });
  } catch (error) {
    const fault = closeFault(step, error);
    if (rec.closeError?.text === fault.text) return;
    rec.closeError = fault;
    team.save();
  }
}

// A planning job that ended without a draft is retried once (the next pass starts it again); a second failure is the record's reason.
function failPlanning(team, rec, why, id, report, n) {
  if (!rec.retries && why.job) {
    Object.assign(rec, { retries: MAX_JOB_RETRIES, retriedAfter: redact(why.error, 300) });
    delete rec.draftJob;
    delete rec.ticket;
  } else {
    Object.assign(rec, { status: 'failed', error: redact(why.error, 300) });
  }
  team.save();
  report.ingested.push({ job: id, pr: n, error: why.error, retry: rec.status === 'planning' });
}

// The planning job ended: check its draft against the open pull requests; the dashboard builds the card from the record.
export async function ingestStuckSplit(team, id, j, job, report) {
  const rec = records(team)[j.stuckPr];
  if (!rec || rec.draftJob !== id || rec.status !== 'planning') return;
  if (job.status !== 'completed') return failPlanning(team, rec, { error: `the planning job ended ${job.status}`, job: true }, id, report, j.stuckPr);
  let draft;
  try {
    const context = { pullRequest: { number: j.stuckPr }, openPullRequestFiles: await openFileLists(team) };
    draft = readStuckDraft(team.root, j.ticket, context);
  } catch (error) {
    draft = { error: `the open pull request files could not be read (${String(error?.message || error).slice(0, 120)})` };
  }
  if (draft.error) return failPlanning(team, rec, { error: draft.error, job: false }, id, report, j.stuckPr);
  Object.assign(rec, { status: 'proposed', items: draft.items, proposedAt: team.clock.now() });
  team.save();
  const list = draft.items.map((x, i) => `${i + 1}. **${x.title}** (${x.files.join(', ')}): ${x.scope}`).join('\n');
  await team.postNotice(j.stuckPr, `split-stuck-proposal pr=${j.stuckPr}`,
    `**Needs the homeowner: proposed split.** ${rec.reason}. Proposed items:\n\n${list}\n\n`
    + 'Choose Approve split or Reject split on the dashboard card. Nothing is filed until you approve; rejecting leaves this PR parked.');
  report.ingested.push({ job: id, pr: j.stuckPr, split: draft.items.length });
}

function need(team, n, state) {
  const rec = records(team)[n];
  if (!rec || rec.status !== state) throw new Error(`PR #${n} has no split in the state ${state}${rec ? ` (it is ${rec.status})` : ''}`);
  return rec;
}

function childrenOf(rec, n) {
  return rec.items.map((item, index) => ({
    title: item.title,
    scope: item.scope,
    body: itemBody({ item, index, count: rec.items.length, parent: n, source: rec.issue }),
    after: item.prerequisite ? item.prerequisite - 1 : null
  }));
}

// Approve: validate every body, then file the items once through acceptSplit. A repeat after 'filed' changes nothing; a repeat after a crash
// resumes (the child markers find the issues already filed).
export async function approveStuckSplit(team, n) {
  const rec = records(team)[n];
  if (rec?.status === 'filed') return `PR #${n}: the split is already filed as ${rec.filed.map(x => `#${x}`).join(', ')}`;
  need(team, n, 'proposed');
  const children = childrenOf(rec, n);
  const fault = children.map(c => bodyFault(c.body)).find(Boolean);
  if (fault) throw new Error(`an item body was refused by the dependency parser: ${fault}`);
  const sp = team.s.splits[n] ||= { status: 'proposed', agent: rec.agent, stuckPr: n, children, at: team.clock.now() };
  // A crash after acceptSplit but before this record was saved leaves the split 'accepted'; it counts as filed.
  const issues = sp.status === 'accepted' ? sp.children.map(c => c.issue) : await team.acceptSplit(n);
  Object.assign(rec, { status: 'filed', filed: issues, filedAt: team.clock.now() });
  team.save();
  return `PR #${n}: filed ${issues.map(x => `#${x}`).join(', ')}; the PR stays parked until every item has merged`;
}

export async function rejectStuckSplit(team, n) {
  const rec = records(team)[n];
  if (rec?.status === 'rejected') return `PR #${n}: the split was already rejected; the PR stays parked`;
  need(team, n, 'proposed');
  Object.assign(rec, { status: 'rejected', rejectedAt: team.clock.now() });
  team.save();
  const text = `**Split rejected.** Nothing was filed. This PR stays parked. Standing options: ${STANDING_OPTIONS}.`;
  await team.postNotice(n, `split-stuck-rejected pr=${n}`, text);
  return `PR #${n}: split rejected; nothing filed; the PR stays parked`;
}
