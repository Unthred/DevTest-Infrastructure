// Issue #1415: the priority tier of an issue, read from its body. Pure functions of the issue text; nothing here reads or changes state.
// A line of its own reading `Tier: <digit 0-6>` gives the tier (0 broken or blocking ... 6 quality of life). No line is tier 4, and a
// "Review follow-ups" title is tier 6 unless the body has its own valid line. Anything else on a Tier line is ignored and reported as a warning.
export const DEFAULT_TIER = 4;
export const FOLLOW_UP_TIER = 6;
const VALID_LINE = /^Tier: ([0-6])$/;
const TIER_LINE = /^\s*Tier\s*:/i;
const FOLLOW_UPS_TITLE = /^\s*Review follow-ups/i;

// Returns { tier, warning }. `warning` is null unless a Tier line was present but could not be used.
// The dashboard cache drops bodies, so compactIssues stores the result as `tierRead`; it is used when the body is absent.
export function readTier(issue) {
  if (issue?.tierRead && issue.body === undefined) return issue.tierRead;
  const lines = String(issue?.body || '').split(/\r?\n/).map(l => l.trim()).filter(l => TIER_LINE.test(l));
  const fallback = FOLLOW_UPS_TITLE.test(String(issue?.title || '')) ? FOLLOW_UP_TIER : DEFAULT_TIER;
  if (lines.length === 1 && VALID_LINE.test(lines[0])) return { tier: Number(VALID_LINE.exec(lines[0])[1]), warning: null };
  if (!lines.length) return { tier: fallback, warning: null };
  const why = lines.length > 1 ? `${lines.length} Tier lines` : `"${lines[0].slice(0, 40)}" is not "Tier: <digit 0 to 6>"`;
  return { tier: fallback, warning: `Tier line ignored (${why}); using tier ${fallback}` };
}

// Issue numbers ordered by tier, lowest first, then by number.
export function orderByTier(issues) {
  return issues.map(i => ({ number: i.number, tier: readTier(i).tier })).sort((a, b) => a.tier - b.tier || a.number - b.number).map(x => x.number);
}
