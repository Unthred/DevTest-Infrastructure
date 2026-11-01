// Per-job transcript and live watch view (issue #123): redaction, cap, retention, adapter mapping, evidence highlight,
// live delivery over server-sent events within 2 seconds, and replay equal to the live view.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TranscriptWriter, TRANSCRIPT_RETENTION_MS, pruneTranscripts, readTranscript, redactText, transcriptFile } from '../supervisor/transcript.mjs';
import * as claude from '../supervisor/adapters/claude.mjs';
import * as codex from '../supervisor/adapters/codex.mjs';
import { renderEntries, renderEntry, totals } from '../supervisor/dashui/watch.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { matchRoute } from '../supervisor/dashrender.mjs';
import { createJob, stateRoot } from '../supervisor/core.mjs';

const ID = 'a'.repeat(32), ID2 = 'b'.repeat(32);
// Credential-shaped canaries are built at run time so the repository never contains one (validator secret scan).
const GH = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const AWS = ['AK', 'IAABCDEFGHIJKLMNOP'].join('');
const HVS = ['hvs', 'CAESIabcdefghijklmnopqrstuvwxyz0123'].join('.');
const tmp = (t, p = 'tr-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('redaction removes seeded secrets: tokens, OpenBao paths and tokens, env assignments, JSON fields, private keys, env values', () => {
  const envValue = 'zx9-environment-value-canary';
  const text = [`gh ${GH}`, `bao ${HVS}`, 'read bao://kv/devtest/ha-token', 'GET /v1/secret/data/devtest/ha', 'path secret/data/devtest/ha', 'VAULT_TOKEN=plainvalue123', 'MY_API_KEY="quoted value"',
    '{"password": "hunter2hunter2", "name": "ok"}', 'Authorization: Bearer abcdefghijklmnop1234', `-----${'BEGIN'} OPENSSH PRIVATE KEY-----\nAAAAB3NzaC1\n-----${'END'} OPENSSH PRIVATE KEY-----`, `env ${envValue}`, AWS].join('\n');
  const out = redactText(text, [envValue]);
  for (const bad of [GH, HVS, 'ha-token', 'devtest/ha', 'plainvalue123', 'quoted value', 'hunter2hunter2', 'abcdefghijklmnop1234', 'AAAAB3NzaC1', envValue, AWS]) assert.ok(!out.includes(bad), `leaked ${bad}`);
  assert.match(out, /"name": "ok"/, 'ordinary fields survive');
  assert.equal(redactText('commit ' + 'a1b2c3d4e5'.repeat(4) + ' fixed'), 'commit ' + 'a1b2c3d4e5'.repeat(4) + ' fixed', 'a Git SHA is not a secret');
});

test('the writer redacts before writing, stores mode 600, and nothing seeded reaches disk', t => {
  const root = tmp(t), w = new TranscriptWriter(root, ID, { secrets: ['canary-env-value'] });
  w.append({ kind: 'assistant', text: `token ${GH} and canary-env-value` });
  w.append({ kind: 'tool_call', tool: 'Bash', text: `echo ${HVS}`, detail: `echo ${HVS}` });
  w.append({ kind: 'log', text: 'x', evidence: { event: 'usage_limit', line: `limit ${GH}` } });
  const file = transcriptFile(root, ID), raw = fs.readFileSync(file, 'utf8');
  for (const bad of [GH, HVS, 'canary-env-value']) assert.ok(!raw.includes(bad));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(readTranscript(root, ID).entries.map(e => e.seq), [1, 2, 3]);
});

test('the size cap truncates cleanly: whole entries, one marker, evidence still fits the reserve, file stays parseable', t => {
  const root = tmp(t), w = new TranscriptWriter(root, ID, { capBytes: 2000, reserveBytes: 1500 });
  for (let i = 0; i < 50; i++) w.append({ kind: 'assistant', text: `message ${i} ${'x'.repeat(100)}` });
  w.append({ kind: 'system', text: 'limit', evidence: { event: 'usage_limit', line: 'You have hit your limit' } });
  w.append({ kind: 'assistant', text: 'after evidence' });
  const lines = fs.readFileSync(transcriptFile(root, ID), 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.equal(lines.filter(l => l.kind === 'truncated').length, 1);
  assert.ok(lines.some(l => l.evidence?.event === 'usage_limit'), 'evidence is kept past the cap');
  assert.ok(!lines.some(l => l.text === 'after evidence'));
  assert.ok(fs.statSync(transcriptFile(root, ID)).size <= 3500);
  assert.deepEqual(lines.map(l => l.seq), lines.map((_, i) => i + 1), 'sequence has no gaps');
  // a second attempt appends and continues the sequence, and does not write a second marker
  const w2 = new TranscriptWriter(root, ID, { capBytes: 2000, reserveBytes: 1500 }); w2.append({ kind: 'assistant', text: 'again' });
  assert.equal(fs.readFileSync(transcriptFile(root, ID), 'utf8').split('\n').filter(l => l.includes('"truncated"')).length, 1);
  // a single over-long entry is clipped, not dropped
  const big = new TranscriptWriter(root, ID2); big.append({ kind: 'tool_result', text: 'y'.repeat(50000) });
  assert.ok(readTranscript(root, ID2).entries[0].text.length < 8200);
});

test('retention: transcripts older than 7 days are deleted, newer and unrelated files are kept', t => {
  const root = tmp(t), now = Date.now();
  new TranscriptWriter(root, ID).append({ kind: 'assistant', text: 'old' }); new TranscriptWriter(root, ID2).append({ kind: 'assistant', text: 'new' });
  fs.writeFileSync(path.join(root, 'transcripts', 'notes.txt'), 'x');
  const old = new Date(now - TRANSCRIPT_RETENTION_MS - 3600000); fs.utimesSync(transcriptFile(root, ID), old, old);
  assert.deepEqual(pruneTranscripts(root, now), [ID]);
  assert.ok(!fs.existsSync(transcriptFile(root, ID))); assert.ok(fs.existsSync(transcriptFile(root, ID2))); assert.ok(fs.existsSync(path.join(root, 'transcripts', 'notes.txt')));
  assert.deepEqual(pruneTranscripts(path.join(root, 'nowhere'), now), []);
});

test('adapters map their streams to the one schema; thinking is skipped, usage counted once per message', () => {
  const st = {}, j = o => JSON.stringify(o);
  const a = claude.transcript(j({ type: 'assistant', message: { id: 'm', content: [{ type: 'thinking', thinking: 'private' }, { type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Read', input: { file_path: '/x/y.txt' } }], usage: { input_tokens: 3, cache_read_input_tokens: 7, output_tokens: 2 } } }), st);
  assert.deepEqual(a.map(e => e.kind), ['assistant', 'tool_call', 'usage']); assert.equal(a[1].text, '/x/y.txt'); assert.deepEqual(a[2].tokens, { in: 10, out: 2 });
  assert.ok(!JSON.stringify(a).includes('private'));
  assert.deepEqual(claude.transcript(j({ type: 'assistant', message: { id: 'm', content: [], usage: { input_tokens: 3, output_tokens: 2 } } }), st), [], 'same message id is not counted twice');
  assert.equal(claude.transcript(j({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok' }], is_error: true }] } }), st)[0].error, true);
  assert.equal(claude.transcript('plain text', st), null, 'non-JSON is left to the runner');
  assert.deepEqual(claude.transcript(j({ type: 'rate_limit_event' }), st), []);
  assert.deepEqual(codex.transcript(j({ type: 'item.started', item: { type: 'command_execution', command: 'ls -la' } })).map(e => [e.kind, e.tool, e.text]), [['tool_call', 'shell', 'ls -la']]);
  assert.deepEqual(codex.transcript(j({ type: 'item.completed', item: { type: 'command_execution', exit_code: 2, aggregated_output: 'boom' } }))[0].error, true);
  assert.equal(codex.transcript(j({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }))[0].text, 'done');
  assert.deepEqual(codex.transcript(j({ type: 'turn.completed', usage: { input_tokens: 4, output_tokens: 1 } }))[0].tokens, { in: 4, out: 1 });
  assert.deepEqual(codex.transcript(j({ type: 'item.completed', item: { type: 'reasoning', text: 'private' } })), []);
  assert.equal(codex.transcript(j({ type: 'turn.failed', error: { message: 'You have hit your usage limit' } }))[0].error, true);
});

function runFixture(t) {
  const dir = tmp(t, 'tr-run-'), g = (...a) => execFileSync('git', ['-C', dir + '/repo', ...a], { encoding: 'utf8' });
  fs.mkdirSync(dir + '/repo'); g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.invalid'); g('config', 'user.name', 'T');
  fs.writeFileSync(dir + '/repo/README.md', 'x\n'); g('add', 'README.md'); g('commit', '-qm', 'init'); g('worktree', 'add', '-qb', 'issue-123', dir + '/worktree');
  const manifest = { schema_version: 1, id: 'codex', display_name: 'c', adapter_version: '0.1.0', launch: { command: 'codex', args: [], env_allowlist: ['HOME', 'PATH', 'LANG'] },
    capabilities: { launch: 'supported', resume: 'supported', session_status: 'supported', usage_limit_detection: 'supported', reset_time_parsing: 'supported', checkpoint: 'supported', non_interactive: 'supported' }, billing: { model: 'subscription', fallback_to_other_billing: false } };
  fs.writeFileSync(dir + '/codex.json', JSON.stringify(manifest)); fs.writeFileSync(dir + '/reg.json', JSON.stringify({ schemaVersion: 1, providers: { codex: { adapter: 'codex', manifest: 'codex.json' } } }));
  return { root: stateRoot(dir + '/state'), registry: dir + '/reg.json', spec: { role: 'devtest', provider: 'codex', repository: dir + '/repo', worktree: dir + '/worktree', issue: 123, scope: 'fixture', allowed_actions: ['read'], prompt: 'p', handover: 'HANDOVER.md', autoResume: false } };
}

test('a real subprocess: the transcript holds the stream without the seeded secrets, the classifier line is highlighted as evidence, and the event log stays classification-only', async t => {
  const { runProcess } = await import('../supervisor/process.mjs');
  const f = runFixture(t), job = await createJob(f.root, f.spec, f.registry);
  const env = 'MY_SERVICE_TOKEN=' + ['s3cr3t', 'canary', 'value'].join('-');
  const adapter = { command: () => [process.execPath, new URL('./transcript-agent.mjs', import.meta.url).pathname, GH, env], observe: claude.observe, transcript: claude.transcript, preflight: () => true };
  job.attempts = 1;
  const result = await runProcess(f.root, job, { manifest: { launch: { env_allowlist: ['HOME', 'PATH', 'LANG'] } } }, adapter, { now: () => Date.now() });
  assert.equal(result.event, 'usage_limit');
  const raw = fs.readFileSync(transcriptFile(f.root, job.id), 'utf8');
  for (const bad of [GH, 's3cr3t-canary-value']) assert.ok(!raw.includes(bad), `leaked ${bad}`);
  assert.equal(fs.statSync(transcriptFile(f.root, job.id)).mode & 0o777, 0o600);
  const { entries } = readTranscript(f.root, job.id);
  assert.deepEqual(entries.map(e => e.kind), ['assistant', 'tool_call', 'usage', 'assistant', 'tool_result', 'system']);
  assert.equal(entries.filter(e => e.kind === 'usage').length, 1, 'duplicate message id counted once');
  assert.deepEqual(totals(entries), { messages: 2, tools: 1, tokensIn: 10, tokensOut: 5, evidence: 1 });
  const ev = entries.filter(e => e.evidence);
  assert.equal(ev.length, 1); assert.equal(ev[0].evidence.event, 'usage_limit'); assert.match(ev[0].evidence.line, /hit your usage limit/);
  assert.match(renderEntry(ev[0]), /<mark>[^<]*hit your usage limit/); assert.match(renderEntry(ev[0]), /tr-evidence/);
  const events = fs.readFileSync(path.join(f.root, 'events', `${job.id}.jsonl`), 'utf8');
  assert.match(events, /classified:usage_limit/); assert.ok(!events.includes('hit your usage limit'), 'the event log carries no stream text');
});

test('replay equals live: rendering all entries equals rendering them one by one, in order', t => {
  const root = tmp(t), w = new TranscriptWriter(root, ID);
  for (const e of [{ kind: 'assistant', text: 'a <b>x</b>' }, { kind: 'tool_call', tool: 'Bash', text: 'ls', detail: 'ls -la' }, { kind: 'tool_result', text: 'out\nmore' }, { kind: 'system', error: true, text: 'limit', evidence: { event: 'usage_limit', line: 'limit "now"' } }]) w.append(e);
  const { entries } = readTranscript(root, ID), live = []; for (const e of entries) live.push(renderEntry(e));
  assert.equal(renderEntries(entries), live.join(''));
  assert.ok(!renderEntries(entries).includes('<b>x</b>'), 'text is escaped');
});

const CONFIG = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/nonexistent/repo', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { per_agent: 1, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [3] } } };
async function serve(t, root) {
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true });
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.closeAllConnections?.() || server.close());
  const port = server.address().port; server.on('request', handler({ root, config: CONFIG, host: '127.0.0.1', port }));
  return { port, req: (p, headers = {}) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}`, ...headers } }, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: b })); }).on('error', rej)),
    sse: (p, onData) => new Promise((res, rej) => { const q = http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, r => { r.on('data', d => onData(d.toString())); r.on('end', res); }); q.on('error', rej); t.after(() => q.destroy()); }) };
}
const writeJob = (root, status) => (fs.mkdirSync(path.join(root, 'jobs'), { recursive: true }), fs.writeFileSync(path.join(root, 'jobs', `${ID}.json`), JSON.stringify({ id: ID, status, createdAt: Date.now() - 5000, updatedAt: Date.now() })));

test('a live panel gets new lines within 2 seconds, the stream ends when the job finishes, and its full text equals the replay', async t => {
  const root = tmp(t); writeJob(root, 'running');
  const w = new TranscriptWriter(root, ID); w.append({ kind: 'assistant', text: 'first' });
  const s = await serve(t, root), got = [], stamps = [];
  let ended; const done = s.sse(`/api/jobs/${ID}/events`, chunk => { for (const m of chunk.matchAll(/^id: (\d+)\ndata: (.*)$/gm)) { got.push(JSON.parse(m[2])); stamps.push(Date.now()); } if (chunk.includes('event: end')) ended = true; });
  await sleep(400); assert.equal(got.length, 1, 'existing lines arrive on connect');
  const wrote = Date.now(); w.append({ kind: 'assistant', text: 'second, written live' });
  while (got.length < 2 && Date.now() - wrote < 3000) await sleep(20);
  assert.equal(got.length, 2); assert.ok(stamps[1] - wrote < 2000, `delivered in ${stamps[1] - wrote} ms`);
  w.append({ kind: 'tool_call', tool: 'Bash', text: 'ls' }); writeJob(root, 'completed');
  await done; assert.ok(ended, 'an end event closes the stream');
  assert.equal(renderEntries(got), renderEntries(readTranscript(root, ID).entries), 'the live view equals the replay');
  const replay = await s.req(`/jobs/${ID}`); assert.equal(replay.status, 200);
  for (const e of got) assert.ok(replay.body.includes(renderEntry(e)), 'the replay page contains each live entry verbatim');
  assert.match(replay.body, /data-live="false"/); assert.doesNotMatch(replay.body, /http-equiv="refresh"/);
});

test('resume with Last-Event-ID or ?after= skips what was seen; bad input, wrong ids and non-GET are refused; the CSP allows the stream', async t => {
  const root = tmp(t); writeJob(root, 'completed');
  const w = new TranscriptWriter(root, ID); for (const x of ['one', 'two', 'three']) w.append({ kind: 'assistant', text: x });
  const s = await serve(t, root);
  const j = await s.req(`/api/jobs/${ID}/transcript.json?after=2`); assert.deepEqual(JSON.parse(j.body).entries.map(e => e.text), ['three']);
  const sse = await s.req(`/api/jobs/${ID}/events`, { 'last-event-id': '1' }); assert.match(sse.headers['content-type'], /text\/event-stream/);
  assert.ok(!sse.body.includes('"one"') && sse.body.includes('"two"') && sse.body.includes('"three"') && sse.body.includes('event: end'));
  assert.equal((await s.req(`/api/jobs/${ID}/events?after=abc`)).body.includes('"one"'), true, 'a bad cursor falls back to the start');
  assert.equal((await s.req('/api/jobs/../../etc/passwd/events')).status, 404); assert.equal((await s.req('/api/jobs/xyz/events')).status, 404);
  assert.match(sse.headers['content-security-policy'], /connect-src 'self'/);
  assert.equal((await s.req('/static/watch.mjs')).status, 200); assert.equal((await s.req('/static/watch.js')).status, 200);
  const post = await new Promise(r => { const q = http.request({ host: '127.0.0.1', port: s.port, path: `/api/jobs/${ID}/events`, method: 'POST', headers: { host: `127.0.0.1:${s.port}` } }, res => r(res.statusCode)); q.end(); });
  assert.equal(post, 405);
  assert.equal((await s.req(`/api/jobs/${ID}/events`, { host: 'evil.example' })).status, 421);
  assert.deepEqual(matchRoute(`/jobs/${ID}`), { page: 'watch', id: ID }); assert.equal(matchRoute('/jobs/abc'), null);
});

test('the watch page: unknown job is a 404, a job with no transcript says so, and the running card, Needs you, Activity and job history link to it', async t => {
  const root = tmp(t); const s = await serve(t, root);
  assert.equal((await s.req(`/jobs/${ID2}`)).status, 404);
  writeJob(root, 'completed');
  const none = await s.req(`/jobs/${ID}`); assert.equal(none.status, 200); assert.match(none.body, /No transcript is stored/);
  // a running job with a transcript: its card on Overview offers a live view
  const live = { id: ID, provider: 'claude', status: 'running', kind: 'implement', issue: 30, createdAt: Date.now() - 60000, updatedAt: Date.now(), attempts: 1 };
  fs.writeFileSync(path.join(root, 'jobs', `${ID}.json`), JSON.stringify(live)); new TranscriptWriter(root, ID).append({ kind: 'assistant', text: 'hi' });
  const page = await s.req(`/jobs/${ID}`); assert.match(page.body, /data-live="true"/); assert.match(page.body, /Elapsed/); assert.match(page.body, /1 messages/);
  assert.match((await s.req('/')).body, new RegExp(`href="/jobs/${ID}"[^>]*>[^]*?Watch live`));
  assert.match((await s.req('/agents/claude')).body, new RegExp(`href="/jobs/${ID}">(?:watch|transcript)<`));
  // a failed job puts a Needs you item with a replay link; Activity links finished jobs
  const failed = { ...live, id: ID2, status: 'failed', lastEvent: 'crash' }; fs.writeFileSync(path.join(root, 'jobs', `${ID2}.json`), JSON.stringify(failed)); new TranscriptWriter(root, ID2).append({ kind: 'system', text: 'x', error: true });
  fs.mkdirSync(path.join(root, 'events'), { recursive: true }); fs.writeFileSync(path.join(root, 'events', `${ID2}.jsonl`), JSON.stringify({ at: Date.now(), job: ID2, kind: 'crash' }) + '\n');
  const home = (await s.req('/')).body; assert.match(home, new RegExp(`Replay transcript`)); assert.ok(home.includes(`href="/jobs/${ID2}"`));
  assert.ok((await s.req('/activity')).body.includes(`href="/jobs/${ID2}"`));
});
