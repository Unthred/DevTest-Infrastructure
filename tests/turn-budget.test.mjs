// Issue #1057: turns per job, first-turn input size, and the per-kind turn budget (reminder at 80%, stop at 100%).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createJob, readJob, stateRoot } from '../supervisor/core.mjs';
import { runProcess } from '../supervisor/process.mjs';
import { modelUsage } from '../supervisor/dashboard.mjs';
import * as claude from '../supervisor/adapters/claude.mjs';
import { recordTurn, turnFromLine, turnLimit, turnsByKind, DEFAULT_TURN_BUDGET } from '../supervisor/turns.mjs';

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
const assistant = (id, input) => JSON.stringify({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 3, cache_creation_input_tokens: input, cache_read_input_tokens: 0, output_tokens: 1 } } });

test('turnFromLine counts a message id once and sums input tokens', () => {
  const st = {};
  assert.deepEqual(turnFromLine(assistant('m1', 100), st), { turn: true, input: 103 });
  assert.equal(turnFromLine(assistant('m1', 100), st), null);   // same message on a second line
  assert.equal(turnFromLine('{"type":"user"}', st), null);
  assert.equal(turnFromLine('not json', st), null);
  // Codex emits one turn.completed for the whole run: it is not a turn. Each completed action item is.
  assert.equal(turnFromLine(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900000 } }), {}), null);
  assert.deepEqual(turnFromLine(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }), {}), { turn: true, input: null });
  assert.equal(turnFromLine(JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: 'x' } }), {}), null);
  assert.equal(turnFromLine(JSON.stringify({ type: 'item.started', item: { type: 'command_execution' } }), {}), null);
});

test('a Codex stream of 60 tool calls counts 60 turns, is reminded and stopped, and has no first-turn input', () => {
  const job = {}, st = {}, out = [];
  const lines = Array.from({ length: 60 }, () => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } })).concat(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 900000 } }));
  for (const l of lines) { const v = recordTurn(job, turnFromLine(l, st), 40); if (v) out.push(v); if (v === 'stop') break; }
  assert.deepEqual(out, ['remind', 'stop']); assert.equal(job.turns.count, 40); assert.equal(job.turns.firstTurnInput, null);
});

test('default budgets are the measured p90 per kind', () => {
  assert.deepEqual(DEFAULT_TURN_BUDGET, { review: 29, fix: 22, cifix: 21, implement: 39, rebase: 50 });
});

test('modelUsage shows mean turns and first-turn input per job type', () => {
  const g = modelUsage([{ kind: 'review', model: 'opus', turns: 10, firstTurnInput: 20000 }, { kind: 'review', model: 'opus', turns: 20, firstTurnInput: 24000 }, { kind: 'review', model: 'opus' }])[0];
  assert.equal(g.jobs, 3); assert.equal(g.meanTurns, 15); assert.equal(g.meanFirstTurnInput, 22000);
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

test('turnLimit: defaults per kind, override, 0 disables, unknown kind has none', () => {
  assert.ok(turnLimit({}, 'review') > 0);
  assert.equal(turnLimit({ turn_budget: { review: 7 } }, 'review'), 7);
  assert.equal(turnLimit({ turn_budget: { review: 0 } }, 'review'), null);
  assert.equal(turnLimit({}, 'inbox'), null);
});

test('turnsByKind averages turns and first-turn input per kind and ignores jobs with no turns', () => {
  const r = turnsByKind([{ kind: 'review', turns: { count: 10, firstTurnInput: 20000 } }, { kind: 'review', turns: { count: 20, firstTurnInput: 24000, stopped: true } }, { kind: 'fix' }, { kind: 'fix', turns: { count: 0 } }]);
  assert.deepEqual(Object.keys(r), ['review']);
  assert.equal(r.review.meanTurns, 15); assert.equal(r.review.meanFirstTurnInput, 22000); assert.equal(r.review.stopped, 1);
});

function sandbox(t, lines, kind, turnBudget, extra = {}) {
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
  const run = async job => runProcess(root, job, config, { command: () => [process.execPath, script], observe: claude.observe, preflight: () => true, ...extra }, { now: () => Date.now(), sleep: async () => {} });
  return { spec, registry, root, run };
}
test('the 80% reminder is written to the running agent over stdin, and stdin is closed on the result line', async t => {
  const lines = Array.from({ length: 12 }, (_, i) => assistant(`m${i}`, 1000 + i));
  const s = sandbox(t, lines, 'review', { review: 10 }, { userMessage: claude.userMessage });
  const sink = path.join(path.dirname(s.registry), 'stdin.txt');
  const script = path.join(path.dirname(s.registry), 'agent.mjs');
  fs.writeFileSync(script, `import fs from 'node:fs'; process.stdin.on('data', d => fs.appendFileSync(${JSON.stringify(sink)}, d)); process.on('SIGINT', () => process.exit(130));
let i = 0; const t = setInterval(() => { console.log(JSON.stringify({ type: 'assistant', message: { id: 'm' + i, content: [], usage: {} } })); if (++i >= 12) clearInterval(t); }, 40); setTimeout(() => {}, 20000);`);
  const job = await createJob(s.root, s.spec, s.registry);
  const result = await s.run(job);
  assert.equal(result.event, 'turn_budget');
  const got = fs.readFileSync(sink, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(got.length, 2); assert.ok(got.every(m => m.type === 'user'));
  assert.match(got[1].message.content[0].text, /8 of 10 turns/);
});

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
