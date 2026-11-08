import { spawn } from 'node:child_process';

// Issue #1057 item 2: the deterministic gate of a fix, cifix, implement or review job as one command, so the agent spends one turn
// on it instead of a validator turn, a suite turn and a reading turn. It runs the project validator and then the full suite (through
// `test-slot run`, so the queue and size limits still apply), and prints one compact result with only the failing test names.
export const SUITE_ARGS = ['test-slot', 'run', '--', 'node', '--test', '--test-reporter=dot', 'tests/**/*.test.mjs'];
const TAIL = 4000;

export function failedTests(output) {
  const names = new Set();
  for (const m of String(output).matchAll(/^\s*(?:✖|not ok \d+ -|# Subtest:)\s*(.+)$/gm)) if (m[0].includes('✖') || m[0].includes('not ok')) names.add(m[1].trim());
  return [...names].slice(0, 50);
}

function run(cmd, args, cwd) {
  return new Promise(resolve => {
    let out = '';
    const child = spawn(cmd, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = c => { out = (out + c).slice(-200000); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    child.on('error', e => resolve({ code: 127, out: String(e.message) }));
    child.on('close', code => resolve({ code: code ?? 1, out }));
  });
}

// `exec` is injectable for tests: (cmd, args, cwd) => Promise<{code, out}>.
export async function jobCheck({ worktree, cli, exec = run, node = process.execPath }) {
  const validator = await exec(node, ['tools/validate-project.mjs'], worktree);
  const result = { ok: false, validator: { ok: validator.code === 0, tail: validator.code === 0 ? '' : validator.out.slice(-TAIL) } };
  if (!result.validator.ok) return { ...result, tests: null, next: 'fix the validator failure, then run job-check again' };
  const suite = await exec(node, [cli, ...SUITE_ARGS], worktree);
  const failed = failedTests(suite.out);
  result.tests = { ok: suite.code === 0, exitCode: suite.code, failed, tail: suite.code === 0 ? '' : suite.out.slice(-TAIL) };
  result.ok = result.validator.ok && result.tests.ok;
  result.next = result.ok ? 'gate passed: commit and push' : 'fix the failing tests listed, then run job-check again';
  return result;
}
