// Issue #1306: the few GitHub calls the work_item.close_reason command makes, run with an asynchronous gh process so the dashboard
// server keeps answering while a sweep of many issues is recorded. (githubClient in github.mjs uses spawnSync and sleeps with
// Atomics.wait, which blocks the whole process.) gh is called with argument arrays, no shell.
import { spawn } from 'node:child_process';
import { SupervisorError } from './core.mjs';
import { redactTopology } from './redact.mjs';

const TIMEOUT_MS = 60000;
const ISSUE_FIELDS = 'number,title,state,stateReason';

// Runs gh and resolves with its stdout. `start` is the process starter (a test replaces it).
export function asyncGh(args, input, start = spawn) {
  return new Promise((resolve, reject) => {
    const child = start('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: TIMEOUT_MS });
    let out = '';
    let err = '';
    child.stdout.on('data', chunk => { out += chunk; });
    child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', error => reject(new SupervisorError(error.code === 'ENOENT' ? 'required binary not found: gh' : `gh failed: ${error.message}`)));
    child.on('close', code => {
      if (code === 0) resolve(out);
      else reject(new SupervisorError(`gh ${args.slice(0, 2).join(' ')} failed: ${err.split('\n')[0].slice(0, 200)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

export function asyncGithubClient(config, gh = asyncGh) {
  const repo = config.repository;
  const json = async args => JSON.parse((await gh(args)) || 'null');
  return {
    getIssue: async n => json(['issue', 'view', String(n), '--repo', repo, '--json', ISSUE_FIELDS]),
    hasComment: async (n, text) => ((await json(['issue', 'view', String(n), '--repo', repo, '--json', 'comments']))?.comments || [])
      .some(c => String(c.body || '').includes(text)),
    // Not retried: the response may be lost after GitHub accepted it, and the caller checks hasComment before a second try.
    comment: async (n, body) => { await gh(['issue', 'comment', String(n), '--repo', repo, '--body-file', '-'], redactTopology(body)); },
  };
}
