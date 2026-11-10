// The home folder whose agent session logs Foreman reads (Codex rollouts, Claude Code projects). A test must never read the
// real account's sessions or allowance: tests run on Tower, where those files are live. Under the Node test runner
// (NODE_TEST_CONTEXT, inherited by every process a test starts) the account's own home is refused, so a test that did not
// isolate HOME fails instead of reading live data.
import os from 'node:os';
import path from 'node:path';

export function agentHome({ env = process.env, accountHome = os.userInfo().homedir } = {}) {
  const home = env.HOME || os.homedir();
  if (env.NODE_TEST_CONTEXT && path.resolve(home) === path.resolve(accountHome)) {
    const fix = 'give the test its own HOME (tests/helpers/isolated-env.mjs)';
    throw new Error(`refusing to read agent sessions under the account home ${home} from a test run: ${fix}`);
  }
  return home;
}
