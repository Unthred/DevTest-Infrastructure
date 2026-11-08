// Issue #1084: in-job agent errors from a transcript: extraction with a recovery, grouping of differently pathed repeats, redaction,
// retention, the MCP tool over the real dashboard handler, and the team status numbers. Secret-shaped values are built at run time.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { TranscriptWriter, readTranscript } from '../supervisor/transcript.mjs';
import { extractErrors, normalizeMethod, classifyError, recordJobErrors, pruneAgentErrors, agentErrorGroups, agentErrorTotals, errorsDir, ERROR_TYPES } from '../supervisor/agent-errors.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { getJson } from '../foreman-mcp/source.mjs';

const ID = 'a'.repeat(32), ID2 = 'b'.repeat(32), DAY = 86400000;
const GH = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agerr-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// A transcript as the writer stores it: a failed call, a different method that works, then two differently pathed repeats.
function writeTranscript(root, id, steps) {
  const w = new TranscriptWriter(root, id, { secrets: [] });
  let n = 0;
  for (const s of steps) {
    if (s.usage) { w.append({ kind: 'usage', text: '', tokens: { in: s.usage, out: 0 } }); continue; }
    const callId = `c${n++}`;
    w.append({ kind: 'tool_call', callId, tool: s.tool || 'Bash', text: s.cmd });
    w.append({ kind: 'tool_result', callId, text: s.out, error: s.fail === true });
  }
}
const STEPS = [
  { cmd: 'cat /mnt/user/projects/A-1/docs/missing.md', fail: true, out: 'cat: /mnt/user/projects/A-1/docs/missing.md: No such file or directory' },
  { usage: 500 },
  { cmd: 'gh pr view 1012 --json state', fail: true, out: `Exit code 1\nHTTP 401: Bad credentials token=${GH}` },
  { usage: 300 },
  { cmd: 'gh pr view 1013 --json state', fail: true, out: 'Exit code 1\nHTTP 401: Bad credentials' },
  { usage: 200 },
  { cmd: 'gh pr view 1013 --json state,title', out: '{}' },
  { cmd: 'git status', out: 'clean' },
];

test('extraction: a failed step then the different method that worked, with type, excerpt and tokens lost', t => {
  const root = tmp(t); writeTranscript(root, ID, STEPS);
  const errors = extractErrors(readTranscript(root, ID).entries);
  assert.equal(errors.length, 3);
  const [first] = errors;
  assert.equal(first.tool, 'Bash'); assert.equal(first.method, 'Bash: cat <path>'); assert.equal(first.type, 'file_not_found');
  assert.equal(first.recovered, false, 'an unrelated later success (git status) is not a recovery'); assert.equal(first.recoveredBy, null);
  assert.match(first.excerpt, /No such file/);
  assert.ok(errors.every(e => ERROR_TYPES.includes(e.type)));
  assert.equal(errors[1].type, 'auth'); assert.equal(errors[1].recovered, true); assert.equal(errors[1].recoveredBy, 'Bash: gh pr view <n> --json state,title');
  assert.equal(errors[1].recoveredWithSameMethod, false); assert.equal(errors[1].tokensLost, 500); assert.equal(errors[2].tokensLost, 200);
});

test('a retry of the same method that then works is a retry, not a different method', () => {
  const e = extractErrors([
    { kind: 'tool_call', callId: 'a', tool: 'Bash', text: 'npm run build' }, { kind: 'tool_result', callId: 'a', error: true, text: 'Exit code 1\nboom' },
    { kind: 'tool_call', callId: 'b', tool: 'Bash', text: 'npm run build' }, { kind: 'tool_result', callId: 'b', text: 'ok' }]);
  assert.equal(e[0].recovered, false); assert.equal(e[0].recoveredWithSameMethod, true); assert.equal(e[0].recoveredBy, null);
});

test('grouping: the same failing command on different ids gives one normalised method and the repeat is flagged', t => {
  assert.equal(normalizeMethod('Bash', 'gh pr view 1012 --json state'), normalizeMethod('Bash', 'gh pr view 1013 --json state'));
  assert.equal(normalizeMethod('Bash', 'cat /mnt/a/x.md'), normalizeMethod('Bash', 'cat /home/b/c/y.txt'));
  assert.equal(normalizeMethod('Bash', 'git show 3f2a9c1de4'), normalizeMethod('Bash', 'git show 0a1b2c3d4e5f'));
  assert.notEqual(normalizeMethod('Bash', 'gh pr view 1 --json state'), normalizeMethod('Bash', 'gh pr list --json state'));
  const root = tmp(t); writeTranscript(root, ID, STEPS);
  const errors = extractErrors(readTranscript(root, ID).entries);
  assert.equal(errors[1].method, errors[2].method); assert.equal(errors[1].repeat, false); assert.equal(errors[2].repeat, true);
});

test('classification covers the fixed list and unrecovered errors record no recovery', t => {
  for (const [text, type] of [['permission denied', 'permission_refused'], ['Permission for this command was denied. Ask the user.', 'permission_refused'], ['InputValidationError: Monitor failed: timeout_ms must be positive', 'tool_error'], ['command timed out after 120s', 'timeout'], ['bash: foo: command not found', 'command_not_found'], ['HTTP 429 rate limit', 'rate_limit'], ['Exit code 2\nboom', 'command_failed'], ['weird', 'tool_error']]) assert.equal(classifyError(text), type);
  const root = tmp(t); writeTranscript(root, ID, [{ cmd: 'make all', fail: true, out: 'Exit code 2\nboom' }]);
  const [e] = extractErrors(readTranscript(root, ID).entries);
  assert.equal(e.recovered, false); assert.equal(e.recoveredBy, null); assert.equal(e.type, 'command_failed');
});

test('redaction: a secret-shaped value in the message never reaches the stored record', async t => {
  const root = tmp(t); writeTranscript(root, ID, STEPS);
  const rec = await recordJobErrors({ root, id: ID, jobs: { get: async () => ({ kind: 'implement', provider: 'claude', model: 'claude-sonnet-5-5', issue: 5 }) }, entry: { agent: 'claude', pr: 7 }, now: Date.now(), secrets: [GH] });
  assert.equal(rec.errors.length, 3);
  const onDisk = fs.readFileSync(path.join(errorsDir(root), `${ID}.json`), 'utf8');
  assert.ok(!onDisk.includes(GH), 'token absent');
  assert.equal(JSON.parse(onDisk).agent, 'claude'); assert.equal(JSON.parse(onDisk).issue, 5);
  assert.equal(fs.statSync(path.join(errorsDir(root), `${ID}.json`)).mode & 0o777, 0o600);
  // extraction itself redacts a secret shape in the excerpt even when the caller passes no list
  const e = extractErrors([{ kind: 'tool_call', seq: 1, tool: 'Bash', text: 'x' }, { kind: 'tool_result', seq: 2, error: true, text: `Exit code 1\nAuthorization: Bearer ${GH}abcdef` }]);
  assert.ok(!JSON.stringify(e).includes(GH));
});

test('retention: records older than the period are removed automatically, newer ones stay', async t => {
  const root = tmp(t); writeTranscript(root, ID, STEPS); writeTranscript(root, ID2, STEPS);
  const now = Date.now();
  await recordJobErrors({ root, id: ID, jobs: null, now: now - 31 * DAY });
  await recordJobErrors({ root, id: ID2, jobs: null, now: now - 29 * DAY });
  assert.ok(fs.existsSync(path.join(errorsDir(root), `${ID}.json`)));
  assert.deepEqual(pruneAgentErrors(root, now), [ID]);
  assert.ok(!fs.existsSync(path.join(errorsDir(root), `${ID}.json`))); assert.ok(fs.existsSync(path.join(errorsDir(root), `${ID2}.json`)));
  assert.deepEqual(pruneAgentErrors(root, now, 1), [ID2], 'a shorter setting removes the 29 day old record');
  // recording a new job prunes as a side effect
  await recordJobErrors({ root, id: ID, jobs: null, now: now - 40 * DAY });
  await recordJobErrors({ root, id: ID2, jobs: null, now });
  assert.ok(!fs.existsSync(path.join(errorsDir(root), `${ID}.json`)));
});

test('groups by method and type with filters; totals for team status; MCP tool reads it over HTTP and is read only', async t => {
  const root = tmp(t); writeTranscript(root, ID, STEPS); writeTranscript(root, ID2, STEPS);
  const now = Date.now();
  await recordJobErrors({ root, id: ID, jobs: { get: async () => ({ kind: 'implement', provider: 'claude' }) }, entry: { agent: 'claude' }, now, secrets: [GH] });
  await recordJobErrors({ root, id: ID2, jobs: { get: async () => ({ kind: 'review', provider: 'codex' }) }, entry: { agent: 'codex' }, now: now - 3 * DAY, secrets: [GH] });
  const all = agentErrorGroups(root, { now, days: 7 });
  const gh = all.groups.find(g => g.method === 'Bash: gh pr view <n> --json state');
  assert.equal(gh.count, 4); assert.equal(gh.jobs, 2); assert.deepEqual(gh.agents, ['claude', 'codex']); assert.equal(gh.tokensLost, 2 * (500 + 200));
  const only = agentErrorGroups(root, { now, days: 7, agent: 'codex' }); assert.equal(only.errors, 3);
  assert.equal(agentErrorGroups(root, { now, days: 7, kind: 'review' }).errors, 3);
  assert.equal(agentErrorGroups(root, { now, days: 1 }).errors, 3, 'the day filter drops the older job');
  const totals = agentErrorTotals(root, now); assert.equal(totals.errors, 3); assert.ok(totals.tokensLost > 0);

  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.closeAllConnections?.() || server.close());
  const port = server.address().port; server.on('request', handler({ root, config: () => ({}), host: '127.0.0.1', port, recorderDir: null }));
  const base = `http://127.0.0.1:${port}`;
  const tools = createTools({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), getPath: p => getJson(new URL(p, `${base}/api/view.json`).href) });
  const tool = tools.list().find(x => x.name === 'foreman_agent_errors');
  assert.ok(tool.annotations.readOnlyHint === true && tool.annotations.destructiveHint === false);
  const r = await tools.call('foreman_agent_errors', { days: 7, agent: 'claude' });
  assert.equal(r.isError, false, r.text.slice(0, 200));
  const body = JSON.parse(r.text); assert.equal(body.errors, 3); assert.ok(body.groups.length >= 2);
  assert.ok(!r.text.includes(GH));
  const bad = await tools.call('foreman_agent_errors', { agent: '../../etc' }); assert.equal(JSON.parse(bad.text).errors, 6, 'an unsafe filter is ignored, not applied');
  const post = await new Promise(res => { const q = http.request({ host: '127.0.0.1', port, path: '/api/agent-errors.json', method: 'POST', headers: { host: `127.0.0.1:${port}` } }, x => { x.resume(); res(x.statusCode); }); q.end(); });
  assert.notEqual(post, 200);
});

// Real adapter streams, written the way the dispatcher writes them.
import * as codex from '../supervisor/adapters/codex.mjs';
import * as claude from '../supervisor/adapters/claude.mjs';
import { renderStatus } from '../supervisor/teamstatus.mjs';
function feed(root, id, adapter, lines) {
  const w = new TranscriptWriter(root, id, { secrets: [] }), state = {};
  for (const l of lines) for (const e of adapter.transcript(JSON.stringify(l), state) || []) w.append(e);
}
const shell = (id, command, code, out) => [{ type: 'item.started', item: { id, type: 'command_execution', command } }, { type: 'item.completed', item: { id, type: 'command_execution', command, exit_code: code, aggregated_output: out } }];

test('Codex: calls without a result entry do not shift later results, wrappers are unwrapped, tokens are unknown not zero', t => {
  const root = tmp(t);
  feed(root, ID, codex, [
    { type: 'item.completed', item: { type: 'file_change', changes: [{ kind: 'update', path: '/mnt/x/a.mjs' }] } },
    ...shell('i1', '/bin/bash -lc "cd \\"/mnt/x\\" && npm run build"', 1, 'boom'),
    ...shell('i2', '/bin/bash -lc "rm -rf nope && git push"', 1, 'fatal'),
    { type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 100 } }]);
  const e = extractErrors(readTranscript(root, ID).entries);
  assert.equal(e.length, 2);
  assert.equal(e[0].tool, 'shell'); assert.equal(e[0].method, 'shell: cd <str> && npm run build'); assert.equal(e[1].method, 'shell: rm -rf nope && git push');
  assert.equal(e[0].recovered, false); assert.equal(e[0].tokensLost, null); assert.equal(e[1].tokensLost, null);
});

test('Claude: out-of-order parallel results pair by id; an unrelated read is not a recovery', t => {
  const root = tmp(t);
  const use = (id, name, input) => ({ type: 'assistant', message: { id: 'm' + id, content: [{ type: 'tool_use', id, name, input }], usage: { input_tokens: 10, output_tokens: 5 } } });
  const res = (id, text, err) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: err }] } });
  feed(root, ID, claude, [use('t1', 'Bash', { command: 'node --test foo.test.mjs' }), use('t2', 'Read', { file_path: '/mnt/y/z.md' }), res('t2', 'text', false), res('t1', 'Exit code 1\nfail', true)]);
  const e = extractErrors(readTranscript(root, ID).entries);
  assert.equal(e.length, 1); assert.match(e[0].method, /node --test/); assert.equal(e[0].tool, 'Bash'); assert.equal(e[0].recovered, false);
  assert.ok(e[0].tokensLost === null || e[0].tokensLost >= 0);
});

test('grouping: test files, d.ts files, line ranges, hyphenated ids and different shell wrappers', () => {
  const n = c => normalizeMethod('Bash', c);
  assert.equal(n('node --test a.test.mjs'), n('node --test b.test.mjs'));
  assert.equal(n('cat foo.d.ts'), n('cat bar.d.ts'));
  assert.equal(n('sed -n 10,20p x.md'), n('sed -n 30,40p y.md'));
  assert.equal(n('ai test job-a1b2c3'), n('ai test job-d4e5f6'));
  assert.notEqual(normalizeMethod('shell', '/bin/bash -lc "npm run build"'), normalizeMethod('shell', '/bin/bash -lc "git push"'));
});

test('a resumed job is recorded again from the whole transcript; a missing transcript writes nothing; the excess is counted', async t => {
  const root = tmp(t);
  writeTranscript(root, ID, [{ cmd: 'first-attempt', fail: true, out: 'Exit code 1\nx' }]);
  await recordJobErrors({ root, id: ID, jobs: null, now: Date.now(), secrets: [] });
  const w = new TranscriptWriter(root, ID, { secrets: [] }); w.append({ kind: 'tool_call', callId: 'z', tool: 'Bash', text: 'second-attempt' }); w.append({ kind: 'tool_result', callId: 'z', error: true, text: 'Exit code 1\ny' });
  const rec = await recordJobErrors({ root, id: ID, jobs: null, now: Date.now(), secrets: [] });
  assert.deepEqual(rec.errors.map(e => e.method), ['Bash: first-attempt', 'Bash: second-attempt']);
  assert.equal(await recordJobErrors({ root, id: ID2, jobs: null, now: Date.now() }), null);
  assert.ok(!fs.existsSync(path.join(errorsDir(root), `${ID2}.json`)));
  const many = Array.from({ length: 45 }, (_, i) => ({ cmd: `c${i}x`, fail: true, out: 'Exit code 1\nx' }));
  writeTranscript(root, ID2, many);
  const r2 = await recordJobErrors({ root, id: ID2, jobs: null, now: Date.now(), secrets: [] });
  assert.equal(r2.errors.length, 40); assert.equal(r2.dropped, 5);
});

test('team status line shows the count, the tokens lost and the errors with no token figure', () => {
  const out = renderStatus({ agentErrors: { errors: 4, tokensLost: 1200, tokensUnknown: 2, recovered: 1 }, problems: [], pulls: [], mergedToday: [], next: { plan: [], waiting: [] }, agents: [], slots: [], notes: [], schedule: {}, reviewOrder: [], estimates: { items: [], waits: [] }, robustness: null, needsYou: [], generatedAt: Date.now(), timeZone: 'UTC' });
  assert.match(out, /In-job agent errors, last 24 hours: 4, about 1,200 tokens lost \(2 with no token figure\) \(1 recovered\)/);
});

test('Codex long (truncated in text) commands use the full command: unrelated wrapped commands are not a recovery or one group', t => {
  const root = tmp(t), pad = ' --flag'.repeat(40);
  feed(root, ID, codex, [
    ...shell('i1', `/bin/bash -lc "cd \\"/mnt/x\\" && npm run build${pad}"`, 1, 'boom'),
    ...shell('i2', `/bin/bash -lc "cd \\"/mnt/x\\" && git log --oneline${pad}"`, 0, 'ok'),
    ...shell('i3', `/bin/bash -lc "rm -rf nope${pad} && git push"`, 1, 'fatal')]);
  const e = extractErrors(readTranscript(root, ID).entries);
  assert.equal(e.length, 2);
  assert.match(e[0].method, /npm run build/); assert.equal(e[0].recovered, false);
  assert.notEqual(e[0].method, e[1].method);
});

test('recovery needs the same command: cd with a semicolon is skipped, git status does not answer git push, a retry is not a recovery', t => {
  const root = tmp(t);
  const use = (id, command) => ({ type: 'assistant', message: { id: 'm' + id, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const res = (id, text, err) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: err }] } });
  feed(root, ID, claude, [
    use('a', 'cd "/mnt/x"; node --test foo.test.mjs'), res('a', 'Exit code 1\nfail', true),
    use('b', 'cd "/mnt/x"; cat README.md'), res('b', 'ok', false),
    use('c', 'git push'), res('c', 'Exit code 1\nfatal', true),
    use('d', 'git status'), res('d', 'clean', false),
    use('e', 'npm run build'), res('e', 'Exit code 1\nboom', true),
    use('f', 'npm run build'), res('f', 'ok', false)]);
  const e = extractErrors(readTranscript(root, ID).entries);
  assert.equal(e.length, 3);
  assert.equal(e[0].recovered, false); assert.equal(e[1].recovered, false);
  assert.equal(e[2].recovered, false); assert.equal(e[2].recoveredWithSameMethod, true); assert.equal(e[2].recoveredBy, null);
});

test('mixed-quote Codex wrappers are unwrapped and unrelated commands are not each other\'s recovery', t => {
  const root = tmp(t);
  const build = `/bin/bash -lc "cd \\"/mnt/x\\" && npm run build 2>&1 | grep 'err'"'; true'`;
  const log = `/bin/bash -lc "cd \\"/mnt/x\\" && git log -1 --format='%H'"'; true'`;
  feed(root, ID, codex, [...shell('i1', build, 1, 'boom'), ...shell('i2', log, 0, 'abc')]);
  const e = extractErrors(readTranscript(root, ID).entries);
  assert.equal(e.length, 1);
  assert.match(e[0].method, /npm run build/);
  assert.equal(e[0].recovered, false); assert.equal(e[0].recoveredWithSameMethod, false);
  assert.notEqual(normalizeMethod('shell', build), normalizeMethod('shell', log));
});

test('a leading cd with ; or a newline is ignored when judging the same step', t => {
  const root = tmp(t);
  const use = (id, command) => ({ type: 'assistant', message: { id: 'm' + id, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], usage: { input_tokens: 10, output_tokens: 5 } } });
  const res = (id, text, err) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: err }] } });
  feed(root, ID, claude, [
    use('a', 'cd /mnt/x; node --test foo.test.mjs'), res('a', 'Exit code 1\nfail', true), use('b', 'cd /mnt/x; cat README.md'), res('b', 'ok', false),
    use('c', 'cd /mnt/x\nfind . -name x'), res('c', 'Exit code 1\nfail', true), use('d', 'cd /mnt/x\ngh pr view 1'), res('d', 'ok', false),
    use('e', 'cd /mnt/x; node --test --test-reporter=dot bar.test.mjs'), res('e', 'ok', false)]);
  const e = extractErrors(readTranscript(root, ID).entries);
  assert.equal(e.length, 2);
  assert.equal(e[0].recovered, true); assert.match(e[0].recoveredBy, /node --test/);
  assert.equal(e[1].recovered, false);
});
