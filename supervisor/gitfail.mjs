// Issue #692: the text of a failed git call, kept apart from cli.mjs so it can be tested without a repository.
// The live-tick classifier (upgrade.mjs isGithubConnectionError) reads this text, so a network failure must leave words it recognises:
// stderr's first line when git printed one, and an explicit timeout marker when git was killed (a hung fetch prints nothing).
const NETWORK_COMMANDS = new Set(['fetch', 'pull', 'push', 'clone', 'ls-remote']);

export function gitFailureDetail(args, result) {
  const stderrLine = String(result.stderr || '').split('\n').map(l => l.trim()).find(l => l) || '';
  const timedOut = result.error?.code === 'ETIMEDOUT' || result.signal === 'SIGTERM';
  // Only a network command's timeout says anything about connectivity; a local command that hangs is a real fault.
  if (!stderrLine && timedOut && NETWORK_COMMANDS.has(args[0])) return 'timed out (ETIMEDOUT)';
  if (!stderrLine && timedOut) return 'timed out';
  return stderrLine.replace(/\/\/[^/@\s]*@/g, '//').slice(0, 300);
}

export function gitFailureMessage(args, result) {
  const detail = gitFailureDetail(args, result);
  return `git ${args[0]} failed${detail ? `: ${detail}` : ''}`;
}
