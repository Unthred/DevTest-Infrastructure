// Issue #1256: the overview model, GET /api/v1/overview. One read that answers: is it working, what needs the homeowner, what is stuck and why.
// Waits for the homeowner (needs_you) and faults are kept apart by the attention table; a stall is an idle agent with a held planned action.
// The verdict is the app bar's own system condition, so the two cannot disagree. No agent or provider name is in here.
import { classify } from '../attention.mjs';
import { agentCondition, build as buildAppbar, heldOf } from './appbar.mjs';

export const name = 'overview';
export const path = 'overview';
export const schema = 'overview.schema.json';

const DAY_S = 24 * 3600;
const WEEK_S = 7 * DAY_S;
const LISTS = { 'inbox-waiting': { model: 'inbox', filter: { state: 'waiting_for_approval' } } };
const ISSUE_TYPES = ['implement', 'continue'];

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const list = value => (Array.isArray(value) ? value : []);
const fraction = (part, whole) => (whole > 0 ? Math.round((part / whole) * 10000) / 10000 : null);
const condition = (state, attention, reasonCode = null, reasonText = null, since = null) => (
  { state, attention, reason_code: reasonCode, reason_text: reasonText, since }
);

// A ref to an issue, a pull request ("change") or a job. Title and link come from the rows the view holds; an unknown item still gets a ref.
function refOf(view, kind, id) {
  const urls = view.refs?.[kind === 'change' ? 'pr' : kind] || {};
  const rows = kind === 'change' ? list(view.prs) : kind === 'issue' ? list(view.issues) : [];
  const row = rows.find(r => r.number === id);
  const key = kind === 'job' ? String(id) : `${kind}-${id}`;
  const label = kind === 'job' ? String(id) : `${kind === 'change' ? 'PR' : 'issue'} #${id}`;
  return { kind, key, label, title: row?.title ?? null, source: null, project: null, url: urls[id]?.url ?? row?.url ?? null };
}

// The other side of an overlap hold, when the ledger reason names it ("the running or planned job for issue #7 ... also edits").
function heldByOf(view, held) {
  if (held.kind !== 'overlap') return null;
  const m = /job for issue #(\d+)/i.exec(String(held.reason ?? ''));
  return m ? refOf(view, 'issue', Number(m[1])) : null;
}

function plannedAction(view, held) {
  const unrecorded = held.kind === 'unexplained';
  const target = Number.isSafeInteger(held.ref) ? refOf(view, ISSUE_TYPES.includes(held.type) ? 'issue' : 'change', held.ref) : null;
  return {
    type: String(held.type ?? ''),
    agent: held.agent ?? null,
    target,
    condition: condition('held', unrecorded ? 'fault' : 'none', unrecorded ? 'unrecorded' : String(held.kind ?? 'unrecorded'), held.reason ?? null),
    held_by: heldByOf(view, held),
  };
}

function stallsOf(view, now) {
  const held = heldOf(view);
  const stalls = [];
  for (const a of list(view.agents)) {
    const own = held.filter(h => h.agent === a.name);
    if (a.state !== 'idle' || !own.length) continue;
    const idle = Number.isFinite(a.lastActivityAt) ? Math.max(0, Math.floor((now - a.lastActivityAt) / 1000)) : null;
    stalls.push({ agent: a.name, idle_seconds: idle, condition: agentCondition(a, own), planned: own.length, actions: own.map(h => plannedAction(view, h)) });
  }
  return stalls;
}

function targetOf(view, item) {
  const n = item.ref?.n;
  if (Number.isSafeInteger(n) && item.ref.kind === 'pull') return refOf(view, 'change', n);
  if (Number.isSafeInteger(n) && item.ref.kind === 'issue') return refOf(view, 'issue', n);
  return item.id.startsWith('job-') ? refOf(view, 'job', item.id.slice(4, 12)) : null;
}

export function attentionItem(view, item, c) {
  const state = c.attention === 'homeowner' ? 'waiting' : c.attention;
  const dead = c.attention === 'homeowner' && !c.actions.length && !c.step_text && !LISTS[item.id];
  return {
    id: item.id,
    kind: c.kind,
    title: String(item.text ?? ''),
    condition: dead
      ? condition('fault', 'fault', 'dead_end', 'The item waits for the homeowner but offers no control, no step and no list.', iso(item.since))
      : condition(state, c.attention, c.reason_code, String(item.text ?? ''), iso(item.since)),
    target: targetOf(view, item),
    actions: c.actions,
    step_text: c.step_text,
    count: LISTS[item.id] ? Math.max(1, list(view.panels?.inbox).length) : 1,
    list: LISTS[item.id] ?? null,
  };
}

// The names of the commands the loaded route modules export, the same source the meta model reads. A commands export that is not a list adds none.
function knownCommandsOf(routes) {
  const names = list(routes).flatMap(r => list(r?.commands).map(c => c?.name));
  return names.filter(n => typeof n === 'string' && n);
}

function attentionOf(view, routes) {
  const known = knownCommandsOf(routes);
  const needsYou = [];
  const faults = [];
  for (const item of list(view.panels?.needsYou)) {
    const entry = attentionItem(view, item, classify(item, known));
    (entry.condition.attention === 'homeowner' ? needsYou : faults).push(entry);
  }
  return { needs_you: needsYou, faults };
}

function slotsOf(view) {
  const by_role = list(view.slots).map(s => ({ role: s.role, max: s.capacity || 0, in_use: list(s.held).length }));
  return { max: by_role.reduce((n, r) => n + r.max, 0), in_use: by_role.reduce((n, r) => n + r.in_use, 0), by_role };
}

function pipelineOf(view) {
  const prs = list(view.prs);
  const stage = (id, count) => ({ stage: id, count });
  return [
    stage('issues_open', list(view.issues).filter(i => i.state === 'OPEN').length),
    stage('changes_open', prs.filter(p => p.status === 'open' || p.status === 'draft').length),
    stage('in_review', prs.filter(p => p.awaitingReview).length),
    stage('merged', prs.filter(p => p.stage === 'merged').length),
    stage('installed', prs.filter(p => p.stage === 'installed').length),
    stage('verified', prs.filter(p => p.stage === 'verified').length),
  ];
}

function headlineOf(view, now) {
  const cards = view.headline?.windows?.['24h']?.cards || {};
  const approved = cards['first-pass']?.approved ?? 0;
  const reviewed = cards['first-pass']?.reviewed ?? 0;
  const from = now - DAY_S * 1000;
  return {
    window_seconds: DAY_S,
    first_pass: { approved, reviewed, fraction: fraction(approved, reviewed) },
    merges: cards['merge-rate']?.merged ?? 0,
    jobs_run: list(view.jobs).filter(j => Number.isFinite(j.startedAt) && j.startedAt > from && j.startedAt <= now).length,
  };
}

function wasteOf(view) {
  const w = view.wasteCauses || { jobs: 0, tokens: 0, causes: [] };
  const top = w.causes[0] || null;
  const topCause = top && {
    code: top.cause,
    text: `${top.jobs} wasted job${top.jobs === 1 ? '' : 's'} of this cause in the last 7 days.`,
    fraction: w.tokens > 0 ? fraction(top.tokens, w.tokens) : 0,
    tokens: top.tokens,
    changes: top.prs,
  };
  return { window_seconds: WEEK_S, jobs: w.jobs, tokens: w.tokens, top_cause: topCause };
}

function hostOf(view) {
  const h = view.hostPressure || {};
  if (h.hold) return condition('held', 'fault', 'host_pressure', h.reason ?? null);
  if (!Number.isFinite(h.readAt)) return condition('unknown', 'unknown', 'no_reading', 'No host pressure reading has been recorded.');
  const warning = list(h.warnings)[0];
  return warning ? condition('warning', 'none', 'host_warning', String(warning), iso(h.readAt)) : condition('ok', 'none', null, null, iso(h.readAt));
}

export function build(view, context) {
  return {
    verdict: buildAppbar(view, context).system,
    stalls: stallsOf(view, context.now),
    ...attentionOf(view, context.routes),
    slots: slotsOf(view),
    planned: heldOf(view).map(h => plannedAction(view, h)),
    pipeline: pipelineOf(view),
    headline: headlineOf(view, context.now),
    waste: wasteOf(view),
    host: hostOf(view),
  };
}
