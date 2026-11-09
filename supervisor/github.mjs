// GitHub access for the dispatcher: the gh CLI with argument arrays (no shell), GitHub API only, no model call.
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';
import { isStatusIssue } from './statusissue.mjs';
import { redactTopology } from './redact.mjs';

const TRANSIENT = /error connecting to|connection (reset|refused|timed out)|timeout|timed out|temporarily unavailable|\bEOF\b|TLS handshake|HTTP 5\d\d|could not resolve host/i;
export const isRateLimit = text => /rate limit/i.test(String(text || ''));
export const isTransient = text => TRANSIENT.test(String(text || ''));
const realSleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// A missing gh is named, not reported as an empty failure (issue #35). Transient transport errors are retried within the
// tick (bounded: `tries` attempts with doubling backoff) before the call fails; other failures fail at once.
export function ghRunner(run = (args, input) => spawnSync('gh', args, { encoding: 'utf8', input, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }), { tries = 3, backoffMs = 1000, sleep = realSleep } = {}) {
  // `retry: false` is for non-idempotent writes (a comment): the response may be lost after GitHub accepted the request,
  // so the caller reconciles against GitHub instead of blindly sending it again.
  return (args, input, { retry = true } = {}) => {
    for (let attempt = 1; ; attempt++) {
      const r = run(args, input);
      if (r.error?.code === 'ENOENT') throw new SupervisorError(`required binary not found: gh (PATH=${String(process.env.PATH || '').slice(0, 200)})`);
      if (r.status === 0) return r.stdout;
      const detail = String(r.stderr || r.error?.message || '').split('\n')[0].slice(0, 200);
      if (retry && attempt < tries && isTransient(detail)) { sleep(backoffMs * 2 ** (attempt - 1)); continue; }
      throw new SupervisorError(`gh ${args.slice(0, 2).join(' ')} failed: ${detail}`);
    }
  };
}

// issue #1103: stateReason says whether an issue closed as completed or not planned; closedBy... names the pull requests that closed it
const ISSUE_FIELDS = 'number,title,state,stateReason,body,labels,closedByPullRequestsReferences';
// state and mergeCommit: issue #1103 reads old merged prerequisites by number
const PULL_FIELDS = [
  'number,title,headRefName,headRefOid,baseRefName,isDraft,mergeable,mergeStateStatus,statusCheckRollup,url,labels',
  'closingIssuesReferences,createdAt,state,mergeCommit'
].join(',');
export function githubClient(config, gh = ghRunner()) {
  const repo = config.repository;
  const boardItems = new Map();
  const json = args => JSON.parse(gh(args) || 'null');
  const PR_FIELDS = PULL_FIELDS;
  const withLabels = prs => (Array.isArray(prs) ? prs.map(p => ({ ...p, labels: (p.labels || []).map(l => (typeof l === 'string' ? l : l.name)) })) : prs);
  return {
    listPulls: async () => withLabels(json(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', PR_FIELDS])),
    listLabels: async () => (json(['label', 'list', '--repo', repo, '--limit', '200', '--json', 'name']) || []).map(l => l.name),
    listMergedPulls: async () => json(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '100', '--json', 'number,title,headRefName,mergedAt,mergeCommit,closingIssuesReferences']),
    listClosedPulls: async () => json(['pr', 'list', '--repo', repo, '--state', 'closed', '--limit', '100', '--json', 'number,headRefName,mergedAt']),   // closed, not merged (issue #521)
    getMergedPull: async n => json(['pr', 'view', String(n), '--repo', repo, '--json', 'number,state,headRefName,headRefOid,statusCheckRollup']),
    // Check runs of any app (issue #142), including third-party checks such as GitGuardian that gh run view cannot show.
    listCheckRuns: async sha => { if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new SupervisorError('invalid commit sha'); return json(['api', '--method', 'GET', `repos/${repo}/commits/${sha}/check-runs`, '-f', 'per_page=100'])?.check_runs || []; },
    commitTime: async sha => { if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new SupervisorError('invalid commit sha'); const t = Date.parse(json(['api', '--method', 'GET', `repos/${repo}/commits/${sha}`])?.commit?.committer?.date); return Number.isFinite(t) ? t : null; },
    pullBody: async n => { const b = json(['pr', 'view', String(n), '--repo', repo, '--json', 'body'])?.body; return typeof b === 'string' ? b : ''; },
    listPullFiles: async n => (json(['pr', 'view', String(n), '--repo', repo, '--json', 'files'])?.files || []).map(f => String(f.path)),
    getPull: async n => { const p = json(['pr', 'view', String(n), '--repo', repo, '--json', PR_FIELDS]); return p ? withLabels([p])[0] : p; },
    // The pinned status issue (#358) is Foreman's own output, never work: it is dropped here so no planner or view sees it.
    // Issue #414: every OPEN issue is fetched (up to 1000, its own call), plus the newest 200 of any state for recently closed
    // prerequisites, so a labelled open issue cannot fall out of a 200 cap when newer issues crowd it out.
    listIssues: async () => {
      const list = state => json(['issue', 'list', '--repo', repo, '--state', state, '--limit', state === 'open' ? '1000' : '200', '--json', ISSUE_FIELDS + ',createdAt,closedAt']) || [];
      const byNo = new Map();
      for (const i of [...list('open'), ...list('all')]) byNo.set(i.number, i);
      return [...byNo.values()].filter(i => !isStatusIssue(i)).map(i => ({ ...i, labels: (i.labels || []).map(l => l.name) }));
    },
    // One issue by number, for when it is not in the capped list.
    getIssue: async n => { const i = json(['issue', 'view', String(n), '--repo', repo, '--json', ISSUE_FIELDS]); return i ? { ...i, labels: (i.labels || []).map(l => l.name) } : null; },
    // The association of the issue's author with the repository (OWNER = the homeowner); the issue body counts as homeowner text only when OWNER (issue #299).
    issueAuthorAssociation: async n => { if (!Number.isSafeInteger(n) || n < 1) throw new SupervisorError('invalid issue number'); return json(['api', '--method', 'GET', `repos/${repo}/issues/${n}`])?.author_association ?? null; },
    // Comments with the author's association to the repository (OWNER = the homeowner), to tell homeowner-required text apart.
    issueComments: async n => (json(['issue', 'view', String(n), '--repo', repo, '--json', 'comments'])?.comments || []).map(c => ({ association: c.authorAssociation, body: String(c.body || '') })),
    // Issue #418: the comments of one PR with author login, time and URL (one call), and one comment by id (to verify a cited link).
    prComments: async n => (json(['pr', 'view', String(n), '--repo', repo, '--json', 'comments'])?.comments || []).map(c => ({ login: c.author?.login ?? null, createdAt: c.createdAt, url: String(c.url || ''), body: String(c.body || '') })),
    getComment: async id => {
      if (!/^\d+$/.test(String(id))) throw new SupervisorError('invalid comment id');
      const c = json(['api', '--method', 'GET', `repos/${repo}/issues/comments/${id}`]);
      return c ? { login: c.user?.login ?? null, createdAt: c.created_at, url: String(c.html_url || ''), body: String(c.body || '') } : null;
    },
    comment: async (n, body) => { gh(['issue', 'comment', String(n), '--repo', repo, '--body-file', '-'], redactTopology(body), { retry: false }); },
    // True when a comment on the issue or PR already contains the text (idempotency check before a non-retried write).
    hasComment: async (n, text) => (json(['issue', 'view', String(n), '--repo', repo, '--json', 'comments'])?.comments || []).some(c => String(c.body || '').includes(text)),
    findIssueByMarker: async marker => json(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', 'number,body'])
      .find(i => String(i.body || '').includes(marker))?.number || null,
    // Issue #864: the open issue carrying a marker, with its body (the batched follow-up issue of an area).
    findOpenIssueByMarker: async (marker, skip = []) => { const i = json(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '1000', '--json', 'number,body']).find(x => !skip.includes(x.number) && String(x.body || '').includes(marker)); return i ? { number: i.number, body: String(i.body || '') } : null; },
    createIssue: async (title, body) => {
      const url = gh(['issue', 'create', '--repo', repo, '--title', redactTopology(title), '--body-file', '-'], redactTopology(body), { retry: false }).trim();
      const match = /\/issues\/(\d+)$/.exec(url);
      if (!match) throw new SupervisorError('created follow-up issue number was not returned');
      return Number(match[1]);
    },
    updateIssueBody: async (n, body) => { if (!Number.isSafeInteger(n) || n < 1) throw new SupervisorError('invalid issue number'); gh(['issue', 'edit', String(n), '--repo', repo, '--body-file', '-'], redactTopology(body)); },
    pinIssue: async n => { if (!Number.isSafeInteger(n) || n < 1) throw new SupervisorError('invalid issue number'); gh(['issue', 'pin', String(n), '--repo', repo]); },
    addLabel: async (n, label, { create = true } = {}) => {   // issue #1115: create:false adds an existing label (parked) without recolouring it
      if (create) gh(['label', 'create', label, '--repo', repo, '--force', '--color', 'B60205', '--description', 'Needs a homeowner decision']);
      gh(['issue', 'edit', String(n), '--repo', repo, '--add-label', label]);
    },
    // --match-head-commit makes GitHub refuse the merge if the head moved after the verdict.
    removeLabel: async (n, label) => { gh(['issue', 'edit', String(n), '--repo', repo, '--remove-label', label]); },
    rerunRun: async runId => { if (!/^\d+$/.test(String(runId))) throw new SupervisorError('invalid run id'); gh(['run', 'rerun', String(runId), '--repo', repo], undefined, { retry: false }); },
    merge: async (n, head) => { gh(['pr', 'merge', String(n), '--repo', repo, '--merge', '--match-head-commit', head]); },
    // Issue #881: issue -> project item id is cached, and a miss looks up that one issue's item directly. A rate-limit failure carries the reset time
    // (`error.rateLimitedUntil`, ms) so the caller can pause board updates until then; any other failure is a plain error.
    board: async (issue, status) => {
      const b = config.board; if (!b || !b.options?.[status]) return;
      try {
        let id = boardItems.get(issue);
        if (!id) {
          // A direct lookup of this one issue's project item: no whole-board listing, so no 200-item cap on a large board.
          const [owner, name] = repo.split('/');
          const q = 'query($o:String!,$r:String!,$n:Int!){repository(owner:$o,name:$r){issue(number:$n){projectItems(first:50){nodes{id project{id}}}}}}';
          const found = json(['api', 'graphql', '-f', `query=${q}`, '-F', `o=${owner}`, '-F', `r=${name}`, '-F', `n=${issue}`]);
          id = (found?.data?.repository?.issue?.projectItems?.nodes || []).find(n => n?.project?.id === b.project_id)?.id;
          if (!id) throw new SupervisorError(`issue #${issue} was not found on the project board`);   // a warning and a retry, never a silent success
          boardItems.set(issue, id);
        }
        try { gh(['project', 'item-edit', '--id', id, '--project-id', b.project_id, '--field-id', b.status_field_id, '--single-select-option-id', b.options[status]]); }
        catch (error) { if (!isRateLimit(error.message)) boardItems.delete(issue); throw error; }   // a stale id is looked up again next time
      } catch (error) {
        if (!isRateLimit(error.message)) throw error;
        let reset = null;
        try { const s = Number(JSON.parse(gh(['api', 'rate_limit', '--jq', '.resources.graphql']) || 'null')?.reset); if (Number.isFinite(s) && s > 0) reset = s * 1000; } catch { /* the REST limit is separate; fall back below */ }
        const e = new SupervisorError(error.message); e.rateLimitedUntil = reset ?? Date.now() + 15 * 60000; throw e;
      }
    }
  };
}
