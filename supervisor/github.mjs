// GitHub access for the dispatcher: the gh CLI with argument arrays (no shell), GitHub API only, no model call.
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';

export function ghRunner(run = (args, input) => spawnSync('gh', args, { encoding: 'utf8', input, timeout: 60000, maxBuffer: 8 * 1024 * 1024 })) {
  return (args, input) => {
    const r = run(args, input);
    if (r.status !== 0) throw new SupervisorError(`gh ${args.slice(0, 2).join(' ')} failed: ${String(r.stderr || '').split('\n')[0].slice(0, 200)}`);
    return r.stdout;
  };
}

export function githubClient(config, gh = ghRunner()) {
  const repo = config.repository;
  const json = args => JSON.parse(gh(args) || 'null');
  const PR_FIELDS = 'number,title,headRefName,headRefOid,baseRefName,isDraft,mergeable,statusCheckRollup,url';
  return {
    listPulls: async () => json(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', PR_FIELDS]),
    listMergedPulls: async () => json(['pr', 'list', '--repo', repo, '--state', 'merged', '--limit', '100', '--json', 'number,headRefName,closingIssuesReferences']),
    getPull: async n => json(['pr', 'view', String(n), '--repo', repo, '--json', PR_FIELDS]),
    listIssues: async () => json(['issue', 'list', '--repo', repo, '--state', 'all', '--limit', '200', '--json', 'number,title,state,body,labels'])
      .map(i => ({ ...i, labels: (i.labels || []).map(l => l.name) })),
    comment: async (n, body) => { gh(['issue', 'comment', String(n), '--repo', repo, '--body-file', '-'], body); },
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
