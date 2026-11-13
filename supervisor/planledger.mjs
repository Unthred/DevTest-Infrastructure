// Issue #1223: every action the planner plans ends a tick launched or held, and a held one carries exactly one recorded reason.
// An action that is neither is recorded as an unexplained hold and raised as a Needs you item (severity action), so planned work can
// never sit idle without a stated cause. The ledger is the tick's record of that (`planned` in the tick report and snapshot).
import { redact } from './redact.mjs';
import { resumeCheckItems } from './resumefailures.mjs';

export const HOLD_KINDS = Object.freeze(['slot', 'lease', 'overlap', 'allowance', 'reading_stale', 'retry_cap', 'order_guard', 'error',
  'breaker', 'upgrade', 'host_pressure', 'admission', 'unexplained']);
export const UNEXPLAINED_TEXT = 'planned but neither started nor held, and no reason was recorded';
const REASON_CHARS = 300;
const MAX_ENTRIES = 40;

export const breakerHoldText = x => `circuit breaker: ${x.cause === '@global' ? 'wasted usage reached the higher limit' : 'cause ' + x.cause} halted new ${x.action.type} jobs until the homeowner resumes`;

export const keyOf = a => `${a.type}:${a.agent ?? '-'}:${a.pr ?? a.issue ?? '-'}`;

// The kind a recorded hold text belongs to, for a reason that arrives as free text (a skipped item, a lease wait).
export function kindOfReason(text) {
  const t = String(text || '');
  if (/slot full|overall cap/i.test(t)) return 'slot';
  if (/expected to edit|also edits/i.test(t)) return 'overlap';
  if (/retry cap/i.test(t)) return 'retry_cap';
  if (/circuit breaker/i.test(t)) return 'breaker';
  if (/reading/i.test(t) && /stale|could not be read|older/i.test(t)) return 'reading_stale';
  if (/usage limit|out of allowance|allowance|reserve/i.test(t)) return 'allowance';
  if (/order guard|queue order|config file/i.test(t)) return 'order_guard';
  if (/lease|waiting for job/i.test(t)) return 'lease';
  return 'error';
}

export class PlanLedger {
  // reasonOf(action) returns the hold text the planner already noted for the action, or null.
  constructor(actions, reasonOf = () => null) {
    this.reasonOf = reasonOf;
    this.rows = new Map();
    for (const a of actions) this.rows.set(keyOf(a), { type: a.type, agent: a.agent ?? null, ref: a.pr ?? a.issue ?? null, outcome: null });
  }
  row(act) { return this.rows.get(keyOf(act)); }
  launched(act) { const r = this.row(act); if (r) Object.assign(r, { outcome: 'launched', kind: null, reason: null }); }
  held(act, kind, reason) {
    const r = this.row(act);
    if (r) Object.assign(r, { outcome: 'held', kind, reason: redact(reason || UNEXPLAINED_TEXT, REASON_CHARS) });
  }
  // A stage that dropped actions from the list: whatever it dropped is held for `kind`, with the planner's note or `fallback` as the text.
  filtered(kind, before, after, fallback) {
    const kept = new Set(after.map(keyOf));
    for (const a of before) if (!kept.has(keyOf(a))) this.held(a, kind, this.reasonOf(a) || fallback);
    return after;
  }
  settle() {
    const out = [];
    for (const r of this.rows.values()) {
      if (!r.outcome) Object.assign(r, { outcome: 'held', kind: 'unexplained', reason: UNEXPLAINED_TEXT });
      out.push({ ...r });
    }
    return out.slice(0, MAX_ENTRIES);
  }
}

// Remembers which planned actions are unexplained holds (since when) until a later tick explains or launches them.
export function recordUnexplained(state, entries, now) {
  const prev = state.unexplainedHolds || {}, next = {};
  for (const e of entries) if (e.kind === 'unexplained') { const k = keyOf(e); next[k] = { ...e, since: prev[k]?.since ?? now }; }
  state.unexplainedHolds = next;
  return Object.values(next);
}

export function unexplainedItems(state) {
  return Object.values(state.unexplainedHolds || {}).map(e => ({
    id: `unexplained-hold-${e.type}-${e.agent ?? 'none'}-${e.ref ?? 'none'}`.slice(0, 80), ref: null, since: e.since,
    text: `Foreman planned ${e.type} for ${e.agent ?? 'no agent'} on #${e.ref} but did not start it, and no reason was recorded (an unexplained hold)`,
    action: 'Run foreman_why_blocked for the item and report the missing reason; this is a Foreman defect.' }));
}

// Needs you items Foreman raises about its own planning: unexplained holds and resume checks that keep throwing.
export const planItems = state => [...unexplainedItems(state), ...resumeCheckItems(state)];

// The hold the planner noted for this one pull request. The list kept per agent and job type joins the holds of other items, so it is
// never used as one item's reason: an action with no hold of its own stays unexplained.
export const heldReasonOf = team => a => team.heldPr?.[`${a.agent}:${a.type}:${a.pr ?? a.issue}`] ?? null;

// Ends a tick's ledger: settles it into the report, remembers unexplained holds for the Needs you list, and hands the tick record
// (dashdata.recordTick reads team.tickLedger) what each planned action did and which resume checks threw.
export function closeLedger(team, report, ledger) {
  report.planned = ledger.settle();
  recordUnexplained(team.s, report.planned, team.clock.now());
  team.tickLedger = { planned: report.planned, resumeChecks: report.resumeChecks };
}
