// Per-job transcript and live watch view (issue #123): redaction, cap, retention, adapter mapping, evidence highlight,
// live delivery over server-sent events within 2 seconds, and replay equal to the live view.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TranscriptWriter, TRANSCRIPT_RETENTION_MS, ENTRY_TEXT_MAX, isSecretName, isSecretRead, pruneTranscripts, readTranscript, redactText, sanitizeEntry, secretValues, transcriptFile } from '../supervisor/transcript.mjs';
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
const BEARER_VALUE = ['abcdefgh', 'ijklmnop', '1234'].join('');
const BEARER = ['Authorization: ', 'Bear', 'er ', BEARER_VALUE].join('');
const HVS = ['hvs', 'CAESIabcdefghijklmnopqrstuvwxyz0123'].join('.');
const BAO_URL = ['read bao:/', '/kv/devtest/', 'ha-token'].join('');
const BAO_API = ['GET /v1/', 'secret/data/', 'devtest/ha'].join('');
const BAO_PATH = ['path ', 'secret/', 'data/devtest/ha'].join('');
const VAULT_VALUE = ['plain', 'value123'].join('');
const VAULT_ASSIGN = ['VAULT', '_TOKEN', '=', VAULT_VALUE].join('');
const API_ASSIGN = ['MY_API', '_KEY', '="', 'quoted value', '"'].join('');
const PASSWORD = ['hunter2', 'hunter2'].join('');
const PASSWORD_JSON = ['{"pass', 'word": "', PASSWORD, '", "name": "ok"}'].join('');
const KEY_BODY = ['AAAAB3', 'NzaC1'].join('');
const KEY_LABEL = ['OPENSSH PRI', 'VATE KEY'].join('');
const KEY_BLOCK = [`-----${'BEGIN'} ${KEY_LABEL}-----`, KEY_BODY, `-----${'END'} ${KEY_LABEL}-----`].join('\n');
const SERVICE_ASSIGN = ['MY_SERVICE', '_TOKEN='].join('') + ['s3cr3t', 'canary', 'value'].join('-');
const tmp = (t, p = 'tr-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

test('redaction removes seeded secrets: tokens, OpenBao paths and tokens, env assignments, JSON fields, private keys, env values', () => {
  const envValue = 'zx9-environment-value-canary';
  const text = [`gh ${GH}`, `bao ${HVS}`, BAO_URL, BAO_API, BAO_PATH, VAULT_ASSIGN, API_ASSIGN,
    PASSWORD_JSON, BEARER, KEY_BLOCK, `env ${envValue}`, AWS].join('\n');
  const out = redactText(text, [envValue]);
  for (const bad of [GH, HVS, 'ha-token', 'devtest/ha', VAULT_VALUE, 'quoted value', PASSWORD, BEARER_VALUE, KEY_BODY, envValue, AWS]) assert.ok(!out.includes(bad), `leaked ${bad}`);
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
  const env = SERVICE_ASSIGN;
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

// Issue #123 review fix: more secret shapes. Every fixture is assembled at run time (no literal credential in the repository).
const V = (...p) => p.join('');
const gone = (out, ...bad) => { for (const b of bad) assert.ok(!out.includes(b), `leaked ${b}`); };

test('redaction: URL userinfo (user:password and token-only) is removed, host and path stay', () => {
  const pw = V('pa', 'ss', 'word-canary-1'), tok = V('tok', 'en-canary-2');
  const out = redactText([`git clone https://alice:${pw}@example.org/repo.git`, `curl https://${tok}@example.org/x`, 'see https://example.org/plain'].join('\n'));
  gone(out, pw, tok, 'alice:');
  assert.match(out, /example\.org\/repo\.git/);
  assert.match(out, /https:\/\/example\.org\/plain/);
});

test('redaction: Basic, Digest and Token Authorization headers', () => {
  const basic = V('dXNl', 'cjpwYXNz', 'd29yZA=='), tok = V('abc', 'DEF', '123canary'), dig = V('resp', 'onse-canary-3');
  const out = redactText([`Authorization: Basic ${basic}`, `curl -H 'Authorization: Token ${tok}' https://example.org`,
    `Authorization: Digest username="u", realm="r", response="${dig}"`, `Proxy-Authorization: Basic ${basic}`].join('\n'));
  gone(out, basic, tok, dig);
  assert.match(out, /https:\/\/example\.org/, 'the rest of the command survives');
});

test('redaction: `key: value` and `--flag value` for secret-named keys, ordinary keys survive', () => {
  const a = V('s3', 'cret-yaml-canary'), b = V('flag-', 'value-canary'), c = V('eq-', 'value-canary'), d = V('sp ', 'ace-canary');
  const out = redactText([`password: ${a}`, `api_key: "${d}"`, `client-secret: ${a}2`, `curl --token ${b} --user bob`, `tool --password=${c} --verbose`,
    `mytool --api-key ${b}2 run`, 'name: build', 'status: ok'].join('\n'));
  gone(out, a, b, c, d);
  assert.match(out, /name: build/); assert.match(out, /status: ok/); assert.match(out, /--user bob/); assert.match(out, /--verbose/);
});

test('redaction: *_PASS and *_PWD variable names (either case), PWD alone is left', () => {
  const v1 = V('db-', 'pass-canary'), v2 = V('pw', 'd-canary'), v3 = V('lower-', 'canary');
  const out = redactText([`DB_${'PASS'}=${v1}`, `export SERVICE_${'PWD'}="${v2}"`, `db_${'pass'}=${v3}`, 'PWD=/home/work'].join('\n'));
  gone(out, v1, v2, v3);
  assert.match(out, /PWD=\/home\/work/);
});

test('redaction: bao/vault kv get table output (any key name) and -field output', t => {
  const v1 = V('tbl-', 'value-canary-1'), v2 = V('tbl-', 'value-canary-2');
  const table = ['====== Data ======', 'Key         Value', '---         -----', `username    ${v1}`, `custom_name ${v2}`, '', 'after the table'].join('\n');
  const out = redactText(table);
  gone(out, v1, v2);
  assert.match(out, /username\s+\[redacted\]/); assert.match(out, /after the table/);
  // -field prints a bare value with no shape: the result of a secret read is dropped whole by the writer.
  const bare = V('bare-', 'field-canary-9');
  const root = tmp(t), w = new TranscriptWriter(root, ID, { secrets: [] });
  w.append({ kind: 'tool_call', callId: 'c1', tool: 'Bash', text: `bao kv get -field=password secret/devtest/x` });
  w.append({ kind: 'tool_result', callId: 'c1', text: bare });
  w.append({ kind: 'tool_call', callId: 'c2', tool: 'Bash', text: 'ls' });
  w.append({ kind: 'tool_result', callId: 'c2', text: 'plain listing' });
  const disk = fs.readFileSync(transcriptFile(root, ID), 'utf8');
  gone(disk, bare);
  assert.match(disk, /redacted: output of a secret read/); assert.match(disk, /plain listing/);
});

// Review fix (job 3a3474bc): pending secret reads are keyed by tool-use id (Claude) and item id (Codex), not counted.
const PAR_SECRET = V('par-', 'allel-canary-7');
const claudeLine = o => JSON.stringify(o);
const callsMessage = claudeLine({ type: 'assistant', message: { id: 'm1', content: [
  { type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } },
  { type: 'tool_use', id: 'toolu_bao', name: 'Bash', input: { command: 'bao kv get -field=password secret/x' } }] } });
const claudeResult = (id, text) => ({ type: 'tool_result', tool_use_id: id, content: text });
function feed(t, lines, adapter = claude) {
  const root = tmp(t), w = new TranscriptWriter(root, ID, { secrets: [] }), state = {};
  for (const line of lines) for (const e of adapter.transcript(line, state) || []) w.append(e);
  return fs.readFileSync(transcriptFile(root, ID), 'utf8');
}

test('parallel tool calls: the secret read output is dropped, the ls output is kept (separate lines)', t => {
  const disk = feed(t, [callsMessage,
    claudeLine({ type: 'user', message: { content: [claudeResult('toolu_ls', 'file-a file-b')] } }),
    claudeLine({ type: 'user', message: { content: [claudeResult('toolu_bao', PAR_SECRET)] } })]);
  gone(disk, PAR_SECRET); assert.match(disk, /file-a file-b/); assert.match(disk, /redacted: output of a secret read/);
});

test('parallel tool calls: results in one user message, and out of order', t => {
  const inOne = feed(t, [callsMessage, claudeLine({ type: 'user', message: { content: [claudeResult('toolu_ls', 'file-a file-b'), claudeResult('toolu_bao', PAR_SECRET)] } })]);
  gone(inOne, PAR_SECRET); assert.match(inOne, /file-a file-b/);
  const reversed = feed(t, [callsMessage, claudeLine({ type: 'user', message: { content: [claudeResult('toolu_bao', PAR_SECRET), claudeResult('toolu_ls', 'file-a file-b')] } })]);
  gone(reversed, PAR_SECRET); assert.match(reversed, /file-a file-b/);
  const later = feed(t, [callsMessage, claudeLine({ type: 'user', message: { content: [claudeResult('toolu_ls', 'file-a file-b')] } }),
    claudeLine({ type: 'user', message: { content: [claudeResult('toolu_bao', PAR_SECRET)] } })]);
  gone(later, PAR_SECRET);
});

test('an unmatched result (unknown or missing id) is redacted', t => {
  const unknown = feed(t, [callsMessage, claudeLine({ type: 'user', message: { content: [claudeResult('toolu_other', PAR_SECRET)] } })]);
  gone(unknown, PAR_SECRET); assert.match(unknown, /redacted: output of a secret read/);
  const root = tmp(t), w = new TranscriptWriter(root, ID, { secrets: [] });
  w.append({ kind: 'tool_call', tool: 'Bash', text: 'bao kv get -field=password secret/x' });
  w.append({ kind: 'tool_result', text: PAR_SECRET });
  gone(fs.readFileSync(transcriptFile(root, ID), 'utf8'), PAR_SECRET);
});

test('positive control: an ordinary call and result are stored in full', t => {
  const disk = feed(t, [claudeLine({ type: 'assistant', message: { id: 'm2', content: [{ type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'ls' } }] } }),
    claudeLine({ type: 'user', message: { content: [claudeResult('toolu_x', 'file-a file-b')] } })]);
  assert.match(disk, /file-a file-b/); assert.ok(!/redacted: output of a secret read/.test(disk));
});

test('Codex: secret read and ordinary command paired by item id, in either order', t => {
  const item = (type, id, command, extra = {}) => JSON.stringify({ type, item: { id, type: 'command_execution', command, ...extra } });
  const disk = feed(t, [item('item.started', 'item_1', 'ls'), item('item.started', 'item_2', 'bao kv get -field=password secret/x'),
    item('item.completed', 'item_2', 'bao kv get -field=password secret/x', { exit_code: 0, aggregated_output: PAR_SECRET }),
    item('item.completed', 'item_1', 'ls', { exit_code: 0, aggregated_output: 'file-a file-b' })], codex);
  gone(disk, PAR_SECRET); assert.match(disk, /file-a file-b/);
});

// Escalated review fix (PR #137): one scanner for every secret-named pair form, and a seed for every form any review round probed,
// so the documentation and the code cannot drift apart again. Each seed carries the same canary; none may survive.
const CANARY = V('Zq7', 'canary', 'Xv');
const SEEDS = [
  // name=value, any case, bare or prefixed, spaced, exported, quoted, in a URL query
  `PASSWORD=${CANARY}`, `password=${CANARY}`, `secret=${CANARY}`, `token=${CANARY}`, `client_secret=${CANARY}`, `apikey=${CANARY}`,
  `token = ${CANARY}`, `password = ${CANARY}`, `export ha_token=${CANARY}`, `api_key="abc ${CANARY} ghi"`, `MY_SERVICE_KEY=${CANARY}`,
  `https://api.example.org/y?access_token=${CANARY}&a=1`, `echo password=${CANARY}`, `config: password=${CANARY}`,
  // *_PASS / *_PWD / *_PW
  `DB_PASS=${CANARY}`, `MYSQL_PWD=${CANARY}`, `MQTT_PWD=${CANARY}`, `MQTT_PASS=${CANARY}`, `HA_PW=${CANARY}`,
  // name: value (YAML, headers)
  `password: ${CANARY}`, `api_key: ${CANARY}`, `token: ${CANARY}`, `mqtt_password: ${CANARY}`, `ha_token: ${CANARY}`, `X-Api-Key: ${CANARY}`,
  `Cookie: sid=${CANARY}`, `cookie: sid=${CANARY}; theme=dark`, `Set-Cookie: sid=${CANARY}; Path=/`, `set-cookie: session=${CANARY}`,
  `curl -H 'X-Api-Key: ${CANARY}' https://example.org`, `curl -H "Cookie: a=${CANARY}" https://example.org`,
  // JSON: plain, escaped inside a raw stream line, camelCase, after a numeric field
  `{"pass": "${CANARY}"}`, `{"accessToken":"${CANARY}"}`, `"input_tokens":12,"password":"${CANARY}"`, V('{\\"pass', 'word\\":\\"', CANARY, '\\"}'),
  `{"type":"user","content":"line\\npassword: ${CANARY}\\nmore"}`,
  // CLI flags
  `mysql --password ${CANARY}`, `--token ${CANARY}`, `curl --token=${CANARY}`, `mysql -u root -p${CANARY}`, `curl -u admin:${CANARY} https://example.org`,
  // credentials in URLs and Authorization headers
  `https://user:${CANARY}@github.com/x.git`, `mqtt://ha:${CANARY}@10.0.0.5`, `Authorization: Basic ${CANARY}`,
  // OpenBao/Vault table output
  ['Key         Value', '---         -----', `password    ${CANARY}`].join('\n'),
];

test('redaction: every secret-named form from every review round is removed (seeded canary)', () => {
  for (const seed of SEEDS) assert.ok(!redactText(seed).includes(CANARY), `leaked from ${JSON.stringify(seed)} -> ${JSON.stringify(redactText(seed))}`);
  assert.ok(!redactText(SEEDS.join('\n')).includes(CANARY), 'all seeds in one text');
});

test('redaction: ordinary content survives (paths, counts, PWD, author names, SHAs, identifiers)', () => {
  for (const keep of ['cat /mnt/user/projects/DevTest-Infrastructure-claude-review/supervisor/transcript.mjs',
    'cd /mnt/user/projects/DevTest-Infrastructure-claude-review/supervisor', 'tokens: 1234', '"input_tokens":1234', 'PWD=/home/work',
    'name: build', 'GIT_AUTHOR_NAME=Unthred', 'author: Unthred', 'bypass=true', 'git push -u origin main', 'see https://example.org/plain',
    'commit ' + 'a1b2c3d4e5'.repeat(4), 'supervisor_transcript_redaction_long_identifier_name_here'])
    assert.equal(redactText(keep), keep);
  assert.equal(redactText(V('x Ab3dEf9hIj2lMn0p', 'Qr8tUv4xYz1bCd5fGh7jKl6n')), 'x [redacted token]', 'a random mixed token is still caught');
});

test('redaction: an already redacted value is not rewritten again', () => {
  assert.equal(redactText(`GITHUB_TOKEN=${GH}`), 'GITHUB_TOKEN=[redacted token]');
});

test('secret names: short words count only as a whole segment; environment values follow the same rule', () => {
  for (const n of ['DB_PASS', 'HA_PW', 'X_AUTH', 'apiKey', 'MY_SERVICE_KEY', 'X-Api-Key', 'client-secret', 'Set-Cookie', '--password']) assert.ok(isSecretName(n), n);
  for (const n of ['PWD', 'OLDPWD', 'GIT_AUTHOR_NAME', 'BYPASS', 'name', 'key', 'compass']) assert.ok(!isSecretName(n), n);
  assert.deepEqual(secretValues({ GIT_AUTHOR_NAME: 'Unthred', HA_PW: V('abc', 'def1'), MQTT_PASS: V('abc', 'def2'), PWD: '/home/work' }).sort(), [V('abc', 'def1'), V('abc', 'def2')]);
});

test('secret reads: the OpenBao HTTP API, delivered secret files, credential files and printing a secret variable count', () => {
  for (const c of ['curl -H "X-Vault-Token: $T" https://openbao.lan:8200/v1/secret/data/devtest/foo | jq -r .data.data.value',
    'curl -s "$BAO_ADDR/v1/kv/data/x"', 'cat /secrets/ha', 'cat /run/secrets/ha_password', 'printenv GH_TOKEN', 'echo $HA_TOKEN',
    'cat .env', 'bao login -method=approle', 'cat ~/.git-credentials', 'cat config/secrets.yaml', 'bao kv get secret/x'])
    assert.ok(isSecretRead(c), c);
  for (const c of ['ls', 'printenv PATH', 'echo $HOME', 'node -e "console.log(process.env.X)"', 'cat README.md']) assert.ok(!isSecretRead(c), c);
});

test('secret reads: an HTTP API read and a secret-file read through the writer leave no value on disk, ordinary results stay', t => {
  const bare = V('Sup3r-Cr4zy', '-Hunter2');
  const disk = feed(t, [claudeLine({ type: 'assistant', message: { id: 'm3', content: [
    { type: 'tool_use', id: 'toolu_api', name: 'Bash', input: { command: 'curl -H "X-Vault-Token: $T" https://openbao.lan:8200/v1/secret/data/devtest/foo | jq -r .data.data.value' } },
    { type: 'tool_use', id: 'toolu_file', name: 'Read', input: { file_path: '/run/secrets/ha_password' } },
    { type: 'tool_use', id: 'toolu_ls', name: 'Bash', input: { command: 'ls' } }] } }),
  claudeLine({ type: 'user', message: { content: [claudeResult('toolu_api', bare), claudeResult('toolu_file', `${bare}2`), claudeResult('toolu_ls', 'file-a file-b')] } })]);
  gone(disk, bare); assert.match(disk, /file-a file-b/);
});

test('secret reads: the evidence line of a dropped result is blanked as well', t => {
  const root = tmp(t), w = new TranscriptWriter(root, ID, { secrets: [] });
  w.append({ kind: 'tool_call', callId: 'c1', tool: 'Bash', text: 'bao kv get -field=password secret/x' });
  w.append({ kind: 'tool_result', callId: 'c1', text: PAR_SECRET, evidence: { event: 'crash', line: `raw ${PAR_SECRET}` } });
  const disk = fs.readFileSync(transcriptFile(root, ID), 'utf8');
  gone(disk, PAR_SECRET); assert.match(disk, /"event":"crash"/);
});

test('exact secret values are also caught in their JSON-escaped form (raw stream evidence lines)', () => {
  const value = V('quo"te\\', 'back-canary');
  const raw = JSON.stringify({ text: `value ${value}` });
  assert.ok(!redactText(raw, [value]).includes(JSON.stringify(value).slice(1, -1)));
});

test('redaction is bounded: pathological runs finish quickly, and a huge field is cut before redaction without leaking at the cut', () => {
  for (const p of ['-', 'a-', 'a=', 'a: ', '--a ', 'mysql ', '"a":', 'a:']) {
    const started = Date.now(); redactText(p.repeat(Math.ceil(64000 / p.length)));
    assert.ok(Date.now() - started < 2000, `slow on ${JSON.stringify(p)}`);
  }
  const huge = 'x '.repeat(ENTRY_TEXT_MAX) + `password: ${CANARY} ` + 'y'.repeat(100000);
  const out = sanitizeEntry({ kind: 'tool_result', text: huge }).text;
  gone(out, CANARY); assert.match(out, /more characters not recorded/); assert.ok(out.length < ENTRY_TEXT_MAX + 100);
});
