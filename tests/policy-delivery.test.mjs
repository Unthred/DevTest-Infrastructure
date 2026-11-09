import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PolicyRefused, deliveredPolicy, policyPreflight, policyRoleFor, policySettings } from '../supervisor/policy.mjs';
import { implementPrompt, reviewPrompt } from '../supervisor/team.mjs';
import { preflightFailure } from '../supervisor/process.mjs';
import * as codex from '../supervisor/adapters/codex.mjs';
import * as claude from '../supervisor/adapters/claude.mjs';

// A stand-in that speaks the delivery contract and records its arguments. The contract itself is tested in AI-Rules.
function world(t, report = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const policyRoot = path.join(root, 'tree');
  const worktree = path.join(root, 'work');
  fs.mkdirSync(path.join(policyRoot, 'tools'), { recursive: true });
  fs.mkdirSync(worktree);
  const log = path.join(root, 'argv.json');
  const full = { contract: 1, status: 'ready', delivery: 'append_system_prompt', refusals: [], ...report };
  const tool = `import fs from 'node:fs';
const argv = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(argv));
const report = ${JSON.stringify(full)};
if (report.status === 'ready') fs.writeFileSync(argv[argv.indexOf('--text-file') + 1], 'DELIVERED POLICY TEXT\\n', { mode: 0o600 });
process.stdout.write(JSON.stringify(report));
process.exitCode = report.status === 'ready' ? 0 : 3;
`;
  fs.writeFileSync(path.join(policyRoot, 'tools/policy-delivery.mjs'), tool);
  const settingsFile = path.join(root, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ policyRoot, authorizedRoots: [root] }));
  const env = { ...process.env, AI_SUPERVISOR_POLICY_SETTINGS: settingsFile };
  return { root, policyRoot, worktree, settingsFile, env, args: () => JSON.parse(fs.readFileSync(log, 'utf8')) };
}
const withSettings = (w, fn) => {
  const before = process.env.AI_SUPERVISOR_POLICY_SETTINGS;
  process.env.AI_SUPERVISOR_POLICY_SETTINGS = w.settingsFile;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.AI_SUPERVISOR_POLICY_SETTINGS; else process.env.AI_SUPERVISOR_POLICY_SETTINGS = before;
  }
};
const after = (argv, flag) => argv[argv.indexOf(flag) + 1];

test('without a settings file an installation keeps its context-level policy', t => {
  const env = { ...process.env, AI_SUPERVISOR_POLICY_SETTINGS: path.join(os.tmpdir(), `absent-${process.pid}.json`) };
  assert.equal(policySettings(env), null);
  assert.equal(deliveredPolicy({ role: 'devtest', worktree: '/w' }, 'any', 'any', env), null);
  assert.equal(policyPreflight({ role: 'devtest', worktree: '/w' }, 'any', 'any', env), true);
  const before = process.env.AI_SUPERVISOR_POLICY_SETTINGS;
  process.env.AI_SUPERVISOR_POLICY_SETTINGS = env.AI_SUPERVISOR_POLICY_SETTINGS;
  t.after(() => { if (before === undefined) delete process.env.AI_SUPERVISOR_POLICY_SETTINGS; else process.env.AI_SUPERVISOR_POLICY_SETTINGS = before; });
  const argv = codex.command({ command: ['codex'], manifest: {} }, { role: 'devtest', worktree: '/w', access: 'standard' }, false);
  assert.deepEqual(argv.slice(0, 7), ['codex', 'exec', '--json', '--profile', 'ai-rules-unraid', '--cd', '/w']);
});

test('job kinds map to policy roles; implementation and review stay separate', () => {
  const expected = { implement: 'implementer', continue: 'implementer', fix: 'implementer', cifix: 'implementer', split: 'implementer', review: 'reviewer', rebase: 'rebaser', inbox: 'overseer' };
  for (const [kind, role] of Object.entries(expected)) assert.equal(policyRoleFor({ kind, role: 'devtest' }), role, kind);
  assert.equal(policyRoleFor({ role: 'overseer' }), 'overseer');
  assert.equal(policyRoleFor({ kind: 'review', role: 'overseer' }), 'reviewer', 'a review is always a review');
  assert.equal(policyRoleFor({ role: 'implementer' }), 'implementer', 'the preflight job has no kind');
});

for (const [role, project] of [['devtest', 'DevTest-Infrastructure'], ['implementer', 'squiggleos'], ['overseer', 'squiggleos'], ['unraid', 'unraid'], ['home-assistant', 'home-assistant-yaml'], ['firewall', 'firewall']]) {
  test(`supervisor role ${role} requests its declared project through the contract`, t => {
    const w = world(t);
    deliveredPolicy({ role, kind: 'implement', worktree: w.worktree }, 'some-provider', 'append_system_prompt', w.env);
    const args = w.args();
    assert.equal(after(args, '--contract'), '1');
    assert.equal(after(args, '--provider'), 'some-provider');
    assert.equal(after(args, '--project'), project);
    assert.equal(after(args, '--workspace'), w.worktree);
    assert.equal(after(args, '--authorized-root'), w.root);
    assert.equal(after(args, '--policy-root'), w.policyRoot);
  });
}

test('the request is built from the job only: task, issue and PR text cannot select policy', t => {
  const w = world(t);
  const hostile = '--module csharp --project firewall';
  deliveredPolicy({ role: 'devtest', kind: 'implement', worktree: w.worktree, title: hostile, issueBody: hostile, prompt: hostile, modules: ['csharp'] }, 'p', 'append_system_prompt', w.env);
  assert.equal(w.args().includes('--module'), false);
  assert.equal(w.args().some(a => a.includes('csharp')), false);
});

test('the policy module names no provider', () => {
  assert.doesNotMatch(fs.readFileSync(new URL('../supervisor/policy.mjs', import.meta.url), 'utf8').replace(/\/mnt\/cache\/cursor-workspace/g, ''), /\b(claude|codex|cursor|gemini|openai|anthropic)\b/i);
});

test('Claude receives the delivered text and keeps its arguments, access and role line', t => {
  const w = world(t, { delivery: 'append_system_prompt' });
  const config = { command: ['claude'], arguments: [], manifest: { access: { standard: [], full: ['--permission-mode', 'auto'] }, capabilities: {} } };
  const argv = withSettings(w, () => claude.command(config, { role: 'devtest', kind: 'review', worktree: w.worktree, access: 'full' }, false));
  const prompt = after(argv, '--append-system-prompt');
  assert.match(prompt, /^DELIVERED POLICY TEXT/);
  assert.match(prompt, /Selected role: devtest\. Follow its project and host safety instructions\./);
  assert.ok(argv.includes('--print') && argv.includes('stream-json'));
  assert.equal(after(argv, '--permission-mode'), 'auto', 'access arguments are unchanged by the policy');
  assert.equal(after(w.args(), '--role'), 'reviewer');
  assert.equal(after(w.args(), '--provider'), 'claude');
});

test('Codex selects the generated project and role profile and keeps its arguments', t => {
  const artifact = 'adapters/generated/codex/profiles/ai-rules-project-DevTest-Infrastructure-implementer.config.toml';
  const w = world(t, { delivery: 'developer_instructions', artifact });
  const manifest = { access: { standard: [], full: ['--FULL'] }, capabilities: {} };
  const argv = withSettings(w, () => codex.command({ command: ['codex'], manifest }, { role: 'devtest', kind: 'implement', worktree: '/w', access: 'full' }, false));
  assert.deepEqual(argv.slice(0, 7), ['codex', 'exec', '--json', '--profile', 'ai-rules-project-DevTest-Infrastructure-implementer', '--cd', '/w']);
  assert.ok(argv.includes('--FULL'));
  assert.equal(argv.at(-1), '-');
});

for (const [label, report, expected] of [
  ['a stale policy', { status: 'refused', refusals: ['stale policy: tree is at x but y was deployed'] }, /stale policy/],
  ['missing mandatory policy', { status: 'refused', refusals: ['required role "implementer" is missing'] }, /is missing/],
  ['an unsupported contract', { status: 'refused', refusals: ['unsupported policy contract 1'] }, /unsupported policy contract/],
  ['a delivery method the adapter does not implement', { delivery: 'some_other_channel' }, /no launch mechanism/]
]) {
  test(`${label} is refused`, t => {
    const w = world(t, report);
    assert.throws(() => deliveredPolicy({ role: 'devtest', worktree: w.worktree }, 'p', 'append_system_prompt', w.env), expected);
    assert.equal(policyPreflight({ role: 'devtest', worktree: w.worktree }, 'p', 'append_system_prompt', w.env), 'policy_refused');
  });
}

test('an adapter launch throws when enabled delivery is refused, and never falls back to weaker policy', t => {
  const w = world(t, { status: 'refused', refusals: ['stale policy'] });
  const config = { command: ['codex'], manifest: { capabilities: {} } };
  assert.throws(() => withSettings(w, () => codex.command(config, { role: 'devtest', worktree: w.worktree, access: 'standard' }, false)), PolicyRefused);
  assert.throws(() => withSettings(w, () => claude.command({ ...config, command: ['claude'] }, { role: 'devtest', worktree: w.worktree, access: 'standard' }, false)), PolicyRefused);
});

test('settings fail closed when present but invalid, and a role with no project is refused', t => {
  const w = world(t);
  for (const bad of ['not json', '{}', JSON.stringify({ policyRoot: 'relative', authorizedRoots: ['/x'] }), JSON.stringify({ policyRoot: '/x', authorizedRoots: [] }), JSON.stringify({ policyRoot: '/x', authorizedRoots: ['relative'] })]) {
    fs.writeFileSync(w.settingsFile, bad);
    assert.throws(() => policySettings(w.env), PolicyRefused, bad);
    assert.equal(policyPreflight({ role: 'devtest', worktree: w.worktree }, 'p', 'd', w.env), 'policy_refused', bad);
  }
  const good = world(t);
  assert.throws(() => deliveredPolicy({ role: '__proto__', worktree: good.worktree }, 'p', 'd', good.env), /no policy project/);
  fs.rmSync(path.join(good.policyRoot, 'tools/policy-delivery.mjs'));
  assert.throws(() => deliveredPolicy({ role: 'devtest', worktree: good.worktree }, 'p', 'd', good.env), /policy delivery tool is missing/);
});

test('a contract process that prints no report is a refusal, not a crash', t => {
  const w = world(t);
  fs.writeFileSync(path.join(w.policyRoot, 'tools/policy-delivery.mjs'), "process.stderr.write('policy delivery refused: bad arguments'); process.exitCode = 2;\n");
  assert.throws(() => deliveredPolicy({ role: 'devtest', worktree: w.worktree }, 'p', 'd', w.env), /bad arguments/);
});

test('the private policy text is removed after delivery', t => {
  const w = world(t);
  const before = new Set(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ai-supervisor-policy-')));
  deliveredPolicy({ role: 'devtest', worktree: w.worktree }, 'p', 'append_system_prompt', w.env);
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('ai-supervisor-policy-') && !before.has(n)), []);
});

test('a policy refusal is never reported as a sign-in problem', () => {
  assert.equal(preflightFailure('policy_refused'), 'failed: policy delivery was refused');
  assert.equal(preflightFailure('not_found'), 'failed: provider binary not found on PATH');
  assert.match(preflightFailure(false), /not logged in/);
  assert.equal(preflightFailure(true), null);
  assert.equal(preflightFailure(undefined), null);
});

test('coding standards are not duplicated into supervisor prompts', () => {
  const job = { number: 1, title: 't', body: 'b', branch: 'claude/issue-1-x', worktree: '/w', head: 'a'.repeat(40) };
  const texts = [];
  for (const build of [implementPrompt, reviewPrompt]) {
    try { texts.push(String(build(job, { repository: 'o/r', repo_path: '/r' }, job))); } catch (error) { assert.fail(`prompt builder threw: ${error.message}`); }
  }
  for (const text of texts) assert.doesNotMatch(text, /Ratchet rule|\| Class \| 400 lines|## Code size/);
});

// Run on Tower against a real deployed-shape tree with AI_RULES_TREE and AI_AGENT_SOURCE set: the supervisor and the launcher must deliver identical policy.
test('supervisor and interactive launcher resolve the same policy from the same tree', { skip: process.env.AI_RULES_TREE ? false : 'AI_RULES_TREE is not set; this cross-repository check runs on Tower' }, t => {
  const tree = process.env.AI_RULES_TREE;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'policy-consistency-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, 'projects');
  const worktree = path.join(projects, 'DevTest-Infrastructure');
  fs.mkdirSync(worktree, { recursive: true });
  const settingsFile = path.join(root, 'settings.json');
  fs.writeFileSync(settingsFile, JSON.stringify({ policyRoot: tree, authorizedRoots: [projects] }));
  const env = { ...process.env, AI_SUPERVISOR_POLICY_SETTINGS: settingsFile };
  for (const [provider, delivery] of [['claude', 'append_system_prompt'], ['codex', 'developer_instructions']]) {
    const supervised = deliveredPolicy({ role: 'devtest', kind: 'implement', worktree }, provider, delivery, env);
    const launcher = execFileSync('bash', [process.env.AI_AGENT_SOURCE, '--policy-diagnose', 'devtest', provider], {
      encoding: 'utf8', env: { ...process.env, AI_AGENT_RULES_ROOT: tree, AI_AGENT_PROJECT_ROOT: projects, AI_AGENT_CONTROL_ROOT: root }
    });
    const field = name => launcher.match(new RegExp(`^${name}\\t(.*)$`, 'm'))?.[1];
    assert.equal(supervised.policy_digest, field('policy_digest'), provider);
    assert.equal(supervised.source_revision, field('source_revision'), provider);
    assert.equal(supervised.modules.join(','), field('modules'), provider);
    assert.equal(supervised.role, field('role'), provider);
    assert.equal(supervised.delivery, field('delivery'), provider);
  }
});
