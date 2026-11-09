// Issue #1056: blocked review jobs and their tokens per creation day (UTC), from local job records only. Read-only.
// Run it before and after deployment to produce the same table; `repairs` counts verdicts Foreman repaired locally, so the
// after-report can say whether the prompt check or the repair avoided the block.
const day = t => new Date(t).toISOString().slice(0, 10);
const tokensOf = j => (Number(j?.usage?.inputTokens) || 0) + (Number(j?.usage?.outputTokens) || 0);
export function blockedReport(jobs, { from, to }) {
  const rows = new Map();
  for (let t = Date.UTC(new Date(from).getUTCFullYear(), new Date(from).getUTCMonth(), new Date(from).getUTCDate()); t <= to; t += 86400000) rows.set(day(t), { day: day(t), blocked: 0, tokens: 0, repaired: 0 });
  for (const j of jobs || []) {
    if (j?.kind !== 'review' || !Number.isFinite(j.createdAt) || j.createdAt < from || j.createdAt > to) continue;
    const r = rows.get(day(j.createdAt)); if (!r) continue;
    if (j.status === 'blocked') { r.blocked++; r.tokens += tokensOf(j); }
    if (Array.isArray(j.verdictRepairs) && j.verdictRepairs.length) r.repaired++;
  }
  const list = [...rows.values()];
  return { from: day(from), to: day(to), days: list, total: { blocked: list.reduce((n, r) => n + r.blocked, 0), tokens: list.reduce((n, r) => n + r.tokens, 0), repaired: list.reduce((n, r) => n + r.repaired, 0) } };
}
export const renderBlockedReport = rep => {
  const m = n => (n / 1e6).toFixed(2) + 'M';
  return ['| Day | Blocked review jobs | Tokens | Verdicts repaired locally |', '|---|---|---|---|',
    ...rep.days.map(r => `| ${r.day} | ${r.blocked} | ${m(r.tokens)} | ${r.repaired} |`),
    `| Total | ${rep.total.blocked} | ${m(rep.total.tokens)} | ${rep.total.repaired} |`].join('\n');
};
