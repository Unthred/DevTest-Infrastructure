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
  { tool: 'Read', cmd: '/mnt/user/projects/A-1/docs/other.md', out: 'contents' },
  { cmd: 'gh pr view 1012 --json state', fail: true, out: `Exit code 1\nHTTP 401: Bad credentials token=${GH}` },
  { usage: 300 },
  { cmd: 'gh pr view 1013 --json state', fail: true, out: 'Exit code 1\nHTTP 401: Bad credentials' },
  { usage: 200 },
  { cmd: 'git status', out: 'clean' },
];

test('extraction: a failed step then the method that worked, with type, excerpt and tokens lost', t => {
  const root = tmp(t); writeTranscript(root, ID, STEPS);
  const errors = extractErrors(readTranscript(root, ID).entries);
  assert.equal(errors.length, 3);
  const [first] = errors;
  assert.equal(first.tool, 'Bash'); assert.equal(first.method, 'Bash: cat <path>'); assert.equal(first.type, 'file_not_found');
  assert.equal(first.recovered, true); assert.equal(first.recoveredBy, 'Read: <path>'); assert.equal(first.tokensLost, 500);
  assert.match(first.excerpt, /No such file/);
  assert.ok(errors.every(e => ERROR_TYPES.includes(e.type)));
  assert.equal(errors[1].type, 'auth'); assert.equal(errors[1].recoveredBy, 'Bash: git status');
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
  for (const [text, type] of [['permission denied', 'permission_refused'], ['command timed out after 120s', 'timeout'], ['bash: foo: command not found', 'command_not_found'], ['HTTP 429 rate limit', 'rate_limit'], ['Exit code 2\nboom', 'command_failed'], ['weird', 'tool_error']]) assert.equal(classifyError(text), type);
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
  // idempotent: a second call neither rewrites nor throws
  assert.equal(await recordJobErrors({ root, id: ID, jobs: { get: async () => ({}) }, now: Date.now() }), null);
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
  assert.equal(gh.count, 4); assert.equal(gh.jobs, 2); assert.deepEqual(gh.agents, ['claude', 'codex']); assert.equal(gh.tokensLost, 2 * (500 + 200));   // per job: 1012 recovered by git status after 300+200, 1013 after 200
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
