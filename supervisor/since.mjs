// "Since you were last here" (issue #253). Pure summary of what happened in a time window, built only from the records the
// supervisor already keeps (job records, the team state's merge log and verdicts, the current Needs you list). No model call,
// no GitHub call. The "last here" marker is the one thing the dashboard server writes, and only on an explicit Mark as read.
export const SINCE_RANGES = { visit: 'Since last visit', '24h': 'Last 24 h', today: 'Today' };
export const DEFAULT_SINCE = 'visit';
const DAY = 86400000;

// Start of each range. "Today" is the UTC day, the same clock the rest of the dashboard prints. With no marker yet, "since last
// visit" falls back to the last 24 h and says so.
export function rangeStart(range, { lastSeen, now }) {
  if (range === '24h') return now - DAY;
  if (range === 'today') return now - (now % DAY);
  return Number.isFinite(lastSeen) ? lastSeen : now - DAY;
}
const stamp = ms => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

const within = (at, from, to) => Number.isFinite(at) && at >= from && at <= to;
const IMPLEMENTING = ['implement', 'continue'];

// ctx: { jobs, state, names, describe(job) -> one-line description, needsYou: [{text}], now }
export function summarise(ctx, from, to = ctx.now) {
  const { jobs = [], state = {}, names, describe, needsYou = [] } = ctx;
  const pr = n => ({ text: names.pr(n).text, url: names.pr(n).url, at: null });
  const issue = n => ({ text: names.issue(n).text, url: names.issue(n).url, at: null });
  const merged = [], issuesDone = [], opened = [], reviews = [], failed = [];
  const seenIssue = new Set();
  for (const m of state.mergeLog || []) {
    if (!within(m.mergedAt, from, to)) continue;
    merged.push({ ...pr(m.pr), at: m.mergedAt });
    if (Number.isSafeInteger(m.issue) && !seenIssue.has(m.issue)) { seenIssue.add(m.issue); issuesDone.push({ ...issue(m.issue), at: m.mergedAt }); }
  }
  for (const [key, v] of Object.entries(state.verdicts || {})) {
    const n = Number(key.split(':')[0]);
    if (Number.isSafeInteger(n) && within(v.at, from, to) && ['PASS', 'CHANGES'].includes(v.verdict)) reviews.push({ ...pr(n), at: v.at, verdict: v.verdict, text: `${names.pr(n).text}: ${v.verdict === 'PASS' ? 'PASS' : 'changes requested'}` });
  }
  let tokens = 0, tokenJobs = 0;
  const seenPr = new Set();
  for (const j of jobs) {
    if (!j || j.unreadable) continue;
    const end = j.updatedAt ?? j.createdAt, rec = state.jobs?.[j.id] || {}, kind = rec.kind || j.kind;
    if (within(end, from, to) && j.usage && Number.isFinite(j.usage.inputTokens + j.usage.outputTokens)) { tokens += j.usage.inputTokens + j.usage.outputTokens; tokenJobs++; }
    if (!within(end, from, to)) continue;
    if (['failed', 'blocked'].includes(j.status)) failed.push({ text: `${j.status === 'blocked' ? 'Blocked' : 'Failed'}: ${describe(j)}`, url: names.job(j).url, at: end });
    else if (j.status === 'completed' && IMPLEMENTING.includes(kind)) {
      const n = rec.pr ?? names.prOfIssue(rec.issue ?? j.issue);
      if (Number.isSafeInteger(n) && !seenPr.has(n)) { seenPr.add(n); opened.push({ ...pr(n), at: end }); }
    }
  }
  const byNewest = (a, b) => b.at - a.at;
  const lists = { merged: merged.sort(byNewest), opened: opened.sort(byNewest), reviews: reviews.sort(byNewest), issuesDone: issuesDone.sort(byNewest), failed: failed.sort(byNewest), needsYou: needsYou.map(a => ({ text: a.text, url: null, at: null })) };
  return { from, to, counts: Object.fromEntries(Object.entries(lists).map(([k, v]) => [k, v.length])), ...lists, tokens: tokenJobs ? tokens : null, tokenJobs };
}

const LABELS = [['merged', 'PRs merged'], ['opened', 'PRs opened'], ['reviews', 'Reviews'], ['issuesDone', 'Issues completed'], ['failed', 'Jobs failed or blocked'], ['needsYou', 'Needs you now']];
export const SECTIONS = LABELS;

// Plain text for the copy button: every item as number + title.
export function summaryText(s, title) {
  const out = [`${title} (${stamp(s.from)} to ${stamp(s.to)})`];
  for (const [k, label] of LABELS) { out.push(`${label}: ${s[k].length}`); for (const i of s[k]) out.push(`- ${i.text}`); }
  out.push(`Tokens used: ${s.tokens === null ? 'unknown' : s.tokens.toLocaleString('en-GB')}`);
  return out.join('\n');
}

export function sinceView(ctx, lastSeen) {
  const { now } = ctx, ranges = {};
  for (const r of Object.keys(SINCE_RANGES)) {
    const from = rangeStart(r, { lastSeen, now }), s = summarise(ctx, from, now);
    ranges[r] = { ...s, label: SINCE_RANGES[r], fallback: r === 'visit' && !Number.isFinite(lastSeen), text: summaryText(s, `Since you were last here: ${SINCE_RANGES[r]}`) };
  }
  return { lastSeen: Number.isFinite(lastSeen) ? lastSeen : null, ranges, generatedAt: now };
}
