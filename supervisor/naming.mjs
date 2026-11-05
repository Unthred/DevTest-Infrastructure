// One naming scheme for issues, pull requests, jobs and commits (issues #147, #204). Every surface that names a piece of work
// (dashboard pages and cards, `team status`, alerts, GitHub notices and verdict comments) builds its text here, so the same
// item reads the same everywhere:
//   issue   #140 Configurable menu position
//   PR      PR #149 Allow menu to be top, bottom, left or right (for #140 Configurable menu position)   (the PR's own title)
//   job     Reviewer · review · PR #149 Allow menu…                                                    (role · action · item)
//   commit  first 7 characters
// A finished job also gets a one-line description (describeJob) built from data Foreman already holds; no model call.
// Pure functions: no I/O, no clock. A reference is { text, full, url }: `text` truncates a long title, `full` keeps it (shown
// on hover and used in plain-text records that have room), `url` is the GitHub page (or the dashboard job page for a job).
export const SEP = ' · ';
export const TITLE_MAX = 60;
export const FOR_ROOM = 100;      // the "(for #140 …)" clause is added to the short form only while the whole name stays within this
import { redact } from './redact.mjs';
const JOB_ID_LEN = 8, COMMIT_LEN = 7;

export const shortJob = id => String(id ?? '').slice(0, JOB_ID_LEN);
export const shortCommit = sha => String(sha ?? '').slice(0, COMMIT_LEN);
export const clipTitle = (title, max = TITLE_MAX) => {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…` : t;
};
const isNo = n => Number.isSafeInteger(n) && n > 0;

// ---- the formatters. `issue` is { number, title } or null when the PR's issue cannot be determined.
export function formatIssue(number, title, { max = TITLE_MAX } = {}) {
  const head = `#${number}`;
  return title ? `${head} ${clipTitle(title, max)}` : head;
}
export function formatPr(number, prTitle = null, issue = null, { max = TITLE_MAX, withIssue = true } = {}) {
  const head = prTitle ? `PR #${number} ${clipTitle(prTitle, max)}` : `PR #${number}`;
  if (!withIssue || !issue || !isNo(issue.number)) return head;
  const clause = `(for ${formatIssue(issue.number, issue.title, { max: max === Infinity ? Infinity : Math.floor(max / 2) })})`;
  return max === Infinity || head.length + 1 + clause.length <= FOR_ROOM ? `${head} ${clause}` : head;
}
export const roleName = kind => (kind === 'review' ? 'Reviewer' : kind === 'rebase' ? 'Rebaser' : 'Implementer');
export const actionName = kind => (kind === 'cifix' ? 'CI fix' : kind || 'job');
// kind: implement | continue | review | fix | rebase | cifix | ...; subject is { pr, prTitle, issue } as for the work it is doing.
export function formatJob({ kind, pr = null, prTitle = null, issue = null }, opts = {}) {
  const what = isNo(pr) ? formatPr(pr, prTitle, issue, { ...opts, withIssue: false }) : issue && isNo(issue.number) ? formatIssue(issue.number, issue.title, opts) : null;
  return [roleName(kind), actionName(kind), what].filter(Boolean).join(SEP);
}
export const formatCommit = shortCommit;

const IMPLEMENTING = ['implement', 'continue'];
export const jobSubject = job => (IMPLEMENTING.includes(job?.kind) ? { issue: job?.issue ?? null, pr: null } : { pr: job?.pr ?? job?.issue ?? null, issue: null });

// ---- one-line description of a job (issue #204). `ctx` carries what the caller already resolved:
//   { names, rec (the dispatcher's job record), verdict ({verdict,findings}|null), opened (PR number an implement job opened, or null) }
// Only existing data: role, kind, target, outcome, the stop reason and the agent's last summary line when the job record has one.
const REASON_TEXT = { retry_exhausted: 'retries exhausted', usage_limit: 'usage limit reached', auth_error: 'sign-in problem', crash: 'the agent crashed', incomplete: 'it ended without its post-condition', approval_required: 'approval required', context_limit: 'context limit reached', preflight_failed: 'preflight check failed', network_error: 'network error', manual_stop: 'stopped by hand', checkpoint_failed: 'progress checkpoint failed', stale_handover: 'stale handover', issue_closed: 'the issue was closed' };
const reasonText = (job, rec) => {
  const detail = [rec?.failure, rec?.reason, job?.failureReason].find(v => typeof v === 'string' && v.trim());
  if (detail) return clipTitle(detail, 140);
  const ev = job?.lastEvent;
  return ev ? REASON_TEXT[ev] || String(ev).replace(/_/g, ' ') : null;
};
const summaryLine = job => {
  const raw = [job?.summary, job?.finalSummary, job?.lastMessage].find(v => typeof v === 'string' && v.trim());
  return raw ? ` Last note: ${clipTitle(raw.trim().split(/\r?\n/).filter(Boolean).pop(), 160)}` : '';
};
const sentence = t => `${t.replace(/[.\s]+$/, '')}.`;
const PROGRESSIVE = { implement: 'implementing', continue: 'continuing', review: 'reviewing', fix: 'fixing', rebase: 'rebasing', cifix: 'fixing CI on' };
export function describeJob(job, { names, rec = null, verdict = null, opened = null } = {}) {
  const kind = job?.kind || rec?.kind || 'job', role = roleName(kind);
  const s = jobSubject({ kind, pr: rec?.pr ?? job?.pr, issue: IMPLEMENTING.includes(kind) ? rec?.issue ?? job?.issue : job?.issue ?? rec?.pr });
  const bare = t => { const i = t.lastIndexOf(' (for #'); return i > 0 && t.endsWith(')') ? t.slice(0, i) : t; };   // a description names the PR without the issue clause
  const target = isNo(s.pr) ? bare(names.pr(s.pr).text) : isNo(s.issue) ? names.issue(s.issue).text : 'its target';
  const tail = summaryLine(job), status = job?.status;
  if (status === 'queued') return sentence(`${role} ${actionName(kind)} of ${target} is queued`);
  if (status === 'running') return sentence(`${role} is ${PROGRESSIVE[kind] || 'working on'} ${target}`);
  if (status === 'paused_limit' || status === 'paused_manual') return sentence(`${role} ${actionName(kind)} of ${target} is paused (${status === 'paused_limit' ? 'usage limit' : 'by hand'})`);
  if (status === 'failed' || status === 'blocked') {
    const why = reasonText(job, rec), verb = status === 'failed' ? 'failed' : 'was blocked';
    return sentence(`${kind === 'rebase' ? `Rebase of ${target}` : `${role} ${actionName(kind)} of ${target}`} ${verb}${why ? `: ${why}` : ''}`) + tail;
  }
  if (kind === 'review') {
    const n = Array.isArray(verdict?.findings) ? verdict.findings.length : 0;
    if (verdict?.verdict === 'CHANGES') return sentence(`${role} requested changes on ${target}${n ? `: ${n} finding${n === 1 ? '' : 's'}` : ''}`) + tail;
    if (verdict?.verdict === 'PASS') return sentence(`${role} approved ${target}`) + tail;
    return sentence(`${role} reviewed ${target}; no verdict was recorded`) + tail;
  }
  if (IMPLEMENTING.includes(kind)) {
    const forIssue = isNo(s.issue) ? names.issue(s.issue).text : null, verb = kind === 'continue' ? 'continued' : 'opened';
    if (isNo(opened)) return sentence(`${role} ${verb} ${bare(names.pr(opened).text)}${forIssue ? ` for ${forIssue}` : ''}`) + tail;
    return sentence(`${role} finished work on ${forIssue || target}`) + tail;
  }
  if (kind === 'rebase') return sentence(`Rebase of ${target} completed${rec?.rebase ? `: ${shortCommit(rec.rebase.oldHead)} → ${shortCommit(rec.rebase.newHead)}` : ''}`) + tail;
  return sentence(`${role} ${actionName(kind)} of ${target} completed`) + tail;
}

// Resolves what a number or job stands for from the data a tick already holds. Inputs are all optional.
//   issues: [{number,title}]; pulls: [{number,title,headRefName}]; merged: [{number,title,headRefName,issue?,closingIssuesReferences?}]
//   mergeLog: [{pr,issue}]; stateJobs: {id:{pr,issue,prTitle?,issueTitle?,forIssue?}}; repo: 'owner/name'; jobBase: dashboard path
//   titles: {issue:{n:title}, pr:{n:title}}: the titles Foreman stored the last time it read GitHub (issue #204), the fallback
//   when GitHub is unreachable. Live data wins, then the stored titles, then the titles saved on the job record.
export function makeNamer({ repo = null, issues = [], pulls = [], merged = [], mergeLog = [], stateJobs = {}, titles: stored = null, jobBase = '/work/job/' } = {}) {
  const issueTitles = new Map(), prTitles = new Map();
  // Titles come from GitHub text anyone can write, so they are redacted once, here, before any surface can print them.
  const put = (map, n, t) => { n = Number(n); if (isNo(n) && typeof t === 'string' && t.trim() && !map.has(n)) map.set(n, redact(t, 200)); };
  for (const i of issues) put(issueTitles, i.number, i.title);
  for (const p of pulls) put(prTitles, p.number, p.title);
  for (const m of merged) put(prTitles, m.number, m.title);
  for (const [n, t] of Object.entries(stored?.issue || {})) put(issueTitles, n, t);
  for (const [n, t] of Object.entries(stored?.pr || {})) put(prTitles, n, t);
  for (const j of Object.values(stateJobs || {})) {
    if (!j) continue;
    if (j.issueTitle) put(issueTitles, IMPLEMENTING.includes(j.kind) ? j.issue : j.forIssue, j.issueTitle);
    if (j.prTitle) put(prTitles, j.pr, j.prTitle);
  }
  const prIssueMap = new Map(), issuePrMap = new Map();
  const branchIssue = b => { const m = /\/issue-(\d+)(\D|$)/.exec(b || ''); return m ? Number(m[1]) : null; };
  const learn = (pr, n) => { if (isNo(pr) && isNo(n)) { if (!prIssueMap.has(pr)) prIssueMap.set(pr, n); issuePrMap.set(n, Math.max(issuePrMap.get(n) || 0, pr)); } };
  for (const p of pulls) learn(p.number, branchIssue(p.headRefName) ?? p.issue ?? p.closingIssuesReferences?.[0]?.number);
  for (const m of merged) learn(m.number, m.issue ?? branchIssue(m.headRefName) ?? m.closingIssuesReferences?.[0]?.number);
  for (const m of mergeLog) learn(m.pr, m.issue);
  for (const j of Object.values(stateJobs || {})) if (j?.pr != null) learn(j.pr, j.forIssue ?? (IMPLEMENTING.includes(j.kind) ? j.issue : null));
  const gh = (kind, n) => (repo ? `https://github.com/${repo}/${kind}/${n}` : null);

  const issueOfPr = pr => { const n = prIssueMap.get(pr); return n == null ? null : { number: n, title: issueTitles.get(n) ?? null }; };
  const make = (build, url) => ({ text: build({}), full: build({ max: Infinity }), url });
  const issue = n => make(o => formatIssue(n, issueTitles.get(n), o), gh('issues', n));
  const pr = n => make(o => formatPr(n, prTitles.get(n), issueOfPr(n), o), gh('pull', n));
  const job = j => {
    const subj = jobSubject(j), id = j.id;
    const issueObj = subj.issue ? { number: subj.issue, title: issueTitles.get(subj.issue) ?? null } : null;
    return make(o => formatJob({ kind: j.kind, pr: subj.pr, prTitle: subj.pr ? prTitles.get(subj.pr) ?? null : null, issue: issueObj }, o), `${jobBase}${shortJob(id)}`);
  };
  const commit = sha => ({ text: shortCommit(sha), full: String(sha ?? ''), url: repo && sha ? gh('commit', sha) : null });
  return { issue, pr, job, commit, issueOfPr, prOfIssue: n => issuePrMap.get(n) ?? null, titleOf: n => issueTitles.get(n) ?? null, prTitleOf: n => prTitles.get(n) ?? null };
}
