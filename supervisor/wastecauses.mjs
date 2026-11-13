// Issue #1256: the waste of the last 7 days grouped by cause, for the overview read model. Pure: a list of breaker waste records in, figures out.
// A record is { cause, tokens, pr, at }. tokens count only when the CLI reported them; pr is the pull request the wasted job worked on, or null.
export const WASTE_WINDOW_MS = 7 * 24 * 3600000;

const finite = Number.isFinite;

export function wasteCauses(records, now) {
  const kept = (Array.isArray(records) ? records : []).filter(w => w && typeof w === 'object' && finite(w.at) && w.at > now - WASTE_WINDOW_MS && w.at <= now);
  const groups = new Map();
  for (const w of kept) {
    const cause = String(w.cause || 'unknown');
    const g = groups.get(cause) || { cause, jobs: 0, tokens: 0, prSet: new Set() };
    g.jobs += 1;
    g.tokens += finite(w.tokens) ? w.tokens : 0;
    if (Number.isSafeInteger(w.pr)) g.prSet.add(w.pr);
    groups.set(cause, g);
  }
  const causes = [...groups.values()]
    .map(({ prSet, ...g }) => ({ ...g, prs: prSet.size }))
    .sort((a, b) => b.tokens - a.tokens || a.cause.localeCompare(b.cause));
  return { jobs: kept.length, tokens: causes.reduce((n, c) => n + c.tokens, 0), causes };
}
