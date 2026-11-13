// Issue #1167: the comparisons and wording around a capacity figure. Pure functions over plain numbers.
// A hand-set capacity wins over the learned one; the learned one is kept only to compare against.
export const DISAGREE_FACTOR = 2;

// What the token count means, shown beside every capacity figure.
export const UNITS_NOTE = 'tokens are input plus output as the supervisor counts them; '
  + 'provider percentages may weight cached and model tokens differently';

export const tokensText = n => {
  if (!Number.isFinite(n)) return 'unknown';
  return `${n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`} tokens`;
};

const valid = n => Number.isFinite(n) && n > 0;
const disagrees = (a, b) => valid(a) && valid(b) && Math.max(a, b) / Math.min(a, b) > DISAGREE_FACTOR;
const timesText = (a, b) => `${(Math.max(a, b) / Math.min(a, b)).toFixed(1)} times ${a > b ? 'higher' : 'lower'}`;

// Warning when the configured and learned capacities differ by more than a factor of 2; null otherwise or when either is missing.
export function configuredWarning(configured, learned) {
  if (!disagrees(configured, learned)) return null;
  return `configured ${tokensText(configured)} a week and learned ${tokensText(learned)} a week differ by more than `
    + `a factor of ${DISAGREE_FACTOR} (configured is ${timesText(configured, learned)}); the configured value is used`;
}

// The current window: tokens spent this window divided by this window's rise in use, against the learned capacity.
// `current` is { tokens, delta } of the window; null when it moved too little to say, or when it agrees within a factor of 2.
export function dailyCheck({ current, learned, minDelta }) {
  if (!valid(learned) || !current || !(current.delta >= minDelta)) return null;
  const implied = current.tokens / current.delta;
  if (!disagrees(implied, learned)) return null;
  const share = `${tokensText(current.tokens)} for ${Math.round(current.delta * 1000) / 10}% of use`;
  return `this window so far implies about ${tokensText(implied)} a week (${share}), `
    + `${timesText(implied, learned)} than the learned ${tokensText(learned)}`;
}

const resetText = ms => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

export function shortWindowText(w) {
  if (!w || !Number.isFinite(w.used)) return null;
  const reset = Number.isFinite(w.resetsAt) ? `, resets ${resetText(w.resetsAt)} UTC` : '';
  return `short window ${Math.round(w.used * 100)}% used${reset}`;
}
