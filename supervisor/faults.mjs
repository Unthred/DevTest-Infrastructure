// Issue #1107: infrastructure faults never use attempts. Pure rules, no I/O and no clock of their own:
//  1. classifyEnd: every job end is either a work outcome or an infrastructure fault with a named cause from a fixed list;
//  2. countsAsAttempt: attempts, retry caps, the circuit breaker and fix limits read work outcomes only;
//  3. the park record of one agent (when to probe, when to tell the homeowner, when to release) and the text of its Needs you item.
// An agent that was stopped by a fault has not tried the work. It is parked (not the item); other workers may take the item meanwhile.

export const INFRA_CAUSES = Object.freeze(['auth_error', 'launcher', 'usage_limit', 'network', 'provider_outage', 'host_resources', 'other_infra']);
export const INFRA_LABEL = Object.freeze({
  auth_error: 'sign-in problem', launcher: 'launcher failure', usage_limit: 'usage limit', network: 'network failure',
  provider_outage: 'provider outage', host_resources: 'host resources (disk, memory)', other_infra: 'other infrastructure fault',
});
export const PROBE_BACKOFF_MIN = Object.freeze([5, 15, 30, 60]);   // then hourly
export const RAISE_AFTER_MS = 30 * 60000;
const RECENT_KEEP = 200;

const EVENT_CAUSE = Object.freeze({
  auth_error: 'auth_error', preflight_failed: 'launcher', network_error: 'network', usage_limit: 'usage_limit', transient_rate_limit: 'usage_limit',
});
// Stops that only the agent's own run can produce: the agent ran, so they are work outcomes whatever the token count says.
const WORK_STOPS = new Set(['postcondition_not_met', 'context_limit', 'approval_required', 'idle_timeout']);
const OUTAGE_TEXT = /\b(?:overloaded|overloaded_error|service unavailable|bad gateway|gateway time-?out|outage)\b|\b(?:502|503|504|529)\b/i;
const HOST_TEXT = /\bENOSPC\b|no space left|disk (?:is )?full|\bENOMEM\b|out of memory|cannot allocate memory|\bEDQUOT\b/i;

const num = v => (Number.isFinite(v) && v > 0 ? v : 0);
export const tokensOf = job => num(job?.usage?.inputTokens) + num(job?.usage?.outputTokens);
const work = cause => ({ kind: 'work', cause: String(cause || 'unknown').slice(0, 60) });
const infra = (cause, detail) => ({ kind: 'infra', cause, detail });

// One job end -> { kind: 'work' | 'infra' | 'none', cause, detail? }. 'none' is a deliberate stop (neither a try nor a fault).
// A missing or malformed record ran nothing we can see: infrastructure. An unknown end counts as work only when tokens were spent.
export function classifyEnd(job) {
  const readable = job && typeof job === 'object' && !Array.isArray(job) && typeof job.status === 'string';
  if (!readable) return infra('other_infra', 'the job record is missing or unreadable');
  if (job.status === 'completed') return work('completed');
  // Issue #1109: the stop marker written by the stop command outlasts any later event a dying worker records.
  if (job.lastEvent === 'manual_stop' || (job.status === 'stopped' && job.stop?.reason === 'manual_stop')) return { kind: 'none', cause: 'manual_stop' };
  if (job.status === 'waiting_on') return { kind: 'none', cause: 'waiting_on' };   // stopped on an open prerequisite: neither a try nor a fault
  const reason = job.incompleteReason && typeof job.incompleteReason === 'object' ? job.incompleteReason : {};
  const stop = String(reason.cause || job.lastEvent || job.status);
  const text = `${reason.detail || ''} ${job.error || ''}`;
  if (EVENT_CAUSE[job.lastEvent]) return infra(EVENT_CAUSE[job.lastEvent], `the run stopped on ${job.lastEvent}`);
  if (EVENT_CAUSE[stop]) return infra(EVENT_CAUSE[stop], `the run stopped on ${stop}`);
  if (stop === 'retry_exhausted' && num(job.usageLimitHits) > 0) return infra('usage_limit', 'the allowance retries ran out');
  if (WORK_STOPS.has(stop) || WORK_STOPS.has(job.lastEvent)) return work(stop);
  if (HOST_TEXT.test(text)) return infra('host_resources', 'the host ran out of disk or memory');
  if (OUTAGE_TEXT.test(text)) return infra('provider_outage', 'the provider reported an outage');
  return tokensOf(job) > 0 ? work(stop) : infra('other_infra', `the job ended (${stop.slice(0, 40)}) with no tokens spent`);
}

// Attempts, caps, the breaker and the fix limits count work outcomes only.
export const countsAsAttempt = cls => cls?.kind === 'work';

// ---- the park record: state.infra = { counts, parked, recent } ----
export function normalize(s) {
  s.counts = s.counts && typeof s.counts === 'object' ? s.counts : {};
  s.parked = s.parked && typeof s.parked === 'object' ? s.parked : {};
  s.recent = Array.isArray(s.recent) ? s.recent : [];
  s.released = s.released && typeof s.released === 'object' ? s.released : {};
  return s;
}
export const backoffMs = probes => (PROBE_BACKOFF_MIN[probes] ?? PROBE_BACKOFF_MIN.at(-1)) * 60000;

// Record one fault. A usage limit has its own park rule (D-019: until the reported reset plus 2 minutes), so it is counted but not parked here.
// A fault soon after a release continues the earlier one (same `since`), so a flapping agent still reaches the 30 minute mark.
export function noteFault(s, { agent, cause, job, ref = null, now }) {
  normalize(s);
  s.counts[cause] = (s.counts[cause] || 0) + 1;
  s.recent.push({ agent, cause, job: String(job || '').slice(0, 8), ref, at: now });
  if (s.recent.length > RECENT_KEEP) s.recent.splice(0, s.recent.length - RECENT_KEEP);
  if (cause === 'usage_limit' || !agent) return null;
  const back = s.released[agent];
  const continues = back && back.cause === cause && now - back.at < RAISE_AFTER_MS;
  const rec = s.parked[agent] ||= { cause, since: continues ? back.since : now, probes: 0, nextProbeAt: now + backoffMs(0), faults: 0, items: [] };
  delete s.released[agent];
  rec.cause = cause; rec.faults++;
  if (ref && !rec.items.includes(ref)) rec.items.push(ref);
  if (rec.items.length > 20) rec.items.splice(0, rec.items.length - 20);
  return rec;
}
export const isParked = (s, agent) => !!s?.parked?.[agent];
export const dueProbes = (s, now) => Object.entries(s?.parked || {}).filter(([, r]) => now >= r.nextProbeAt).map(([agent]) => agent);
// The probe result. A pass releases the agent; a fail moves the next probe out along the backoff.
export function noteProbe(s, agent, passed, now) {
  const rec = s.parked?.[agent];
  if (!rec) return null;
  if (passed) { delete s.parked[agent]; (s.released ||= {})[agent] = { cause: rec.cause, since: rec.since, at: now }; return { released: true }; }
  rec.probes++; rec.nextProbeAt = now + backoffMs(rec.probes);
  return { released: false, nextProbeAt: rec.nextProbeAt };
}

const stamp = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
// Needs you items: one per parked agent, only once the fault has lasted 30 minutes. Gone when the agent is released.
export function attentionItems(s, now, fix = (agent, cause) => fixOf(agent, cause)) {
  return Object.entries(s?.parked || {}).filter(([, r]) => now - r.since >= RAISE_AFTER_MS).map(([agent, r]) => ({
    id: `agentfault-${agent}`, agent, cause: r.cause, since: r.since, items: r.items,
    text: `${agent} is parked: ${INFRA_LABEL[r.cause] || r.cause} since ${stamp(r.since)} UTC (${r.faults} job${r.faults === 1 ? '' : 's'} stopped, none counted as an attempt). Waiting: ${r.items.join(', ') || 'nothing named'}.`,
    action: `Fix: ${fix(agent, r.cause)}. Foreman checks again by itself and clears this item when the check passes.`,
  }));
}
export const FIX_TEXT = Object.freeze({
  auth_error: agent => `sign the ${agent} CLI in on Tower`,
  launcher: agent => `check that the ${agent} CLI starts on Tower`,
  network: () => 'check the network connection of Tower',
  provider_outage: () => 'wait for the provider to recover (check its status page)',
  host_resources: () => 'free disk space or memory on Tower',
  other_infra: agent => `check why the ${agent} CLI does not run on Tower`,
});
export const fixOf = (agent, cause) => (FIX_TEXT[cause] || FIX_TEXT.other_infra)(agent);

// Caps set by an infrastructure fault before this version: sameCause records whose cause is an infrastructure cause. Returns their keys.
const LEGACY_INFRA_CAUSES = new Set(['auth_error', 'preflight_failed', 'network_error', 'usage_limit', 'transient_rate_limit']);
export const legacyInfraCaps = (sameCause, cap) => Object.entries(sameCause || {})
  .filter(([, v]) => v && v.count >= cap && LEGACY_INFRA_CAUSES.has(v.cause))
  .map(([key, v]) => ({ key, cause: v.cause, count: v.count }));

// For status: infrastructure faults shown apart from the work failure causes.
export function summary(s, now) {
  normalize(s || {});
  return {
    counts: { ...s.counts },
    parked: Object.entries(s.parked).map(([agent, r]) => ({ agent, ...r, raised: now - r.since >= RAISE_AFTER_MS })),
    recent: s.recent.slice(-10),
  };
}
