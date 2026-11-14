// Issue #1339: the approved inbox action extra_fix_round. It lets exactly one more fix or CI fix job start on the current head of a stopped
// pull request, past the fix limit and the churn stop, and then the limits apply again.
// The grant is one record per pull request in state.extraFix[<pr>]: { head, agent, model?, spent, by, at, why }. It counts only while it names
// the pull request's current head, so a new head ends an unused grant by itself.
// D-011: the writer is always the branch author, in its own worktree; the choice offered is a model of that agent. This module imports nothing
// from the team module: the team passes itself in and hands in `authorOf`, the branch author lookup.
import { SupervisorError } from './core.mjs';
import { isOpusModel } from './models.mjs';

const SHA = /^[0-9a-f]{40}$/;
const WRITING = new Set(['fix', 'cifix']);
const ENDED = new Set(['completed', 'failed', 'blocked', 'stopped']);
export const EXTRA_FIX_MODEL_MAX = 30;
const refuse = text => { throw new SupervisorError(text); };

// ---- the grant -------------------------------------------------------------------------------------------------------------------------
// The open grant of this pull request at this head, or null. `state` is the team's persisted state.
export function openGrant(state, number, head) {
  const grant = state.extraFix?.[number];
  return grant && grant.head === head && !grant.spent ? grant : null;
}

// Called when any job starts; only a fix or CI fix job uses the grant up (a rebase or review never does), whether or not its fix lands.
export function spendGrant(state, act) {
  if (!WRITING.has(act.type)) return;
  const grant = openGrant(state, act.pr, act.head);
  if (grant) grant.spent = true;
}

// Called by the team's model choice: while a grant names a model, a fix or CI fix job of that head runs on it. The writer rules still judge
// the result afterwards, so the planner write gate and the job start both see the granted model.
export function withGrantedModel(state, act, kind, resolved) {
  if (!WRITING.has(kind)) return resolved;
  const model = act.extraModel ?? (act.pr == null ? null : openGrant(state, act.pr, act.head)?.model);
  if (!model) return resolved;
  const fields = { ...resolved.fields, model, modelSource: 'extra_fix_round', modelReason: `extra fix round on ${model}` };
  delete fields.modelWarning;
  return { ...resolved, fields, entry: { ...resolved.entry, model } };
}

// ---- choosing the model ----------------------------------------------------------------------------------------------------------------
// The author's configured model names and its provider's aliases, never Opus. Each is still judged by the ordinary writer rules.
function modelsOfAgent(team, agent) {
  const named = Object.values(team.c.models?.agents?.[agent] || {}).flatMap(e => (Array.isArray(e) ? e : [e]).map(x => x?.model));
  const aliases = team.providerModels?.[team.c.agents[agent].provider]?.aliases || [];
  return [...new Set([...aliases, ...named])].filter(m => typeof m === 'string' && m && !isOpusModel(m));
}

// The ordinary writer rules for this author on a model (null = the ordinary model): { model, writeRefusal? }.
function writerGate(team, pr, agent, model) {
  const act = { agent, pr: pr.number, branch: pr.headRefName, head: pr.headRefOid, key: `wb:${pr.number}`, ...(model ? { extraModel: model } : {}) };
  return team.modelFor(act, 'fix', {}, true);
}

// The model of the pull request's most recent fix or CI fix job, or null when none is recorded.
function lastFixModel(jobs, number) {
  const rounds = Object.values(jobs).filter(j => WRITING.has(j.kind) && j.pr === number);
  return rounds.sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0]?.model ?? null;
}

function requestedModel(team, pr, author, requested) {
  if (team.c.agents[requested] && requested !== author) {
    refuse(`${requested} cannot write this fix: PR #${pr.number} is ${author}'s branch and each agent works only in its own worktree (D-011)`);
  }
  const allowed = modelsOfAgent(team, author);
  if (!allowed.includes(requested)) {
    refuse(`${requested} is not a model ${author} may write with${allowed.length ? ` (allowed: ${allowed.join(', ')})` : ''}`);
  }
  const why = writerGate(team, pr, author, requested).writeRefusal;
  if (why) refuse(`${author} may not write this fix on ${requested}: ${why}`);
  return requested;
}

// No model asked for: a model different from the last fix round's where the writer rules leave one, else the ordinary model. Returns the
// model name, or null for the ordinary model. Refuses when no model could be given a fix job.
function defaultModel(team, pr, author) {
  const ordinary = writerGate(team, pr, author, null);
  const last = lastFixModel(team.s.jobs, pr.number);
  if (!ordinary.writeRefusal && ordinary.model !== last) return null;
  const other = modelsOfAgent(team, author).find(m => m !== last && !writerGate(team, pr, author, m).writeRefusal);
  if (other) return other;
  if (ordinary.writeRefusal) refuse(`${author} may not write this fix: ${ordinary.writeRefusal}`);
  return null;
}

// ---- the checks ------------------------------------------------------------------------------------------------------------------------
async function liveFixJobs(team, number) {
  const live = [];
  for (const [id, record] of Object.entries(team.s.jobs)) {
    if (!WRITING.has(record.kind) || record.pr !== number) continue;
    const job = await team.jobs.get(id).catch(() => null);
    if (job && !ENDED.has(job.status)) live.push(id.slice(0, 8));
  }
  return live;
}

// The open pull request this grant is for, with every refusal that does not need a model. Throws; nothing is changed.
async function checkedPull(team, number, authorOf) {
  const pr = (await team.gh.listPulls()).find(p => p.number === number);
  if (!pr) refuse(`PR #${number} is not open; nothing changed`);
  if (!authorOf(pr.headRefName) || !SHA.test(pr.headRefOid)) refuse(`PR #${number} is not a Foreman pull request with a usable head`);
  const rejected = team.s.verdicts[`${number}:${pr.headRefOid}`]?.verdict === 'CHANGES' || team.ciState(pr) === 'red';
  if (!rejected) refuse(`PR #${number} has no CHANGES verdict or red CI on its current head; nothing to fix`);
  const live = await liveFixJobs(team, number);
  if (live.length) refuse(`PR #${number} has a fix job that has not ended (${live.join(', ')})`);
  const prior = team.s.extraFix?.[number];
  if (prior?.head === pr.headRefOid) refuse(`PR #${number} already had its extra fix round at this head${prior.spent ? '' : ' and it has not started yet'}`);
  return pr;
}

// The approved action. Returns the outcome text for the item's status; a refusal throws and the item ends failed with the reason.
export async function extraFixRound(team, { target, model, reason }, authorOf) {
  const number = Number(target);
  const pr = await checkedPull(team, number, authorOf);
  const agent = authorOf(pr.headRefName);
  if (!team.c.agents[agent]) refuse(`${agent} is not a configured worker`);
  if (team.limitedOf(agent)?.out) refuse(`${agent} is out of allowance`);
  const chosen = model ? requestedModel(team, pr, agent, model) : defaultModel(team, pr, agent);
  const at = team.clock.now();
  (team.s.extraFix ||= {})[number] = { head: pr.headRefOid, agent, ...(chosen ? { model: chosen } : {}), spent: false, by: 'homeowner', at, why: reason };
  team.save();
  const where = `${agent}${chosen ? ` on ${chosen}` : ''}`;
  team.logUnblock({}, { tk: 'pull', target: number, what: `allowed one more fix round, written by ${where}`,
    why: `homeowner approved on the dashboard: ${reason}`, result: `granted at ${pr.headRefOid.slice(0, 7)}` });
  return `PR #${number} may have one more fix job at ${pr.headRefOid.slice(0, 7)}, written by ${where}; the fix limit and churn stop apply again after it`;
}

// Returns null for every other action, so the team's inbox pass can try it before its own switch.
export const extraFixApproved = (team, item, authorOf) => (item.action === 'extra_fix_round' ? extraFixRound(team, item, authorOf) : null);
