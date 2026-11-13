// Issue #1157: the two GitHub writes close_superseded needs and the shared client does not have: keep a pull request's branch under saved/, and
// close an issue or pull request. Arguments go as an array to gh (no shell); numbers and the sha are shape-checked first.
import { ghRunner } from './github.mjs';
import { SupervisorError } from './core.mjs';

const SHA = /^[0-9a-f]{40}$/;
const NUMBER = n => Number.isSafeInteger(n) && n > 0;

export function closeWrites(repository, gh = ghRunner()) {
  const json = args => JSON.parse(gh(args) || 'null');
  return {
    // Creates refs/heads/<name> at sha. A name that already points at the same sha is a repeat and succeeds; another sha is refused.
    saveBranch: async (name, sha) => {
      if (!SHA.test(String(sha)) || !/^saved\/[A-Za-z0-9._-]+$/.test(String(name))) throw new SupervisorError('invalid branch to save');
      let existing = null;
      try { existing = json(['api', '--method', 'GET', `repos/${repository}/git/ref/heads/${name}`]); } catch { /* not found: create it */ }
      if (existing) {
        if (existing.object?.sha === sha) return 'exists';
        throw new SupervisorError(`${name} already exists at another commit`);
      }
      gh(['api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', `ref=refs/heads/${name}`, '-f', `sha=${sha}`], undefined, { retry: false });
      return 'created';
    },
    closeItem: async (n, kind) => {
      if (!NUMBER(n)) throw new SupervisorError('invalid number');
      if (kind === 'pull') gh(['pr', 'close', String(n), '--repo', repository], undefined, { retry: false });
      else gh(['issue', 'close', String(n), '--repo', repository, '--reason', 'not planned'], undefined, { retry: false });
    },
  };
}
