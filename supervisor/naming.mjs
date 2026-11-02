// One naming scheme for issues, pull requests, jobs and commits (issue #147). Every surface that names a piece of work
// (dashboard pages and cards, `team status`, alerts, GitHub notices and verdict comments) builds its text here, so the same
// item reads the same everywhere:
//   issue   #104 <issue title>
//   PR      PR #146 · #104 <issue title>        (the title is the ISSUE's, not the pull request's)
//   job     <type> · PR #146 · #104 <issue title> · job 3f2a91c0
//   commit  first 7 characters
// Pure functions: no I/O, no clock. A reference is { text, full, url }: `text` truncates a long title, `full` keeps it (shown
// on hover and used in plain-text records that have room), `url` is the GitHub page (or the dashboard job page for a job).
export const SEP = ' · ';
export const TITLE_MAX = 60;
const JOB_ID_LEN = 8, COMMIT_LEN = 7;

export const shortJob = id => String(id ?? '').slice(0, JOB_ID_LEN);
export const shortCommit = sha => String(sha ?? '').slice(0, COMMIT_LEN);
export const clipTitle = (title, max = TITLE_MAX) => {
  const t = String(title ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, Math.max(1, max - 1)).trimEnd()}…` : t;
};
const isNo = n => Number.isSafeInteger(n) && n > 0;

// ---- the four formatters. `issue` is { number, title } or null when the PR's issue cannot be determined.
export function formatIssue(number, title, { max = TITLE_MAX } = {}) {
  const head = `#${number}`;
  return title ? `${head} ${clipTitle(title, max)}` : head;
}
export function formatPr(number, issue = null, opts = {}) {
  const head = `PR #${number}`;
  return issue && isNo(issue.number) ? `${head}${SEP}${formatIssue(issue.number, issue.title, opts)}` : head;
}
// kind: implement | continue | review | fix | rebase | cifix | ...; subject is { pr, issue } as for the work it is doing.
export function formatJob({ kind, id, pr = null, issue = null }, opts = {}) {
  const what = isNo(pr) ? formatPr(pr, issue, opts) : issue && isNo(issue.number) ? formatIssue(issue.number, issue.title, opts) : null;
  return [kind || 'job', what, `job ${shortJob(id)}`].filter(Boolean).join(SEP);
}
export const formatCommit = shortCommit;

const IMPLEMENTING = ['implement', 'continue'];
export const jobSubject = job => (IMPLEMENTING.includes(job?.kind) ? { issue: job?.issue ?? null, pr: null } : { pr: job?.pr ?? job?.issue ?? null, issue: null });

// Resolves what a number or job stands for from the data a tick already holds. Inputs are all optional.
//   issues: [{number,title}]; pulls: [{number,title,headRefName}]; merged: [{number,title,headRefName,issue?,closingIssuesReferences?}]
//   mergeLog: [{pr,issue}]; stateJobs: {id:{pr,issue}}; repo: 'owner/name'; jobBase: dashboard path for job pages
export function makeNamer({ repo = null, issues = [], pulls = [], merged = [], mergeLog = [], stateJobs = {}, jobBase = '/work/job/' } = {}) {
  const titles = new Map(issues.map(i => [i.number, i.title]));
  const prIssueMap = new Map();
  const branchIssue = b => { const m = /\/issue-(\d+)(\D|$)/.exec(b || ''); return m ? Number(m[1]) : null; };
  const learn = (pr, n) => { if (isNo(pr) && isNo(n) && !prIssueMap.has(pr)) prIssueMap.set(pr, n); };
  for (const p of pulls) learn(p.number, branchIssue(p.headRefName) ?? p.issue ?? p.closingIssuesReferences?.[0]?.number);
  for (const m of merged) learn(m.number, m.issue ?? branchIssue(m.headRefName) ?? m.closingIssuesReferences?.[0]?.number);
  for (const m of mergeLog) learn(m.pr, m.issue);
  for (const j of Object.values(stateJobs || {})) if (j?.pr != null && j.issue != null) learn(j.pr, j.issue);
  const gh = (kind, n) => (repo ? `https://github.com/${repo}/${kind}/${n}` : null);

  const issueOfPr = pr => { const n = prIssueMap.get(pr); return n == null ? null : { number: n, title: titles.get(n) ?? null }; };
  const make = (build, url) => ({ text: build({}), full: build({ max: Infinity }), url });
  const issue = n => make(o => formatIssue(n, titles.get(n), o), gh('issues', n));
  const pr = n => make(o => formatPr(n, issueOfPr(n), o), gh('pull', n));
  const job = j => {
    const subj = jobSubject(j), id = j.id;
    const issueObj = subj.pr ? issueOfPr(subj.pr) : subj.issue ? { number: subj.issue, title: titles.get(subj.issue) ?? null } : null;
    return make(o => formatJob({ kind: j.kind, id, pr: subj.pr, issue: issueObj }, o), `${jobBase}${shortJob(id)}`);
  };
  const commit = sha => ({ text: shortCommit(sha), full: String(sha ?? ''), url: repo && sha ? gh('commit', sha) : null });
  return { issue, pr, job, commit, issueOfPr, titleOf: n => titles.get(n) ?? null };
}
