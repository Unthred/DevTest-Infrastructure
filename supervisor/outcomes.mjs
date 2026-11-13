// Issue #1307: the outcomes builder. A pure function of the timeline entries, the Needs you list and the window: no GitHub call, no clock,
// no file. For each issue or pull request with activity in the window it returns the ordered steps (a peg and a result), the laps and
// the bin the item ended in. The pegs are implement, ci, review, rebase and merge. Install is not a peg: Foreman records no install
// event per pull request (issue #1307), so nothing here could place one honestly.
export const PEGS = ['implement', 'ci', 'review', 'rebase', 'merge'];
export const BINS = ['merged', 'needs_you', 'failed', 'moving'];
export const MAX_ITEMS = 200;

// A job event that ends an implement or continue job badly. Other job events (created, started, usage_limit, ...) are not a result.
const IMPLEMENT_BOUNCED = new Set(['blocked', 'crash', 'incomplete', 'retry_exhausted', 'auth_error']);
const IMPLEMENT_KINDS = new Set(['implement', 'continue']);
const step = (entry, peg, result) => ({ at: entry.at, peg, result });

// The fixed mapping from one timeline entry to at most one step. An unknown kind or event gives null.
export function stepOf(entry) {
  if (entry.kind === 'verdict') {
    if (entry.verdict === 'PASS') return step(entry, 'review', 'passed');
    return entry.verdict === 'CHANGES' ? step(entry, 'review', 'bounced') : null;
  }
  if (entry.kind === 'merge') return step(entry, 'merge', 'passed');
  if (entry.kind === 'rebase') return step(entry, 'rebase', 'passed');
  if (entry.kind !== 'job') return null;
  if (entry.jobKind === 'cifix') return entry.event === 'created' ? step(entry, 'ci', 'bounced') : null;
  if (entry.jobKind === 'rebase') return entry.event === 'blocked' ? step(entry, 'rebase', 'bounced') : null;   // a completed rebase job is the rebase entry
  if (!IMPLEMENT_KINDS.has(entry.jobKind)) return null;
  if (entry.event === 'completed') return step(entry, 'implement', 'passed');
  return IMPLEMENT_BOUNCED.has(entry.event) ? step(entry, 'implement', 'bounced') : null;
}

// issue number -> pull request number, from every entry that names both and from the dashboard's own pull request rows.
function pullOfIssue(entries, prs) {
  const map = new Map();
  for (const e of entries) if (Number.isSafeInteger(e.issue) && Number.isSafeInteger(e.pr)) map.set(e.issue, e.pr);
  for (const p of prs) if (Number.isSafeInteger(p?.issue) && Number.isSafeInteger(p?.number)) map.set(p.issue, p.number);
  return map;
}

export const lapsOf = steps => steps.filter((s, i) => s.result === 'bounced' && i < steps.length - 1).length;

export function binOf(steps, named) {
  if (steps.some(s => s.peg === 'merge')) return 'merged';
  if (named) return 'needs_you';
  return steps.at(-1)?.result === 'bounced' ? 'failed' : 'moving';
}

const titleOf = (prs, issues, pr, issue) => prs.find(p => p?.number === pr)?.title ?? issues.find(i => i?.number === issue)?.title ?? null;
const isNumber = value => Number.isSafeInteger(value) && value > 0;

// entries: the timeline; needsYou: the current Needs you list (each with ref {kind, n}); window: { startMs, endMs } (both inclusive);
// prs and issues: the dashboard view rows (number, title, and issue on a pull request row) for titles and the issue to pull request link.
export function buildOutcomes({ entries = [], needsYou = [], window, prs = [], issues = [] }) {
  const toPull = pullOfIssue(entries, prs);
  const named = new Set((needsYou || []).filter(a => isNumber(a?.ref?.n)).map(a => (a.ref.kind === 'pull' ? a.ref.n : (toPull.get(a.ref.n) ?? -a.ref.n))));
  const groups = new Map();
  for (const entry of entries) {
    if (!(entry.at >= window.startMs && entry.at <= window.endMs)) continue;
    const mapped = stepOf(entry);
    const issue = isNumber(entry.issue) ? entry.issue : null;
    const pr = isNumber(entry.pr) ? entry.pr : (issue ? (toPull.get(issue) ?? null) : null);
    if (!mapped || (!pr && !issue)) continue;
    const key = pr ?? -issue;   // a negative key is an issue with no pull request yet
    const group = groups.get(key) ?? { pr, issue: issue ?? prs.find(p => p?.number === pr)?.issue ?? null, steps: [] };
    group.issue ??= issue;
    group.steps.push(mapped);
    groups.set(key, group);
  }
  const items = [...groups.entries()].map(([key, g]) => {
    const steps = g.steps.sort((a, b) => a.at - b.at);
    const issue = g.issue ?? ([...toPull].find(([, p]) => p === g.pr)?.[0] ?? null);
    return { key: g.pr ? `pr-${g.pr}` : `issue-${issue}`, kind: g.pr ? 'pull' : 'issue', pr: g.pr, issue, title: titleOf(prs, issues, g.pr, issue),
      steps, laps: lapsOf(steps), bin: binOf(steps, named.has(key)), last_at: steps.at(-1).at };
  });
  items.sort((a, b) => b.last_at - a.last_at || a.key.localeCompare(b.key));
  const counts = Object.fromEntries(BINS.map(bin => [bin, items.filter(i => i.bin === bin).length]));
  return { items: items.slice(0, MAX_ITEMS), counts, truncated: items.length > MAX_ITEMS };
}
