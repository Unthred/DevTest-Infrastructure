// Issue #1337: the GitHub writes close_superseded needs and the shared client does not have: keep a pull request's branch under saved/, and
// close a pull request or close an issue as not planned. It takes the gh runner as an argument; the shared client passes the counting runner,
// so these calls appear in the run statistics. Arguments go as an array to gh (no shell); numbers, names and the sha are shape-checked first.
import { SupervisorError } from './core.mjs';

export const SAVED_PREFIX = 'saved/';
const SHA = /^[0-9a-f]{40}$/;
const SAVED_NAME = /^saved\/(?!.*\.\.)[A-Za-z0-9._-]{1,200}$/;
const NUMBER = n => Number.isSafeInteger(n) && n > 0;

export function closeWrites(repository, gh) {
  const json = args => JSON.parse(gh(args) || 'null');
  return {
    // Creates refs/heads/<name> at sha. A name already at the same sha is a repeat and returns 'exists'; another sha is refused.
    saveBranch: async (name, sha) => {
      if (!SHA.test(String(sha)) || !SAVED_NAME.test(String(name))) throw new SupervisorError('invalid branch to save');
      let existing = null;
      try { existing = json(['api', '--method', 'GET', `repos/${repository}/git/ref/heads/${name}`]); } catch { /* not found: create it */ }
      if (existing) {
        if (existing.object?.sha === sha) return 'exists';
        throw new SupervisorError(`${name} already exists at another commit`);
      }
      gh(['api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/heads/${name}`, '-f', `sha=${sha}`], undefined, { retry: false });
      return 'created';
    },
    // kind 'pull' closes a pull request; kind 'issue' closes an issue as not planned.
    closeItem: async (n, kind) => {
      if (!NUMBER(n)) throw new SupervisorError('invalid number');
      if (kind === 'pull') gh(['pr', 'close', String(n), '--repo', repository], undefined, { retry: false });
      else if (kind === 'issue') gh(['issue', 'close', String(n), '--repo', repository, '--reason', 'not planned'], undefined, { retry: false });
      else throw new SupervisorError('invalid item kind');
    },
  };
}
