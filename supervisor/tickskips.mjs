// Issue #1119: a tick that correctly skips work is healthy. A skipped item names its kind in `deliberate`; only a kind in this closed set
// is a deliberate skip. Anything else (no kind, an unknown kind, an exception text) is a real error, and an unknown kind is named so a
// misspelt or new kind is never hidden as healthy.
export const DELIBERATE_SKIPS = Object.freeze(['usage_limit', 'reserve', 'parked_agent', 'admission_refusal', 'dependency_wait']);

const isDeliberateKind = kind => DELIBERATE_SKIPS.includes(kind);

// Splits a tick's skipped items into deliberate skips and real errors. The older `expected` flag still means deliberate.
export function classifySkips(skipped) {
  const items = Array.isArray(skipped) ? skipped : [];
  const deliberate = [];
  const errors = [];
  for (const item of items) {
    if (item?.expected === true || isDeliberateKind(item?.deliberate)) {
      deliberate.push(item);
      continue;
    }
    const unknown = item?.deliberate !== undefined && item?.deliberate !== null;
    errors.push(unknown ? { ...item, reason: `unknown skip reason "${String(item.deliberate).slice(0, 40)}": ${item.reason}` } : item);
  }
  return { deliberate, errors };
}

const line = item => `${item.what}: ${item.reason}`;

// The tick status for the dashboard and foreman_status. Skips are listed with their reasons and never make the status error.
export function skipOutcome(skipped) {
  const { deliberate, errors } = classifySkips(skipped);
  const skips = deliberate.slice(0, 10).map(item => ({ what: String(item.what || '').slice(0, 100), reason: String(item.reason || '').slice(0, 200) }));
  const listed = skips.length ? { skips } : {};
  if (!errors.length) return { status: 'ok', ...listed };
  return { status: 'error', error: `${errors.length} action(s) skipped: ${errors.map(line).join('; ')}`.slice(0, 300), ...listed };
}

// A rollback latch written before this change, whose only cause was deliberate usage-limit skips, is stale: clear it once.
// Recognised by the exact recorded text, and only when every one of the counted skips is shown and is a usage-limit refusal.
const LEGACY_LATCH = /^live tick failed: (\d+) action\(s\) skipped: (.*)$/;
const LEGACY_USAGE_SKIP = /^[^;]+: not started: \S+ reached its usage limit/;
export function latchIsOnlyDeliberateSkips(latch) {
  const match = LEGACY_LATCH.exec(String(latch?.reason || ''));
  if (!match) return false;
  const segments = match[2].split('; ');
  return segments.length === Number(match[1]) && segments.every(s => LEGACY_USAGE_SKIP.test(s));
}

// Issue #302: what a live tick says about the new version. Only a thrown error or a real-error skip fails it. A lease held by a
// running job is an expected wait (reported under `waiting`); a deliberate skip passes. Items needing the homeowner are `blocked`.
export function liveTickOutcome(tick) {
  if (tick?.error) return { ok: false, reason: tick.error };
  const { errors } = classifySkips(tick?.skipped);
  return errors.length ? { ok: false, reason: errors[0]?.reason } : { ok: true, reason: null };
}

// A job that did not start because its agent is out of allowance (D-019): retried when allowance returns, never a failure.
export function usageLimitSkip(act, limit) {
  const why = String(limit?.reason || 'usage limit').slice(0, 120);
  return { what: `${act.type} ${act.pr ?? act.issue} (${act.agent})`, deliberate: 'usage_limit',
    reason: `not started: ${act.agent} reached its usage limit (${why}); it is retried when allowance returns` };
}

// Clears a rollback latch that only deliberate skips caused, and records it. Returns true when the latch was cleared.
export function dropStaleLatch(upgrader) {
  const latch = upgrader.latch();
  if (!latchIsOnlyDeliberateSkips(latch)) return false;
  upgrader.clearLatch();
  upgrader.record({ from: latch.from, to: latch.to, result: 'latch_cleared', reason: 'the rollback was caused only by deliberate skips (usage limit)' });
  return true;
}
