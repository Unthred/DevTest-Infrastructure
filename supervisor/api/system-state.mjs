// Issue #1253: the one condition of the whole system, as a pure function of plain data. The app bar model uses it now and the overview
// model will use it later, so there is a single rule. Nothing here reads a file, the clock or the network. No agent name is in here.
// Rule, in this order: breaker halted, no tick known, stalled, then running, paused, idle. A waiting card must never hide a stall.
export const STALL_AFTER_MS = 15 * 60000;

const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const condition = (state, attention, reasonCode, reasonText, since) => (
  { state, attention, reason_code: reasonCode, reason_text: reasonText, since: iso(since) }
);

// jobs: [{ status, startedAt, endedAt }] (ms; endedAt is null while running). held: the planned actions the tick ledger holds, [{ kind }].
// breaker: { halted, text, since } or null. tickKnown: false when no tick has been recorded. paused: some agent is paused.
export function systemCondition({ breaker = null, tickKnown, jobs = [], held = [], paused = false, now }) {
  if (breaker?.halted) return condition('halted', 'fault', 'breaker_halt', breaker.text ?? 'The circuit breaker has halted new work.', breaker.since ?? null);
  if (!tickKnown) return condition('unknown', 'unknown', 'no_tick', 'No tick has been recorded yet, so the state of the system is not known.', null);
  const running = jobs.filter(j => j.status === 'running');
  const starts = jobs.map(j => j.startedAt).filter(Number.isFinite);
  const quietMs = starts.length ? now - Math.max(...starts) : Infinity;
  if (!running.length && held.length && quietMs >= STALL_AFTER_MS) {
    const code = held.some(h => h.kind === 'unexplained') ? 'unrecorded' : String(held[0].kind ?? 'unrecorded');
    const ends = jobs.map(j => j.endedAt).filter(Number.isFinite);
    const quiet = Number.isFinite(quietMs) ? `for ${Math.floor(quietMs / 60000)} minutes` : 'yet';
    const text = `${held.length} planned action${held.length === 1 ? ' is' : 's are'} held and no job has started ${quiet}.`;
    return condition('stalled', 'fault', code, text, ends.length ? Math.max(...ends) : null);
  }
  if (running.length) return condition('running', 'none', null, null, Math.min(...running.map(j => j.startedAt).filter(Number.isFinite)));
  if (paused) return condition('paused', 'none', null, null, null);
  return condition('idle', 'none', null, null, null);
}
