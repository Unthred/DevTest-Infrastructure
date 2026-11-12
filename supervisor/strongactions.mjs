// Issue #1158: what an approved strong action does on the tick. Each one changes a real gate and then reads that gate back; a result that cannot be
// read back is a failure, never a success message. Every one acts on the head the homeowner confirmed and refuses if the pull request moved on.
// Outcomes follow runControl: 'done', 'refused' (nothing changed, with the reason) or 'failed' (something may have changed; the reason says what).
import { proposalsAdded, approvalsFrom } from './decisions.mjs';

// The review gate's key (team.mjs verdictKey; importing it here would make team.mjs and this module import each other, a test pins them equal).
export const keyOf = (n, head) => `${n}:${head}`;
const done = (text, extra = {}) => ({ outcome: 'done', text, ...extra });
const refused = text => ({ outcome: 'refused', text });
const failed = text => ({ outcome: 'failed', text });
const missing = (gh, ...names) => names.filter(n => typeof gh[n] !== 'function');

// The open pull request, or a refusal. The confirmed head must still be its head: this is the check that makes the typed confirmation about a commit.
async function openPullAtConfirmedHead(gh, n, confirmed) {
  const pr = await gh.getPull(n);
  if (!pr || (pr.state && pr.state !== 'OPEN') || pr.merged) return { refusal: `pull request #${n} is not open` };
  if (!confirmed || pr.headRefOid !== confirmed) return { refusal: `pull request #${n} has a new head (${String(pr.headRefOid).slice(0, 7)}) since you confirmed ${String(confirmed).slice(0, 7)}; nothing was changed` };
  return { pr };
}

async function merge({ team, n, head, item, now }) {
  const lacking = missing(team.gh, 'merge', 'getPull');
  if (lacking.length) return refused(`this supervisor cannot ${lacking.join(' or ')}, so the merge could not be checked afterwards; nothing was changed`);
  try { await team.gh.merge(n, head); } catch (error) { return refused(`GitHub refused the merge: ${String(error?.message || error).slice(0, 200)}`); }
  const after = await team.gh.getPull(n);
  if (!(after?.merged === true || after?.state === 'MERGED' || after?.mergedAt)) return failed(`the merge call for pull request #${n} returned but GitHub does not show it merged`);
  team.s.merged[n] = head;
  team.save();
  return done(`pull request #${n} was merged at ${head.slice(0, 7)} (homeowner override: ${item.reason})`, { override: { kind: 'merge', pr: n, head, at: now } });
}

// The one decision the pull request adds to the register; approving more than one at once is not offered.
async function proposalOf(team, pr, deps) {
  // Loaded when used: planning.mjs imports team.mjs, which imports this module through controlactions.mjs.
  const read = deps.readHeadRegister ?? (await import('./planning.mjs')).readHeadRegister;
  const text = read(team.c, pr) || '';
  const found = proposalsAdded(team.register, text);
  return found.length === 1 ? { id: found[0].id } : { refusal: found.length ? `pull request #${pr.number} adds ${found.length} decision proposals (${found.map(f => f.id).join(', ')}); approve them on the pull request` : `pull request #${pr.number} adds no decision proposal at ${pr.headRefOid.slice(0, 7)}` };
}
const ownerApproves = (comments, owner, id) => approvalsFrom(comments, owner).has(id);

async function approveDecision({ team, n, pr, deps }) {
  const lacking = missing(team.gh, 'comment', 'prComments');
  if (lacking.length) return refused(`this supervisor cannot ${lacking.join(' or ')}, so the approval could not be checked afterwards; nothing was changed`);
  const found = await proposalOf(team, pr, deps);
  if (found.refusal) return refused(found.refusal);
  const owner = team.ownerLogin();
  if (ownerApproves(await team.gh.prComments(n), owner, found.id)) return refused(`${found.id} already has your homeowner-approval comment on pull request #${n}`);
  await team.gh.comment(n, `homeowner-approval: ${found.id}\n\nApproved by the homeowner on the Foreman dashboard, after typing pull request number ${n} at head ${pr.headRefOid}. Set the ${found.id} entry to Status: homeowner-approved with its Source linking this comment.`);
  if (!ownerApproves(await team.gh.prComments(n), owner, found.id)) return failed(`the approval comment for ${found.id} was posted but is not read as ${owner}'s homeowner-approval; check which account posted it`);
  return done(`${found.id} is approved on pull request #${n}: the homeowner-approval comment is recorded as ${owner}'s`, { override: { kind: 'approve_decision', pr: n, decision: found.id } });
}

// The entry the review gate reads (team.s.verdicts), marked as the homeowner's. A verdict already at this head is archived, not erased.
// A CHANGES verdict starts a fix round, so it carries the homeowner's reason as a blocking finding and says it publicly on the pull request
// (the fix prompt tells the writer to read the findings there). The comment is posted first: a failed post records nothing.
async function recordVerdict({ team, n, head, item, now }, verdict) {
  const key = keyOf(n, head), prior = team.s.verdicts[key];
  if (prior?.verdict === verdict && prior.homeowner === true) return refused(`pull request #${n} already has your ${verdict} verdict at ${head.slice(0, 7)}`);
  const changes = verdict === 'CHANGES';
  if (changes && missing(team.gh, 'comment').length) return refused('this supervisor cannot comment on the pull request, so the fix loop would have no findings to read; nothing was changed');
  const findings = changes ? [{ kind: 'blocking', text: `Homeowner verdict: ${item.reason}` }] : [];
  if (changes) await team.gh.comment(n, `**CHANGES** — homeowner verdict on head ${head}, recorded from the Foreman dashboard after typing pull request number ${n}.\n\n${findings.map(f => `- **${f.kind}**: ${f.text}`).join('\n')}`);
  if (prior) team.archiveVerdict(key, prior);
  team.s.verdicts[key] = { verdict, reviewer: 'homeowner', homeowner: true, independent: true, findings, commandsRun: [], reason: item.reason, at: now };
  team.save();
  const read = team.s.verdicts[key];
  if (read?.verdict !== verdict || read.homeowner !== true) return failed(`the ${verdict} verdict for pull request #${n} could not be read back from the review gate`);
  return done(`the review gate holds your ${verdict} verdict for pull request #${n} at ${head.slice(0, 7)}`, { override: { kind: `verdict_${verdict.toLowerCase()}`, pr: n, head, at: now } });
}

const APPLY = { merge_pr: merge, approve_decision: approveDecision, verdict_pass: c => recordVerdict(c, 'PASS'), verdict_changes: c => recordVerdict(c, 'CHANGES') };

// Applies one confirmed strong action. `st.confirm.head` is the head the homeowner typed against.
export async function applyStrong(team, st, item, deps = {}) {
  const apply = APPLY[item.action];
  if (!apply) return refused('unknown strong action');
  if (st.confirm?.by !== 'homeowner' || String(st.confirm.typed) !== item.target || !/^[0-9a-f]{40}$/.test(st.confirm.head ?? '')) return refused('the item carries no recorded homeowner confirmation, so nothing was done');
  const n = Number(item.target), found = await openPullAtConfirmedHead(team.gh, n, st.confirm.head);
  if (found.refusal) return refused(found.refusal);
  return apply({ team, n, pr: found.pr, head: st.confirm.head, item, now: team.clock.now(), deps });
}

// Runs one picked-up strong item: 'running' is recorded BEFORE the effect (at most once). The status keeps who, when, why and the head.
export async function runStrong(team, dir, st, item, inboxStore, report, deps = {}) {
  const now = () => team.clock.now();
  if (!inboxStore.claim(dir, st.id, 'approved', { state: 'running' }, now())) return;
  try {
    const r = await applyStrong(team, st, item, deps);
    const strong = { action: item.action, pr: Number(item.target), head: st.confirm?.head ?? null, by: 'homeowner', at: now(), why: item.reason, ...(r.override ? { override: r.override } : {}) };
    if (r.outcome === 'done') inboxStore.finish(dir, st.id, { state: 'done', result: r.text, strong }, now());
    else if (r.outcome === 'refused') inboxStore.finish(dir, st.id, { state: 'refused', reason: r.text, result: 'nothing was changed', strong }, now());
    else inboxStore.finish(dir, st.id, { state: 'failed', reason: r.text, result: 'check the pull request', strong }, now());
    (report.actions ||= []).push({ type: 'homeowner-strong-action', result: `${item.action} ${item.target}: ${r.text}` });
  } catch (error) {
    inboxStore.finish(dir, st.id, { state: 'failed', reason: String(error?.message || error).slice(0, 250), result: 'check the pull request' }, now());
  }
}
