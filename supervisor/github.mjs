// GitHub access for the dispatcher: the gh CLI with argument arrays (no shell), GitHub API only, no model call.
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';

const TRANSIENT = /error connecting to|connection (reset|refused|timed out)|timeout|timed out|temporarily unavailable|\bEOF\b|TLS handshake|HTTP 5\d\d|could not resolve host/i;
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

export function githubClient(config, gh = ghRunner()) {
  const repo = config.repository;
  const json = args => JSON.parse(gh(args) || 'null');
  const PR_FIELDS = 'number,title,headRefName,headRefOid,baseRefName,isDraft,mergeable,statusCheckRollup,url';
  return {
    listPulls: async () => json(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', PR_FIELDS]),
    listMergedPulls: async () => json(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '100', '--json', 'number,headRefName,closingIssuesReferences']),
    getMergedPull: async n => json(['pr', 'view', String(n), '--repo', repo, '--json', 'number,state,headRefName,headRefOid,statusCheckRollup']),
    getPull: async n => json(['pr', 'view', String(n), '--repo', repo, '--json', PR_FIELDS]),
    listIssues: async () => json(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '200', '--json', 'number,title,state,body,labels'])
      .map(i => ({ ...i, labels: (i.labels || []).map(l => l.name) })),
    comment: async (n, body) => { gh(['issue', 'comment', String(n), '--repo', repo, '--body-file', '-'], body, { retry: false }); },
    // True when a comment on the issue or PR already contains the text (idempotency check before a non-retried write).
    hasComment: async (n, text) => (json(['issue', 'view', String(n), '--repo', repo, '--json', 'comments'])?.comments || []).some(c => String(c.body || '').includes(text)),
    findIssueByMarker: async marker => json(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '1000', '--json', 'number,body'])
      .find(i => String(i.body || '').includes(marker))?.number || null,
    createIssue: async (title, body) => {
      const url = gh(['issue', 'create', '--repo', repo, '--title', title, '--body-file', '-'], body, { retry: false }).trim();
      const match = /\/issues\/(\d+)$/.exec(url);
      if (!match) throw new SupervisorError('created follow-up issue number was not returned');
      return Number(match[1]);
    },
    addLabel: async (n, label) => {
      gh(['label', 'create', label, '--repo', repo, '--force', '--color', 'B60205', '--description', 'Needs a homeowner decision']);
      gh(['issue', 'edit', String(n), '--repo', repo, '--add-label', label]);
    },
    // --match-head-commit makes GitHub refuse the merge if the head moved after the verdict.
    merge: async (n, head) => { gh(['pr', 'merge', String(n), '--repo', repo, '--merge', '--match-head-commit', head]); },
    board: async (issue, status) => {
      const b = config.board; if (!b || !b.options?.[status]) return;
      const items = json(['project', 'item-list', String(b.number), '--owner', b.owner, '--format', 'json', '--limit', '200']);
      const item = items?.items?.find(i => i.content?.number === issue);
      if (!item) return;
      gh(['project', 'item-edit', '--id', item.id, '--project-id', b.project_id, '--field-id', b.status_field_id, '--single-select-option-id', b.options[status]]);
    }
  };
}
