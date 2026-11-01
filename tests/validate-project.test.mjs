// Positive and negative tests for tools/validate-project.mjs.
// Every case works on an independent temporary copy (no Git, no linked worktree) so a fixture can never touch a real branch.
// Forbidden strings (secrets, socket, privileged, unpinned images) are assembled at run time so this file stays clean under its own scan.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate, REQUIRED_FILES } from '../tools/validate-project.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cli = path.join(repo, 'tools', 'validate-project.mjs');

function fixture(mutate = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-validate-'));
  fs.cpSync(repo, dir, { recursive: true, filter: (src) => !['.git', 'node_modules'].includes(path.basename(src)) });
  const api = {
    dir,
    read: (f) => fs.readFileSync(path.join(dir, f), 'utf8'),
    write: (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); },
    edit: (f, a, b) => { const s = api.read(f); assert.ok(s.includes(a), `fixture edit target missing in ${f}: ${a}`); api.write(f, s.replace(a, b)); },
    remove: (f) => fs.rmSync(path.join(dir, f))
  };
  mutate(api);
  return api;
}
function checks(api) { return validate(api.dir).map((f) => f.check); }
function expectFinding(mutate, check, messagePart) {
  const api = fixture(mutate);
  try {
    const findings = validate(api.dir);
    const hit = findings.find((f) => f.check === check && (!messagePart || f.message.includes(messagePart)));
    assert.ok(hit, `expected [${check}] ${messagePart || ''}; got ${JSON.stringify(findings)}`);
  } finally { fs.rmSync(api.dir, { recursive: true, force: true }); }
}
function expectClean(mutate) {
  const api = fixture(mutate);
  try { assert.deepEqual(validate(api.dir), []); } finally { fs.rmSync(api.dir, { recursive: true, force: true }); }
}
const sock = ['/var/run/docker', 'sock'].join('.');
const priv = ['--priv', 'ileged'].join('');

test('the real project is valid', () => { assert.deepEqual(validate(repo), []); });

test('every required file is individually required', () => {
  for (const f of REQUIRED_FILES) expectFinding((a) => a.remove(f), 'required-files', f);
});

test('decision register: structural defects are rejected', () => {
  expectFinding((a) => a.edit('docs/DECISIONS.md', '## D-002 — Two', '## D-001 — Two'), 'decisions', 'duplicate id D-001');
  expectFinding((a) => a.edit('docs/DECISIONS.md', 'Status: agent-proposal', 'Status: probably-fine'), 'decisions', 'invalid status');
  expectFinding((a) => a.edit('docs/DECISIONS.md', 'Date: 2026-10-29', 'Date: yesterday'), 'decisions', 'date must be');
  expectFinding((a) => a.edit('docs/DECISIONS.md', '- Rejected: Per-agent scripts; ad-hoc `docker run` invocations by agents; a second launcher.\n', ''), 'decisions', 'missing rejected');
  expectFinding((a) => a.edit('docs/DECISIONS.md', 'Source: homeowner brief 2026-10-29; README; issue #8', 'Source: none'), 'decisions', 'real source');
  expectFinding((a) => a.edit('docs/DECISIONS.md', '- Superseded-by: none', '- Superseded-by: D-099'), 'decisions', 'does not exist');
  expectFinding((a) => a.edit('docs/DECISIONS.md', '## D-003 —', '## D-005 —'), 'decisions');
});

test('a superseding entry that exists is accepted', () => {
  expectClean((a) => a.edit('docs/DECISIONS.md', '- Superseded-by: none\n\n## D-002', '- Superseded-by: D-002\n\n## D-002'));
});

test('handover: completion states, decision link, blockers and next actions are required', () => {
  // Remove every occurrence (any case): the validator accepts the phrase anywhere in the file, and handover prose may repeat it.
  expectFinding((a) => a.write('docs/ai/CURRENT_HANDOVER.md', a.read('docs/ai/CURRENT_HANDOVER.md').replace(/verified working/gi, 'seems fine')), 'handover', 'verified working');
  expectFinding((a) => a.edit('docs/ai/CURRENT_HANDOVER.md', '[docs/DECISIONS.md](../DECISIONS.md)', 'the register'), 'handover', 'decision register');
  expectFinding((a) => a.edit('docs/ai/CURRENT_HANDOVER.md', '## Blockers', '## Problems'), 'handover', 'Blockers');
  expectFinding((a) => a.edit('docs/ai/CURRENT_HANDOVER.md', '## Next actions', '## Later'), 'handover', 'Next actions');
});

test('entry points: CLAUDE.md pointer and AGENTS.md rules are required', () => {
  expectFinding((a) => a.write('CLAUDE.md', 'Read AGENTS.md\n'), 'entrypoints', '@AGENTS.md');
  expectFinding((a) => a.edit('AGENTS.md', 'One writer per worktree', 'Share worktrees'), 'entrypoints', 'worktree rule');
  expectFinding((a) => a.edit('AGENTS.md', 'OpenBao only', 'Anything'), 'entrypoints', 'secrets rule');
  expectFinding((a) => a.edit('AGENTS.md', 'No Docker socket, no privileged containers', 'Containers are fine'), 'entrypoints', 'Docker socket rule');
  expectFinding((a) => a.edit('AGENTS.md', 'No AI attribution', 'Credit is fine'), 'entrypoints', 'attribution rule');
});

test('contracts: exit-code table and JSON must agree and be unique', () => {
  expectFinding((a) => a.edit('docs/cli-contract.md', '| 4 | policy_refused |', '| 4 | refused_by_policy |'), 'contracts', 'differ');
  expectFinding((a) => { const j = JSON.parse(a.read('contracts/cli.v1.json')); j.exit_codes[2].code = 1; a.write('contracts/cli.v1.json', JSON.stringify(j)); }, 'contracts', 'duplicate exit code');
  expectFinding((a) => a.write('contracts/cli.v1.json', '{ not json'), 'contracts', 'not valid JSON');
});

test('contracts: provider manifests are validated against the schema', () => {
  const mutateExample = (fn) => (a) => { const j = JSON.parse(a.read('contracts/examples/codex.provider.json')); fn(j); a.write('contracts/examples/codex.provider.json', JSON.stringify(j)); };
  expectFinding(mutateExample((j) => { j.surprise = true; }), 'contracts', 'unknown field "surprise"');
  expectFinding(mutateExample((j) => { j.billing.fallback_to_other_billing = true; }), 'contracts', 'fallback_to_other_billing');
  expectFinding(mutateExample((j) => { delete j.capabilities.checkpoint; }), 'contracts', 'missing required "checkpoint"');
  expectFinding(mutateExample((j) => { j.capabilities.resume = 'yes'; }), 'contracts', 'resume');
  expectFinding(mutateExample((j) => { j.id = 'Not Valid'; }), 'contracts', 'id');
  expectFinding(mutateExample((j) => { j.billing.model = 'free'; }), 'contracts', 'billing.model');
});

test('secrets: real credential shapes are found, placeholders are not', () => {
  const rnd = (n) => 'aB3dE5gH7jK9mN1pQ3sT5vX7zC9fL2hR4tW6yU8iO0'.slice(0, n);
  for (const [label, text] of [
    ['GitHub token', `token_value ${['gh', 'p_'].join('')}${rnd(36)}`],
    ['private key block', ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')],
    ['OpenBao/Vault token', `x ${['hv', 's.'].join('')}${rnd(26)}`],
    ['AWS access key id', `k ${['AK', 'IA'].join('')}ABCDEFGHIJKLMNOP`],
    ['bearer credential', `Authorization: ${['Bear', 'er'].join('')} ${rnd(30)}`],
    ['assigned credential', `${['pass', 'word'].join('')}=${rnd(16)}`]
  ]) expectFinding((a) => a.write('notes/leak.txt', `${text}\n`), 'secrets', label);
  expectClean((a) => a.write('notes/ok.md', 'password: <from OpenBao>\ntoken: ${OPENBAO_TOKEN}\napi_key=REDACTED-value-here\n'));
});

test('docker safety: socket and privileged use are rejected outside prohibitions', () => {
  expectFinding((a) => a.write('run/compose.yml', `volumes:\n  - ${sock}:${sock}\n`), 'docker-safety', 'Docker socket');
  expectFinding((a) => a.write('run/start.sh', `docker run ${priv} x\n`), 'docker-safety', 'privileged');
  expectFinding((a) => a.write('docs/loose.md', `Mount ${sock} into the container.\n`), 'docker-safety');
  expectClean((a) => a.write('docs/ok.md', `Never mount ${sock}; containers must not run ${priv}.\n`));
});

test('image pinning: tags without a digest are rejected', () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  expectFinding((a) => a.write('docker/Dockerfile', ['FROM', 'mcr.example/dotnet/sdk:8.0'].join(' ') + '\n'), 'image-pinning', 'dotnet/sdk:8.0');
  expectFinding((a) => a.write('run/compose.yml', ['  image:', 'mcr.example/pw:v1'].join(' ') + '\n'), 'image-pinning');
  for (const bad of ['sha256:abc', `sha256:${'a'.repeat(63)}`, `sha256:${'a'.repeat(65)}`, `sha256:${'A'.repeat(64)}`, `sha256:${'g'.repeat(64)}`])
    expectFinding((a) => a.write('docker/Dockerfile', ['FROM', `mcr.example/dotnet/sdk:8.0@${bad}`].join(' ') + '\n'), 'image-pinning', 'not pinned');
  expectFinding((a) => a.write('run/compose.yml', ['  image:', `mcr.example/pw:v1@sha256:${'a'.repeat(64)}extra`].join(' ') + '\n'), 'image-pinning');
  expectClean((a) => a.write('docker/Dockerfile', ['FROM', `mcr.example/dotnet/sdk:8.0@${digest}`].join(' ') + '\n'));
  expectClean((a) => a.write('docker/Dockerfile', ['FROM', 'scratch'].join(' ') + '\n'));
  expectClean((a) => a.write('docker/Dockerfile', ['ARG', 'BASE'].join(' ') + '\n' + ['FROM', '$BASE'].join(' ') + '\n'));
});

test('example manifests never claim an unverified capability as supported (D-012)', () => {
  const claude = JSON.parse(fs.readFileSync(path.join(repo, 'contracts/examples/claude.provider.json'), 'utf8'));
  assert.equal(claude.capabilities.resume, 'unverified');
  assert.equal(claude.capabilities.session_status, 'unverified');
  assert.equal(claude.capabilities.usage_limit_detection, 'unverified');
});

test('CLI exit codes: 0 valid, 1 findings, 2 bad usage', () => {
  assert.equal(spawnSync('node', [cli, repo]).status, 0);
  const bad = fixture((a) => a.remove('docs/DECISIONS.md'));
  try {
    const r = spawnSync('node', [cli, bad.dir], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FAIL \[required-files\] missing docs\/DECISIONS\.md/);
  } finally { fs.rmSync(bad.dir, { recursive: true, force: true }); }
  assert.equal(spawnSync('node', [cli, '/nonexistent/devtest-dir']).status, 2);
});

test('fixtures leave the real repository untouched', () => {
  const before = checks({ dir: repo });
  const api = fixture((a) => a.remove('README.md'));
  fs.rmSync(api.dir, { recursive: true, force: true });
  assert.ok(fs.existsSync(path.join(repo, 'README.md')));
  assert.deepEqual(checks({ dir: repo }), before);
});
