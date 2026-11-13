// Issue #1240: closes a pull request with a comment. The branch is never deleted, so the work stays recoverable.
import { redactTopology } from './redact.mjs';

export const closeFacts = (repo, gh) => ({
  closePull: async (n, comment) => { gh(['pr', 'close', String(n), '--repo', repo, '--comment', redactTopology(comment)], undefined, { retry: false }); },
});
