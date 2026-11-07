// Issue #487: why an agent was idle, by cause. Read-only arithmetic on data the tick and the job records already hold: no model call,
// no GitHub call. The method is the one used for the figures in issue #406 (24 hours to 06:25 on 3 Nov 2026):
//  - a gap runs from the end of an agent's last job to the start of its next one (an agent running any job is busy);
//  - each tick interval inside a gap is classed from the tick log: after a tick that held the agent's work for an upgrade it is
//    `upgrade`; after a tick that named a hold for that agent it is `named-hold`; an interval that ends at the tick that started the
//    job is `waiting-for-tick`; otherwise nothing was eligible (`no-eligible-work`);
//  - the time from the start of the tick that started the job to the job's start is `tick-run` (the 43 and 22 minute rows).
import { redact } from './redact.mjs';
export const IDLE_CAUSES = ['waiting-for-tick', 'upgrade', 'tick-run', 'named-hold', 'no-eligible-work', 'unrecorded'];
// Causes that count as "idle with work available": every one except nothing-to-do and no tick record.
export const WORK_CAUSES = ['waiting-for-tick', 'upgrade', 'tick-run', 'named-hold'];
export const CAUSE_LABEL = { 'waiting-for-tick': 'waiting for the next tick', upgrade: 'upgrade pending or draining', 'tick-run': 'tick run time before the job started',
  'named-hold': 'a named hold', 'no-eligible-work': 'no eligible work', unrecorded: 'no tick record' };
// Issue #530: a hold is grouped by its cause, not its display text. The live figures in a text (weekly %, projected %, days or hours
// left, a reset time, the rate source) change on every reading, so they are masked to form the key; identifiers such as "PR #9" stay,
// because a different PR is a different cause. The report shows the latest text of each cause once, with the total time.
// Issue #719: a text of several holds is joined with ' | '. It is split so each part is masked on its own and the distinct parts are
// sorted: a different mix or order of the same holds is then one cause per part set. A bare count (not after '#') changes on every
// reading ("10 open PRs (cap 10); 12 more waiting"), so it is masked too; "PR #9" keeps its number. The masked key is cut at a fixed
// length AFTER masking, so a figure that changes width never moves the cut.
// HOLD_KEY_CHARS must stay well below HOLD_REASON_CHARS: classifyIdle cuts each raw reason at HOLD_REASON_CHARS (redact) BEFORE masking, and
// the key is stable only because masking that many raw characters still leaves more than HOLD_KEY_CHARS, so the post-mask cut decides it.
export const HOLD_KEY_CHARS = 200;
export const HOLD_REASON_CHARS = 300;
// Overall display cap for the joined hold text, applied at a part boundary (issue #813). The key is formed from the uncapped text first.
export const HOLD_TEXT_CHARS = 600;
const maskHold = part => String(part)
  .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b/g, '~').replace(/\b\d{1,2}:\d{2}\b/g, '~')
  .replace(/\d+(?:\.\d+)?\s*(?:%|days?|hours?|hrs?|h|min(?:ute)?s?)(?![A-Za-z])/g, '~')
  .replace(/\((?:~[^()]*)?(?:window average|recent)[^()]*\)/g, '(~)')
  .replace(/(?<![#\w.~])\d+(?:\.\d+)?(?!\w)/g, '~')
  .replace(/\s+/g, ' ').trim().slice(0, HOLD_KEY_CHARS);
export const holdCause = text => [...new Set(String(text ?? '').split(' | ').map(maskHold).filter(Boolean))].sort().join(' | ');
const ACTIVE = new Set(['queued', 'running', 'paused_limit', 'paused_manual']);
const MIN = 60000;

// One tick: the cause recorded for each agent that is idle when the tick ends. `heldAgents` are the agents whose planned work the upgrade
// hold dropped (null when no upgrade hold applied), `holds` is the planner's per-agent hold text ({ agent: { type: text } }), `plan` the
// actions the tick planned. A hold applies to the agent it belongs to, not to every idle agent.
export function classifyIdle({ states, heldAgents = null, holds = {}, plan = [] }) {
  const out = {};
  for (const [agent, s] of Object.entries(states || {})) {
    if (s !== 'idle') continue;
    const mine = plan.some(p => p.agent === agent && p.type !== 'merge');
    if (heldAgents?.includes(agent)) out[agent] = { cause: 'upgrade' };
    else if (mine) out[agent] = { cause: 'work-planned' };
    else {
      // Each value is itself a ' | '-joined list of reasons (Team.hold), so split it and cut every reason on its own: a figure that
      // changes width then only moves its own reason's cut, and one long reason cannot push the others out (issue #719).
      const parts = Object.values(holds?.[agent] || {}).flatMap(t => String(t).split(' | ')).map(t => t.trim()).filter(Boolean);
      const reasons = [...new Set(parts.map(t => redact(t, HOLD_REASON_CHARS)))];
      const holdKey = holdCause(reasons.join(' | '));
      const shown = [];
      for (const r of reasons) { if (shown.length && [...shown, r].join(' | ').length > HOLD_TEXT_CHARS) break; shown.push(r); }
      const text = shown.join(' | ');
      out[agent] = text ? { cause: 'named-hold', hold: text, ...(shown.length < reasons.length ? { holdKey } : {}) } : { cause: 'no-eligible-work' };
    }
  }
  return out;
}

// Busy intervals of one agent (its provider's jobs), clipped to the window and merged.
export function busyIntervals(jobs, provider, from, to) {
  const spans = [];
  for (const j of jobs || []) {
    if (j?.unreadable || j.provider !== provider || !Number.isFinite(j.createdAt)) continue;
    const end = ACTIVE.has(j.status) ? to : (Number.isFinite(j.updatedAt) ? j.updatedAt : j.createdAt);
    if (end <= from || j.createdAt >= to) continue;
    spans.push([Math.max(j.createdAt, from), Math.min(Math.max(end, j.createdAt), to)]);
  }
  spans.sort((x, y) => x[0] - y[0]);
  const merged = [];
  for (const [a, b] of spans) {
    const last = merged.at(-1);
    if (last && a <= last.end) last.end = Math.max(last.end, b); else merged.push({ start: a, end: b });
  }
  return merged;
}

// Index of the first snapshot with at >= t (binary search; snapshots are sorted).
const firstAtOrAfter = (snaps, t) => { let lo = 0, hi = snaps.length; while (lo < hi) { const m = (lo + hi) >> 1; if (snaps[m].at < t) lo = m + 1; else hi = m; } return lo; };
const mapCause = c => (c === 'work-planned' ? 'waiting-for-tick' : c);

// Minutes idle per agent and cause. `agents` maps agent name to provider. Times are epoch milliseconds.
export function idleBreakdown({ jobs, snapshots, agents, from, to }) {
  const snaps = (snapshots || []).filter(s => Number.isFinite(s?.at)).sort((x, y) => x.at - y.at);
  const out = {};
  for (const [agent, provider] of Object.entries(agents)) {
    const row = { windowMinutes: (to - from) / MIN, busyMinutes: 0, minutes: Object.fromEntries(IDLE_CAUSES.map(k => [k, 0])), holds: {} };
    const latest = {};   // cause key -> the newest text seen (intervals are visited in time order)
    const add = (cause, ms, hold, key) => { row.minutes[cause] += ms / MIN; if (cause === 'named-hold' && hold) { const k = key ?? holdCause(hold); latest[k] = hold; row.holds[k] = (row.holds[k] || 0) + ms / MIN; } };
    const busy = busyIntervals(jobs, provider, from, to);
    let cursor = from;
    const idleSpans = [];
    for (const b of busy) { if (b.start > cursor) idleSpans.push({ a: cursor, b: b.start, starts: true }); row.busyMinutes += (b.end - b.start) / MIN; cursor = Math.max(cursor, b.end); }
    if (cursor < to) idleSpans.push({ a: cursor, b: to, starts: false });
    for (const { a, b, starts } of idleSpans) {
      // The tick that started the job: the first tick record that ends at or after the job's start.
      const startSnap = starts ? snaps[firstAtOrAfter(snaps, b)] : null;
      const t0 = startSnap ? Math.min(b, Math.max(a, Number.isFinite(startSnap.startedAt) ? startSnap.startedAt : b)) : b;
      if (b > t0) add('tick-run', b - t0);
      const cuts = [a]; for (let k = firstAtOrAfter(snaps, a + 1); k < snaps.length && snaps[k].at < t0; k++) cuts.push(snaps[k].at); cuts.push(t0);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const x = cuts[i], y = cuts[i + 1];
        if (y <= x) continue;
        const prev = snaps[firstAtOrAfter(snaps, x + 1) - 1], end = snaps[firstAtOrAfter(snaps, y)];
        const entry = prev?.idle?.[agent];
        let cause, hold = entry?.hold, key = entry?.holdKey;
        if (entry) cause = mapCause(entry.cause);
        else {
          // The previous tick saw the agent running (or there was none): the tick that ends the interval says what held its work.
          const e = end?.idle?.[agent];
          cause = e ? mapCause(e.cause) : end ? 'no-eligible-work' : 'unrecorded'; hold = e?.hold; key = e?.holdKey;
          if (!prev && !e) cause = 'unrecorded';
        }
        if (cause === 'no-eligible-work' && end && end === startSnap) cause = 'waiting-for-tick';
        add(cause, y - x, hold, key);
      }
    }
    row.holds = Object.fromEntries(Object.entries(row.holds).map(([k, m]) => [latest[k], m]));
    out[agent] = row;
  }
  return out;
}

const round1 = n => Math.round(n * 10) / 10;
// The report: per agent, minutes by cause, busy minutes and "idle with work available" as a percent of the window.
export function idleReport({ jobs, snapshots, agents, from, to }) {
  const raw = idleBreakdown({ jobs, snapshots, agents, from, to }), out = {};
  for (const [n, r] of Object.entries(raw)) {
    const withWork = WORK_CAUSES.reduce((t, k) => t + r.minutes[k], 0);
    out[n] = { windowMinutes: round1(r.windowMinutes), busyMinutes: round1(r.busyMinutes), minutes: Object.fromEntries(IDLE_CAUSES.map(k => [k, round1(r.minutes[k])])),
      holds: Object.fromEntries(Object.entries(r.holds).map(([k, v]) => [k, round1(v)])), idleWithWorkMinutes: round1(withWork), idleWithWorkPercent: r.windowMinutes > 0 ? round1(withWork / r.windowMinutes * 100) : 0 };
  }
  return { from, to, agents: out };
}

export function renderIdleReport(rep) {
  const lines = [`Idle time by cause, ${new Date(rep.from).toISOString()} to ${new Date(rep.to).toISOString()} (minutes)`];
  for (const [n, r] of Object.entries(rep.agents)) {
    lines.push(`${n}: busy ${r.busyMinutes} of ${r.windowMinutes}; idle with work available ${r.idleWithWorkMinutes} (${r.idleWithWorkPercent}%)`);
    for (const k of IDLE_CAUSES) lines.push(`  ${CAUSE_LABEL[k]}: ${r.minutes[k]}`);
    for (const [h, m] of Object.entries(r.holds)) lines.push(`  hold "${h}": ${m}`);
  }
  return lines.join('\n');
}

// Issue #406: passes by trigger. A recorded tick is one pass; `trigger` says what started it (a record from before wakes existed has none and
// was scheduled). A pass "started something" when it planned at least one action; "did nothing" when its plan was empty. `unlabelled`
// counts the records that carried no trigger so the figure says how much of it is measured per trigger and how much is inferred.
export const PASS_TRIGGERS = ['schedule', 'job-end', 'install', 'inbox', 'approve'];
export function passStats(snapshots, from, to) {
  const by = Object.fromEntries(PASS_TRIGGERS.map(k => [k, { passes: 0, startedSomething: 0, didNothing: 0, noop: 0 }]));
  let unlabelled = 0, errors = 0;
  const secs = { all: [], noop: [], didNothingFull: [] }, calls = { noop: [], other: [] };   // issue #755
  for (const s of snapshots || []) {
    if (!Number.isFinite(s?.at) || s.at < from || s.at > to) continue;
    const labelled = PASS_TRIGGERS.includes(s.trigger), key = labelled ? s.trigger : 'schedule';
    if (!labelled) unlabelled++;
    if (s.status === 'error') errors++;
    const row = by[key]; row.passes++;
    const nothing = !(Array.isArray(s.plan) && s.plan.length);
    if (!nothing) row.startedSomething++; else row.didNothing++;
    if (s.noop === true) row.noop++;
    if (Number.isFinite(s.startedAt) && s.at >= s.startedAt) { const d = (s.at - s.startedAt) / 1000; secs.all.push(d); if (s.noop === true) secs.noop.push(d); else if (nothing) secs.didNothingFull.push(d); }
    if (Number.isSafeInteger(s.ghCalls)) (s.noop === true ? calls.noop : calls.other).push(s.ghCalls);
  }
  const median = a => { if (!a.length) return null; const b = [...a].sort((x, y) => x - y); return b[Math.floor((b.length - 1) / 2)]; };
  const total = Object.values(by).reduce((t, r) => t + r.passes, 0), empty = Object.values(by).reduce((t, r) => t + r.didNothing, 0);
  const noop = Object.values(by).reduce((t, r) => t + r.noop, 0);
  // noop = ended early because GitHub was proved unchanged (issue #755). Durations run from the start of the team step to its record; gh figures only from records that carry them.
  return { total, didNothing: empty, noop, errors, unlabelled, byTrigger: by, seconds: { median: median(secs.all), medianNoop: median(secs.noop), medianDidNothingFull: median(secs.didNothingFull) }, ghCalls: { medianNoop: median(calls.noop), medianOther: median(calls.other), recorded: calls.noop.length + calls.other.length } };
}
export function renderPassStats(p) {
  const lines = [`Passes: ${p.total} recorded, ${p.didNothing} did nothing (${p.total ? Math.round(p.didNothing / p.total * 100) : 0}%); ${p.unlabelled} carried no trigger (counted as scheduled)`];
  for (const k of PASS_TRIGGERS) { const r = p.byTrigger[k]; if (r.passes) lines.push(`  ${k}: ${r.passes} passes, ${r.startedSomething} started something, ${r.didNothing} did nothing${r.noop ? `, ${r.noop} ended early as unchanged` : ''}`); }
  const sec = x => (x == null ? 'n/a' : `${Math.round(x)} s`), q = p.seconds || {}, g = p.ghCalls || {};
  lines.push(`Ended early as unchanged (no-op): ${p.noop || 0} passes; median ${sec(q.medianNoop)} (a full pass that did nothing: ${sec(q.medianDidNothingFull)}; any pass: ${sec(q.median)})`);
  if (g.recorded) lines.push(`gh processes per pass (median, from ${g.recorded} records that carry the count): no-op ${g.medianNoop ?? 'n/a'}, other ${g.medianOther ?? 'n/a'}`);
  return lines.join('\n');
}
