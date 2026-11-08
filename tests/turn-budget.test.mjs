// Issue #1057: turns per job, first-turn input size, and the per-kind turn budget (reminder at 80%, stop at 100%).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createJob, readJob, stateRoot } from '../supervisor/core.mjs';
import { runProcess } from '../supervisor/process.mjs';
import * as claude from '../supervisor/adapters/claude.mjs';
import { recordTurn, turnFromLine, turnLimit, turnsByKind, validateTurnBudget } from '../supervisor/turns.mjs';

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const assistant = (id, input) => JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 3, cache_creation_input_tokens: input, cache_read_input_tokens: 0, output_tokens: 1 } } });

test('turnFromLine counts a message id once and sums input tokens', () => {
  const st = {};
  assert.deepEqual(turnFromLine(assistant('m1', 100), st), { turn: true, input: 103 });
  assert.equal(turnFromLine(assistant('m1', 100), st), null);   // same message on a second line
  assert.equal(turnFromLine('{"type":"user"}', st), null);
  assert.equal(turnFromLine('not json', st), null);
  assert.equal(turnFromLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7 } }), {}).input, 7);
});

test('recordTurn: first-turn size kept, reminder once at 80%, stop at 100%, no limit never acts', () => {
  const job = {};
  const seq = [];
  for (let i = 1; i <= 10; i++) seq.push(recordTurn(job, { turn: true, input: i === 1 ? 500 : 900 }, 10));
  assert.equal(job.turns.firstTurnInput, 500);
  assert.deepEqual(seq.map((v, i) => [i + 1, v]).filter(([, v]) => v), [[8, 'remind'], [10, 'stop']]);
  assert.equal(job.turns.stopped, true);
  const free = {}; for (let i = 0; i < 100; i++) assert.equal(recordTurn(free, { turn: true, input: 1 }, null), null);
  assert.equal(free.turns.count, 100);
  assert.equal(recordTurn(free, null, 5), null);
});

test('turnLimit: defaults per kind, override, 0 disables, unknown kind has none; validation rejects bad values', () => {
  assert.ok(turnLimit({}, 'review') > 0);
  assert.equal(turnLimit({ turn_budget: { review: 7 } }, 'review'), 7);
  assert.equal(turnLimit({ turn_budget: { review: 0 } }, 'review'), null);
  assert.equal(turnLimit({}, 'inbox'), null);
  validateTurnBudget({ review: 5 });
  for (const bad of [[], { review: -1 }, { review: 1.5 }, { 'Bad Key': 1 }, null]) assert.throws(() => validateTurnBudget(bad));
});

test('turnsByKind averages turns and first-turn input per kind and ignores jobs with no turns', () => {
  const r = turnsByKind([{ kind: 'review', turns: { count: 10, firstTurnInput: 20000 } }, { kind: 'review', turns: { count: 20, firstTurnInput: 24000, stopped: true } }, { kind: 'fix' }, { kind: 'fix', turns: { count: 0 } }]);
  assert.deepEqual(Object.keys(r), ['review']);
  assert.equal(r.review.meanTurns, 15); assert.equal(r.review.meanFirstTurnInput, 22000); assert.equal(r.review.stopped, 1);
});

function sandbox(t, lines, kind, turnBudget) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-budget-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), wt = path.join(dir, 'wt'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'a@b.invalid'); git(repo, 'config', 'user.name', 't'); fs.writeFileSync(path.join(repo, 'r'), 'x'); git(repo, 'add', 'r'); git(repo, 'commit', '-qm', 'i'); git(repo, 'worktree', 'add', '-qb', 'i1057', wt);
  const manifest = { schema_version: 1, id: 'codex', display_name: 'c', adapter_version: '0.1.0', launch: { command: 'x', args: [] }, capabilities: Object.fromEntries(['launch', 'resume', 'session_status', 'usage_limit_detection', 'reset_time_parsing', 'checkpoint', 'non_interactive'].map(k => [k, 'supported'])), billing: { model: 'subscription', fallback_to_other_billing: false } };
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify(manifest)); const registry = path.join(dir, 'reg.json'); fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { codex: { adapter: 'codex', manifest: 'codex.json' } } }));
  // After its lines the fake agent keeps running, as a real agent that has not finished would; only the stop ends it.
  const script = path.join(dir, 'agent.mjs'); fs.writeFileSync(script, `${lines.map(l => `console.log(${JSON.stringify(l)});`).join('\n')}\nsetTimeout(() => {}, 20000); process.on('SIGINT', () => process.exit(130));`);
  const spec = { role: 'devtest', provider: 'codex', repository: repo, worktree: wt, issue: 1057, scope: 's', allowed_actions: ['read'], prompt: 'p', kind };
  const root = stateRoot(path.join(dir, 's'));
  const config = { turn_budget: turnBudget, manifest: { launch: { env_allowlist: ['PATH'] } } };
  const run = async job => runProcess(root, job, config, { command: () => [process.execPath, script], observe: claude.observe, preflight: () => true }, { now: () => Date.now(), sleep: async () => {} });
  return { spec, registry, root, run };
}
const events = (root, id) => fs.readFileSync(path.join(root, 'events', `${id}.jsonl`), 'utf8').trim().split('\n').map(l => JSON.parse(l).kind);

test('a run over its budget gets one reminder, then is stopped with cause turn_budget and the count recorded', async t => {
  const lines = Array.from({ length: 12 }, (_, i) => assistant(`m${i}`, 1000 + i));
  const s = sandbox(t, lines, 'review', { review: 10 });
  const job = await createJob(s.root, s.spec, s.registry);
  const result = await s.run(job);
  assert.equal(result.event, 'turn_budget');
  const saved = readJob(s.root, job.id);
  assert.equal(saved.turns.count, 10); assert.equal(saved.turns.stopped, true); assert.equal(saved.turns.firstTurnInput, 1003);
  const ev = events(s.root, job.id);
  assert.equal(ev.filter(e => e.startsWith('turn_reminder:')).length, 1); assert.ok(ev.includes('turn_reminder:8/10'));
  assert.ok(ev.includes('turn_budget:10/10'));
  assert.ok(!ev.some(e => e === 'turn_budget:11/10'));   // lines after the stop are not counted
});

test('a run under its budget is not stopped and records turns and first-turn size', async t => {
  const s = sandbox(t, [assistant('a', 5000), assistant('b', 5200)], 'fix', { fix: 10 });
  s.spec.prompt = 'p';
  const job = await createJob(s.root, s.spec, s.registry);
  // this agent exits by itself shortly: use a short-lived variant
  const script = path.join(path.dirname(s.registry), 'agent.mjs'); fs.writeFileSync(script, `console.log(${JSON.stringify(assistant('a', 5000))});console.log(${JSON.stringify(assistant('b', 5200))});`);
  const result = await s.run(job);
  assert.notEqual(result.event, 'turn_budget'); assert.equal(result.code, 0);
  const saved = readJob(s.root, job.id);
  assert.equal(saved.turns.count, 2); assert.equal(saved.turns.firstTurnInput, 5003); assert.ok(!saved.turns.stopped);
  assert.ok(!events(s.root, job.id).some(e => e.startsWith('turn_')));
});
