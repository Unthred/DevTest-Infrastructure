// Issue #1223: starts the planned actions of a tick one by one and records, for each, that it launched or why it did not.
// A launch is seen as evidence: a new job record, or (a merge or inbox item) no skip, wait, block or warning recorded for it.
import { usageLimitSkip } from './tickskips.mjs';
import { kindOfReason, heldReasonOf } from './planledger.mjs';
import { rereadForMerge } from './mergebatch.mjs';

const KIND_OF_SKIP = { usage_limit: 'allowance', parked_agent: 'allowance', reserve: 'allowance', admission_refusal: 'admission', dependency_wait: 'order_guard' };
const JOBLESS = new Set(['merge', 'inbox']);
const LISTS = ['skipped', 'waiting', 'blocked', 'warnings', 'notified', 'recovered'];

const sizes = report => Object.fromEntries(LISTS.map(k => [k, (report[k] || []).length]));
const grown = (before, report) => LISTS.find(k => (report[k] || []).length > before[k]);

// What a start attempt left behind: { kind, reason } when held, null when it launched, 'none' when it left nothing at all.
export function outcomeOfAttempt(team, report, before, jobsBefore, act) {
  const list = grown(before, report);
  if (list) {
    const item = report[list].at(-1) || {};
    const reason = String(item.reason || item.warning || item.what || list);
    if (list === 'skipped') return { kind: KIND_OF_SKIP[item.deliberate] || 'error', reason };
    if (list === 'waiting') return { kind: 'lease', reason };
    if (list === 'blocked') return { kind: kindOfReason(reason) === 'lease' ? 'lease' : 'error', reason };
    if (list === 'warnings') return { kind: 'order_guard', reason };
    return null;
  }
  if (JOBLESS.has(act.type) || Object.keys(team.s.jobs).length > jobsBefore) return null;
  return 'none';
}

export async function launchPlanned(team, actions, report, { guard, lap, ledger, refresh }) {
  let merges = 0;
  for (const act of actions) {
    if (act.type === 'merge' && merges++ > 0) {   // issue #1410: main moved with the earlier merge; read this pull request again first
      const stale = await rereadForMerge(team.gh, act);
      if (stale) { ledger.held(act, 'order_guard', `order guard: not merged this pass, ${stale}; the next pass decides`); continue; }
    }
    // Issue #344: several jobs start in one tick, so the allowance is checked again right before each start; a limit reached while
    // an earlier job was starting holds the rest until the next tick (merges are not jobs).
    const l = act.type !== 'merge' ? (await refresh(team, act)) || team.limitedOf(act.agent) : null;   // issue #1163: refresh first when due
    if (l?.out) {
      const skip = usageLimitSkip(act, l);
      (report.skipped ||= []).push(skip);
      ledger.held(act, 'allowance', skip.reason);
      continue;
    }
    const startSince = Date.now(), before = sizes(report), jobsBefore = Object.keys(team.s.jobs).length;
    await guard(`${act.type} ${act.pr ?? act.issue} (${act.agent})`, () => team.runAction(act, report));
    lap('job launches', startSince);
    const out = outcomeOfAttempt(team, report, before, jobsBefore, act);
    if (out === null) ledger.launched(act);
    else if (out !== 'none') ledger.held(act, out.kind, out.reason);
    else noteRecordedHold(team, act, ledger);
  }
}

// An attempt that left no trace is still explained when the planner noted a hold for that agent and job type (a slot, an overlap, the
// order guard, a stale reading); with none it stays unexplained, and the ledger settles it as one.
function noteRecordedHold(team, act, ledger) {
  const why = heldReasonOf(team)(act);
  if (why) ledger.held(act, kindOfReason(why), why);
}
