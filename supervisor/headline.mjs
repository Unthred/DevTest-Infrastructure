// Issue #866: the headline progress numbers at the top of the dashboard ("are we getting through the work?").
// Pure: it reads Foreman's own records (the dashboard view's issues, pull requests and jobs, and the circuit breaker's waste record) and
// returns, for each of the last 24 hours and the last 7 days, eight figures, the same figure for the period before (for the trend) and the
// items behind each figure (the drill-down table). No I/O and no model call. The dashboard page and foreman_headline both use it, so the two cannot disagree.
const HOUR = 3600000;
export const WINDOWS = { '24h': 24 * HOUR, '7d': 7 * 24 * HOUR };
export const WASTE_KEEP_MS = 7 * 24 * HOUR;   // the breaker keeps its waste record this long (breaker.mjs KEEP_MS)
export const MAX_ITEMS = 200;                 // items kept per card and window; the true count is always stated
export const CARD_IDS = ['issues', 'processed', 'merge-rate', 'throughput', 'first-pass', 'rounds', 'tokens', 'cost', 'waste', 'rejects'];
export const CARD_TITLES = {
  issues: 'Issues opened vs closed', processed: 'Issues processed', 'merge-rate': 'PRs merged per hour', throughput: 'Throughput per hour', cost: 'Cost per merged issue', 'first-pass': 'First-pass approval',
  rounds: 'Rounds per merged PR', tokens: 'Tokens per merged PR', waste: 'Wasted tokens', rejects: 'Rejects',
};
const NOTE = 'Counted from Foreman\'s own job and review records and the issue and pull request state it last fetched. Tokens are a usage equivalent, not a cash charge.';

const fin = Number.isFinite;
const inside = (t, from, to) => fin(t) && t > from && t <= to;
const round = (n, d = 2) => (fin(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const ms = v => (fin(v) ? v : typeof v === 'string' && fin(Date.parse(v)) ? Date.parse(v) : null);
const sum = (xs, f) => xs.reduce((n, x) => n + (fin(f(x)) ? f(x) : 0), 0);
const item = (kind, ref, title, at, detail, tokens = null) => ({ kind, ref, title: String(title ?? '').slice(0, 160), at: fin(at) ? at : null, detail: String(detail ?? '').slice(0, 200), tokens: fin(tokens) ? tokens : null });
const cap = items => items.sort((a, b) => (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_ITEMS);

// A verdict a review produced (a D-025 carried verdict is an avoided review, not a review).
// Issue #879: team.mjs deletes a verdict on a re-review request or a requirements change and a second-opinion CHANGES overwrites the same
// key, so the live per-head verdicts alone can lose a PR's true first review. The verdict archive (the history timeline, first write per
// pr:head wins) is merged in: for each head the archived verdict is preferred, a live one fills the heads the archive has not seen.
const realVerdicts = (p, archive) => {
  const live = (Array.isArray(p.verdicts) ? p.verdicts : []).filter(v => v && typeof v === 'object');
  const carried = new Set(live.filter(v => v.carry || v.carriedFrom).map(v => v.head));
  const byHead = new Map();
  for (const a of archive?.get(p.number) || []) if (fin(a.at) && !a.detail && !carried.has(a.head) && !byHead.has(a.head)) byHead.set(a.head, a);
  const out = live.filter(v => !v.carry && !v.carriedFrom && fin(v.at) && !byHead.has(v.head));
  return [...byHead.values(), ...out].sort((a, b) => a.at - b.at);
};
const reviewsOf = p => (Array.isArray(p.verdicts) ? realVerdicts(p).length : (fin(p.reviewRounds) ? p.reviewRounds : 0)) + (fin(p.secondOpinionRounds) ? p.secondOpinionRounds : 0);
const roundsOf = p => reviewsOf(p) + (fin(p.fixRounds) ? p.fixRounds : 0) + (fin(p.rebaseRounds) ? p.rebaseRounds : 0);

// One card's figures for one period [from, to].
function period({ issues, prs, jobs, waste, archive }, from, to, spanMs) {
  const issueMs = issues.map(i => ({ ...i, c: ms(i.createdAt), x: ms(i.closedAt) }));
  const opened = issueMs.filter(i => inside(i.c, from, to)), closed = issueMs.filter(i => i.x !== null && inside(i.x, from, to) && i.state !== 'OPEN');
  const openAtStart = issueMs.filter(i => fin(i.c) && i.c <= from && (i.state === 'OPEN' || !fin(i.x) || i.x > from)).length;
  const total = openAtStart + opened.length;
  const merged = prs.filter(p => p.status === 'merged' && inside(p.mergedAt, from, to));
  const cohort = prs.map(p => ({ p, first: realVerdicts(p, archive)[0] })).filter(({ first }) => first && inside(first.at, from, to));
  const approved = cohort.filter(({ first }) => first.verdict === 'PASS');
  const known = merged.filter(p => fin(p.tokens));
  const wasted = waste.filter(w => inside(w.at, from, to));
  const byCause = new Map(); for (const w of wasted) byCause.set(w.cause || 'unknown', (byCause.get(w.cause || 'unknown') || 0) + (fin(w.tokens) ? w.tokens : 0));
  const top = [...byCause].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] || null;
  const changes = prs.flatMap(p => realVerdicts(p, archive).filter(v => v.verdict === 'CHANGES' && inside(v.at, from, to)).map(v => ({ p, v })));
  // Issue #879: each time a job became blocked is recorded (job.blockedAt), so a job blocked in the period and resumed later still counts, at the
  // time it was blocked. A job without the record (older than that field) that is blocked now falls back to its last update.
  const blockedEvents = jobs.flatMap(j => {
    const at = Array.isArray(j.blockedAt) ? j.blockedAt.filter(fin) : [];
    return (at.length ? at : j.status === 'blocked' ? [fin(j.updatedAt) ? j.updatedAt : j.createdAt] : []).filter(t => inside(t, from, to)).map(t => ({ j, t }));
  });
  const hours = spanMs / HOUR;
  const openedPrs = prs.filter(p => inside(ms(p.openedAt), from, to));
  const implemented = jobs.filter(j => j.kind === 'implement' && j.status === 'completed' && inside(ms(j.updatedAt), from, to));
  const costKnown = merged.filter(p => fin(p.costUsd));
  const perH = n => round(n / hours, 3);
  const cards = {
    issues: { value: opened.length - closed.length, opened: opened.length, closed: closed.length, net: opened.length - closed.length, unit: 'net issues',
      items: cap([...opened.map(i => item('issue', i.number, i.title, i.c, 'opened')), ...closed.map(i => item('issue', i.number, i.title, i.x, 'closed'))]), count: opened.length + closed.length },
    processed: { value: total ? round(closed.length / total * 100, 1) : null, processed: closed.length, total, openAtStart, opened: opened.length, unit: '%',
      items: cap(closed.map(i => item('issue', i.number, i.title, i.x, 'closed'))), count: closed.length },
    'merge-rate': { value: round(merged.length / hours, 3), merged: merged.length, hours, unit: 'per hour',
      items: cap(merged.map(p => item('pr', p.number, p.title, p.mergedAt, 'merged', p.tokens))), count: merged.length },
    throughput: { value: perH(openedPrs.length), opened: openedPrs.length, merged: merged.length, implemented: implemented.length, openedPerHour: perH(openedPrs.length), mergedPerHour: perH(merged.length), implementedPerHour: perH(implemented.length), hours, unit: 'per hour',
      items: cap([...openedPrs.map(p => item('pr', p.number, p.title, ms(p.openedAt), 'opened')), ...merged.map(p => item('pr', p.number, p.title, p.mergedAt, 'merged')), ...implemented.map(j => item('job', String(j.id || '').slice(0, 8), 'implement job completed', ms(j.updatedAt), `issue ${j.issue ?? 'unknown'}`))]), count: openedPrs.length + merged.length + implemented.length },
    'first-pass': { value: cohort.length ? round(approved.length / cohort.length * 100, 1) : null, approved: approved.length, reviewed: cohort.length, unit: '%',
      items: cap(cohort.map(({ p, first }) => item('pr', p.number, p.title, first.at, `first review: ${first.verdict}`))), count: cohort.length },
    rounds: { value: merged.length ? round(sum(merged, roundsOf) / merged.length) : null, merged: merged.length, rounds: sum(merged, roundsOf), unit: 'rounds',
      items: cap(merged.map(p => item('pr', p.number, p.title, p.mergedAt, `${reviewsOf(p)} review, ${fin(p.fixRounds) ? p.fixRounds : 0} fix, ${fin(p.rebaseRounds) ? p.rebaseRounds : 0} rebase`, p.tokens))), count: merged.length },
    tokens: { value: known.length ? Math.round(sum(known, p => p.tokens) / known.length) : null, merged: merged.length, withKnownTokens: known.length, totalTokens: sum(known, p => p.tokens), unit: 'tokens',
      items: cap(merged.map(p => item('pr', p.number, p.title, p.mergedAt, fin(p.tokens) ? 'merged' : 'merged, tokens unknown', p.tokens))), count: merged.length },
    cost: { value: costKnown.length ? round(sum(costKnown, p => p.costUsd) / costKnown.length) : null, merged: merged.length, withKnownCost: costKnown.length, totalCostUsd: round(sum(costKnown, p => p.costUsd)), unit: 'USD equivalent',
      items: cap(merged.map(p => item('pr', p.number, p.title, p.mergedAt, fin(p.costUsd) ? `merged, $${round(p.costUsd)} (implement, review, fix and rebase jobs)` : 'merged, cost unknown', p.tokens))), count: merged.length },
    waste: { value: sum(wasted, w => w.tokens), jobs: wasted.length, costUsdEquivalent: round(sum(wasted, w => w.cost)), topCause: top ? { cause: top[0], tokens: top[1] } : null, unit: 'tokens',
      items: cap(wasted.map(w => item(w.pr ? 'pr' : w.issue ? 'issue' : 'job', w.pr ?? w.issue ?? String(w.job || '').slice(0, 8), w.cause, w.at, `${w.agent || 'unknown agent'}, job ${String(w.job || '').slice(0, 8)}`, w.tokens))), count: wasted.length },
    rejects: { value: changes.length + blockedEvents.length, changes: changes.length, blocked: blockedEvents.length, unit: 'rejects',
      items: cap([...changes.map(({ p, v }) => item('pr', p.number, p.title, v.at, `CHANGES from ${v.reviewer || 'a reviewer'}`)),
        ...blockedEvents.map(({ j, t }) => item('job', String(j.id || '').slice(0, 8), `${j.kind || 'job'} job blocked`, t, `issue/PR ${j.issue ?? 'unknown'}`, fin(j.usage?.inputTokens) ? j.usage.inputTokens + (j.usage.outputTokens || 0) : null))]), count: changes.length + blockedEvents.length },
  };
  return cards;
}

// issues: { number, title, state, createdAt, closedAt }; prs: dashboard view PR rows; jobs: supervisor job records; wasteRecords: breaker waste entries; verdictArchive: history timeline entries (kind 'verdict').
export function headlineStats({ issues = [], prs = [], jobs = [], wasteRecords = [], verdictArchive = [], now = Date.now() } = {}) {
  const archive = new Map();
  for (const a of Array.isArray(verdictArchive) ? verdictArchive : []) if (a && a.kind === 'verdict' && Number.isSafeInteger(a.pr)) archive.set(a.pr, [...(archive.get(a.pr) || []), a]);
  const inputs = { issues, prs, jobs, archive, waste: wasteRecords.filter(w => w && typeof w === 'object' && fin(w.at)) };
  const openNow = issues.filter(i => i.state === 'OPEN').length;
  const closedHeld = issues.filter(i => i.state !== 'OPEN').length;
  const windows = {};
  for (const [name, span] of Object.entries(WINDOWS)) {
    const cur = period(inputs, now - span, now, span), prev = period(inputs, now - 2 * span, now - span, span);
    const previousWaste = 2 * span <= WASTE_KEEP_MS;
    const cards = {};
    for (const id of CARD_IDS) {
      const c = cur[id], p = prev[id], { items, ...rest } = c;
      const { items: _drop, ...previous } = p;
      const unavailable = id === 'waste' && !previousWaste;
      const pv = unavailable ? null : p.value, delta = fin(c.value) && fin(pv) ? round(c.value - pv, 3) : null;
      cards[id] = { id, title: CARD_TITLES[id], ...rest, previous: unavailable ? null : previous, previousValue: pv, delta, direction: delta === null ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat', shown: items.length, items,
        ...(id === 'issues' ? { openNow } : {}), ...(id === 'waste' && unavailable ? { previousNote: 'The waste record holds 7 days, so there is no previous 7-day period to compare with.' } : {}) };
    }
    windows[name] = { from: now - span, to: now, cards };
  }
  // The cache holds every open issue and the newest 200 of any state: more closed issues than that may have been closed in a long window without being held.
  const partial = closedHeld >= 200;
  return { generatedAt: now, windows, openNow, issuesPartial: partial, note: NOTE + (partial ? ' The issue list holds the newest 200 closed issues, so closed counts in a busy period may be a floor.' : '') };
}

