// Issue #1248: the envelope every /api/v1/ model reply is wrapped in. Pure: nothing here reads a file or the clock.
export const CONTRACT = '1.0';
export const INITIAL_CURSOR = 'e-0';   // the id of the last change event; fixed until the change stream exists

const iso = ms => new Date(ms).toISOString();

// tickAt is the time (ms) of the last finished tick or null. staleAfterMs is the age past which the data counts as stale.
export function freshnessOf({ tickAt, now, staleAfterMs }) {
  const staleAfterSeconds = Math.round(staleAfterMs / 1000);
  if (!Number.isFinite(tickAt)) {
    return {
      state: 'unknown', tick_at: null, age_seconds: null, stale_after_seconds: staleAfterSeconds,
      reason_code: 'no_tick', reason_text: 'No finished tick has been recorded yet.',
    };
  }
  const ageSeconds = Math.max(0, Math.floor((now - tickAt) / 1000));
  const stale = ageSeconds > staleAfterSeconds;
  return {
    state: stale ? 'stale' : 'fresh', tick_at: iso(tickAt), age_seconds: ageSeconds, stale_after_seconds: staleAfterSeconds,
    reason_code: stale ? 'tick_old' : 'tick_recent',
    reason_text: stale ? `The last finished tick is ${ageSeconds} seconds old.` : 'The last tick finished recently.',
  };
}

export function envelope({ model, data, now, tickAt, staleAfterMs, cursor = INITIAL_CURSOR }) {
  return { contract: CONTRACT, model, generated_at: iso(now), freshness: freshnessOf({ tickAt, now, staleAfterMs }), cursor, data };
}
