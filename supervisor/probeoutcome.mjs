// Issue #1330: what a requested allowance refresh found, as one of four outcomes and one plain sentence for the agent's card.
// The outcome travels in the redirect's query (probe=, agent=, reason=); only the codes below are ever turned into words, so a typed URL says nothing else.
export const OUTCOMES = ['new', 'nothing-newer', 'refused', 'failed'];
const REASONS = { 'session-failed': 'the minimal session did not finish', 'no-reading': 'no allowance reading could be found afterwards', busy: 'another refresh for this provider is already running',
  unsupported: 'this provider has no way to refresh its reading' };

// The result of probeNow as { outcome, reason }. Pure.
export function probeOutcome(out) {
  if (out?.ok) return { outcome: OUTCOMES.includes(out.outcome) ? out.outcome : 'new', reason: '' };
  if (out?.error === 'overage-risk') return { outcome: 'refused', reason: '' };
  return { outcome: 'failed', reason: Object.hasOwn(REASONS, out?.error) ? out.error : '' };
}

// The outcome a page request carries for one agent, or null. Pure.
export function outcomeFromQuery(query, agent) {
  const outcome = query.get('probe');
  if (query.get('agent') !== agent || !OUTCOMES.includes(outcome)) return null;
  const reason = query.get('reason');
  return { outcome, reason: Object.hasOwn(REASONS, reason) ? reason : '' };
}

// One sentence. h: { esc, lt, ago }; u: the card's reading ({ observedAt }).
export function outcomeSentence({ outcome, reason }, u, now, h) {
  const at = `${h.lt(u.observedAt)} (${h.esc(h.ago(u.observedAt, now))})`;
  if (outcome === 'new') return `Refresh finished: a new reading was observed at ${at}.`;
  if (outcome === 'nothing-newer') return `Refresh found no newer reading: the provider has recorded none since the last one, taken at ${at}.`;
  if (outcome === 'refused') return 'Refresh was not run: the latest reading shows paid overage could be drawn on, and a refresh never spends it.';
  return `Refresh failed: ${REASONS[reason] || 'an unexpected error stopped it'}. The last reading was taken at ${at}.`;
}

// The sentence as a paragraph for the agent's card ('' when no refresh was just asked for). h: { esc, lt, ago }.
export const outcomeNote = (outcome, u, now, h) => (outcome
  ? `<p class="probe-outcome" role="status" data-outcome="${h.esc(outcome.outcome)}">${outcomeSentence(outcome, u, now, h)}</p>` : '');

// What the dashboard answers a refresh with: the Usage page, told which agent and what was found (issue #1330).
export function outcomeRedirect(agent, out) {
  const { outcome, reason } = probeOutcome(out);
  return { body: `${outcome}\n`, location: `/usage?probe=${outcome}&agent=${agent}${reason ? `&reason=${reason}` : ''}` };
}
