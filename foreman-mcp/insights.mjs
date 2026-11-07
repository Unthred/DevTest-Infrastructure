// Issue #624 (D-030): two pure, read-only readings of the dashboard view for the Foreman MCP tools. No I/O, no model, no lock.
// Everything is derived from the same /api/view.json the other tools read, so it cannot disagree with the Needs you panel.
const CAP = 40;                       // items kept per list; the true count is always stated
const DAY = 24 * 3600000;
const short = (s, n = 300) => String(s ?? '').slice(0, n);
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// "homeowner-pr-538" -> "homeowner-pr", "job-<hex>" -> "job", "decision-D-024" -> "decision-D", "stale-mark-12" -> "stale-mark".
// "decision-D-024" stays apart from "decision-D-020" (separate decisions); "pause-claude" and "idle-codex" group as "pause" and "idle".
export const causeOf = id => {
  const s = String(id || 'unknown');
  if (/^decision-D-\d+$/i.test(s)) return s;
  if (/^(pause|idle)-[a-z]\w*$/i.test(s)) return s.split('-')[0];
  return s.replace(/(-[0-9a-f]{6,}|-\d+)+$/i, '') || 'unknown';
};

// A card ref is {kind, n}; the noreviewer-refused card carries a bare pull request number. Returns {kind, n} or null.
const refOf = a => {
  const r = a?.ref;
  if (Number.isSafeInteger(r)) return { kind: 'pull', n: r };
  if (r && Number.isSafeInteger(r.n)) return { kind: r.kind, n: r.n };
  return null;
};
const refText = r => `${r.kind === 'issue' ? 'issue' : 'pr'} #${r.n}`;

const needsYouItems = view => (Array.isArray(view.panels?.needsYou) ? view.panels.needsYou : (view.attention || []).filter(a => a.severity === 'action'));

// The Needs you items grouped by cause. Each group states how many items, what they refer to and the action asked, so a cluster of one cause is one decision.
export function needsYouGroups(view) {
  const items = needsYouItems(view), groups = new Map();
  for (const a of items) {
    const cause = causeOf(a.id), g = groups.get(cause) || { cause, count: 0, refs: [], actions: new Map(), example: null };
    const r = refOf(a); g.count++; if (r && g.refs.length < 30) g.refs.push(refText(r));
    const action = short(a.decision || a.action || 'Decide how to proceed.', 300); g.actions.set(action, (g.actions.get(action) || 0) + 1);
    g.example ||= short(a.text || a.why, 240); groups.set(cause, g);
  }
  const out = [...groups.values()].sort((a, b) => b.count - a.count || a.cause.localeCompare(b.cause)).map(g => ({ cause: g.cause, count: g.count, example: g.example, refs: g.refs, actions: [...g.actions].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([action, n]) => ({ action, items: n })) }));
  return { totalItems: items.length, distinctCauses: out.length, groups: out.slice(0, CAP), note: 'Grouped by the cause part of the item id. Items of one cause usually need one decision, not one each.' };
}

// Records that disagree with reality, each with the evidence that shows it. Heuristics over the view, not a remote check.
export function mismatches(view, now = Date.now()) {
  const skipped = [], found = [], add = (kind, ref, what, evidence) => found.push({ kind, ref, what: short(what, 240), evidence: short(evidence, 300) });
  const prs = view.prs || [], issues = view.issues || [], jobs = view.jobs || [], cards = needsYouItems(view);
  const openPrIssues = new Set(prs.filter(p => ['open', 'draft'].includes(p.status) && p.issue != null).map(p => p.issue));
  const active = new Set(jobs.filter(j => ['running', 'queued', 'paused_limit', 'paused_manual'].includes(j.status)).map(j => j.ref));
  const cardedPr = new Set(cards.map(refOf).filter(r => r && r.kind !== 'issue').map(r => r.n));
  // 1. An issue the dispatcher recorded as implemented that has no pull request and no job working on it.
  for (const i of issues) if (i.state === 'OPEN' && /started earlier; no PR yet/.test(i.reason || '') && !openPrIssues.has(i.number) && !active.has(i.number)) add('implemented-without-pr', `issue #${i.number}`, 'recorded as implemented, but no open pull request and no running job', i.reason);
  // 2. A job finished but its result was not recorded (a refused or missing verdict).
  for (const a of cards) if (/^(noreviewer-refused|reviewrefused|reviewlimit)-/.test(a.id || '')) add('finished-not-recorded', refOf(a) ? refText(refOf(a)) : a.id, 'a review job finished but no verdict was recorded', a.text);
  // 3. Stale labels: needs-homeowner on a closed issue, or on an open pull request with no Needs you card that is not simply awaiting review.
  for (const i of issues) if (i.state === 'CLOSED' && (i.labels || []).includes('needs-homeowner')) add('stale-label', `issue #${i.number}`, 'closed issue still labelled needs-homeowner', `labels: ${(i.labels || []).join(', ')}`);
  for (const p of prs) if (['open', 'draft'].includes(p.status) && p.needsHomeowner && !cardedPr.has(p.number) && !p.awaitingReview) add('stale-label', `pr #${p.number}`, 'open pull request labelled needs-homeowner with no Needs you item', `status ${p.status}, verdict ${p.verdict ?? 'none'}, checks ${p.checks ?? 'unknown'}`);
  // 4. Holds kept by old jobs (#583): the card says a stopped job holds the label, but that job is old or a newer job has run on the pull request since.
  for (const a of cards) {
    if (!/^homeowner-pr-/.test(a.id || '')) continue;
    const heldIds = [...String(a.tried || '').matchAll(/\bjob ([0-9a-f]{8})\b/g)].map(m => m[1]); if (!heldIds.length) continue;
    const cr = refOf(a); if (!cr) continue;
    const pr = prs.find(p => p.number === cr.n);
    for (const hid of heldIds) {
      const held = jobs.find(j => String(j.fullId || '').startsWith(hid));
      if (!held) { skipped.push(`pr #${cr.n} job ${hid}`); continue; }
      // #583: the label clears once the PR head has moved past the job's head. A newer job on the same head (a review) does not count.
      if (pr?.head && held.head && pr.head !== held.head) add('hold-by-old-job', `pr #${cr.n}`, `held by job ${hid} although the pull request head has moved past that job's head`, `job head ${String(held.head).slice(0, 7)}, PR head ${String(pr.head).slice(0, 7)}; held job started ${iso(held.startedAt)}`);
      else if (now - held.startedAt > DAY) add('hold-by-old-job', `pr #${cr.n}`, `held by job ${hid} that started over 24 hours ago`, `held job ${held.status}, started ${iso(held.startedAt)}`);
    }
  }
  return { count: found.length, shown: Math.min(found.length, CAP), items: found.slice(0, CAP), kindsChecked: ['implemented-without-pr', 'finished-not-recorded', 'stale-label', 'hold-by-old-job'], ...(skipped.length ? { notChecked: skipped.slice(0, CAP), notCheckedNote: 'Held jobs not among the recent jobs in the view, so their hold was not checked.' } : {}), note: 'Read from the dashboard view only; the remote is not checked. Empty means none of these four kinds is visible, not that everything is correct.' };
}

// Issue #633: how many rebases and reviews a merged pull request took, and how long from its first recorded activity to merge, so a change to the
// rebase policy can be measured before and after. Pure reading of the view's merged pull requests. "Opened" is the earliest timeline entry the view
// holds for the pull request (a job start or a verdict), a proxy: the view carries no GitHub creation time. A pull request with no timestamp
// has no duration and is left out of the time figures only (the merge entry itself is not counted as activity). `splitAt` (ISO time) divides merges into before and after.
const median = xs => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round1 = x => (x === null ? null : Math.round(x * 10) / 10);
function summarise(rows) {
  const avg = f => (rows.length ? round1(rows.reduce((a, r) => a + f(r), 0) / rows.length) : null);
  const hours = rows.map(r => r.hours).filter(h => h !== null);
  return { pullRequests: rows.length, rebases: { total: rows.reduce((a, r) => a + r.rebases, 0), perPullRequest: avg(r => r.rebases) }, reviews: { total: rows.reduce((a, r) => a + r.reviews, 0), perPullRequest: avg(r => r.reviews), carriedTotal: rows.reduce((a, r) => a + r.carried, 0) },
    openToMergeHours: { measured: hours.length, median: round1(median(hours)), mean: hours.length ? round1(hours.reduce((a, h) => a + h, 0) / hours.length) : null } };
}
export function rebaseStats(view, { splitAt = null, limit = 100 } = {}) {
  const split = splitAt === null ? null : Date.parse(splitAt);
  if (splitAt !== null && !Number.isFinite(split)) throw new Error('splitAt must be an ISO date or time');
  const rows = (view.prs || []).filter(p => p.status === 'merged' && Number.isFinite(p.mergedAt)).map(p => {
    const first = Math.min(...(p.timeline || []).filter(t => t.text !== 'merged').map(t => t.at).filter(Number.isFinite));
    // Reviews are verdicts a review produced; a D-025 carried verdict (carry set) is an avoided review and is counted apart.
    const vs = Array.isArray(p.verdicts) ? p.verdicts : null, carried = vs ? vs.filter(v => v && v.carry).length : 0;
    const reviews = vs ? vs.length - carried : (Number.isFinite(p.reviewRounds) ? p.reviewRounds : 0);
    return { pr: p.number, mergedAt: p.mergedAt, rebases: Number.isFinite(p.rebaseRounds) ? p.rebaseRounds : 0, reviews, carried, hours: Number.isFinite(first) && p.mergedAt >= first ? (p.mergedAt - first) / 3600000 : null };
  }).sort((a, b) => b.mergedAt - a.mergedAt);
  const out = { all: summarise(rows) };
  if (split !== null) { out.before = summarise(rows.filter(r => r.mergedAt < split)); out.after = summarise(rows.filter(r => r.mergedAt >= split)); out.splitAt = iso(split); }
  out.recent = rows.slice(0, Math.max(1, Math.min(200, Number(limit) || 100))).map(r => ({ pr: r.pr, mergedAt: iso(r.mergedAt), rebases: r.rebases, reviews: r.reviews, carried: r.carried, openToMergeHours: round1(r.hours) }));
  out.note = 'Merged pull requests the view still holds. Rebases are the rebase attempts recorded; reviews are the verdicts a review produced (a D-025 carried verdict is not a review; it is counted apart as carried). Open time is measured from the first recorded activity, not the GitHub creation time.';
  return out;
}

// Issue #636: one pull request or issue across jobs, reviews and rebases, oldest first, from the dashboard view. For a pull request the jobs of
// the issue it closes are included too (the implementation that made it). Read-only.
const urlNumber = (url, kind) => { const m = new RegExp(`/${kind === 'pr' ? 'pull' : 'issues'}/(\\d+)$`).exec(String(url?.url || url || '')); return m ? Number(m[1]) : null; };
export function itemTimeline(view, kind, number, { limit = 60 } = {}) {
  const n = Number(number), v = view || {};
  const pr = kind === 'pr' ? (v.prs || []).find(p => p.number === n) : null;
  const refs = new Set([n]); if (pr?.issue) refs.add(pr.issue);
  const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const entries = [];
  for (const j of v.jobs || []) {
    if (!refs.has(j.ref)) continue;
    const at = Number.isFinite(j.startedAt) ? j.startedAt : j.createdAt;
    entries.push({ atMs: at, type: 'job', what: j.kind, id: j.fullId ?? null, ref: j.ref, agent: j.agent ?? null, status: j.status, durationSeconds: Number.isFinite(j.elapsedMs) ? Math.round(j.elapsedMs / 1000) : null, tokens: j.tokens ?? null, costUsdEquivalent: j.cost ?? null, summary: j.desc ?? null });
  }
  for (const a of v.activity || []) {
    if (a.kind === 'tick' || urlNumber(a.link, kind) !== n) continue;
    entries.push({ atMs: a.at, type: a.kind, what: a.outcome ?? null, agent: a.agent ?? null, summary: a.text ?? null });
  }
  entries.sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0));
  const counts = {}; for (const e of entries) { const k = e.type === 'job' ? `${e.what}Jobs` : `${e.type}s`; counts[k] = (counts[k] || 0) + 1; }
  const found = !!pr || (kind === 'issue' && (v.issues || []).some(i => i.number === n)) || entries.length > 0;
  return { kind, number: n, found, ...(pr ? { title: pr.title, status: pr.status, issue: pr.issue ?? null, checks: pr.checks, verdict: pr.verdict, reviewRounds: pr.reviewRounds, fixRounds: pr.fixRounds, rebaseRounds: pr.rebaseRounds } : {}),
    counts, total: entries.length, shown: Math.min(entries.length, limit), entries: entries.slice(-limit).map(({ atMs, ...e }) => ({ at: iso(atMs), ...e })),
    note: 'Jobs come from the recent jobs the view holds; reviews and merges from its newest 50 activity events, so an old item can have gaps.' };
}
