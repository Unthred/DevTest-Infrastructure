// Issue #569 (decision D-030 proposed): the read-only MCP server. Protocol handling, agreement with the planner's review order, a proof that it
// cannot modify Foreman state, and no secret-shaped output. Every fixture is built at run time; no model is called and no real state is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProtocol, SUPPORTED, MAX_LINE_BYTES } from '../foreman-mcp/protocol.mjs';
import { createTools, bounded, MAX_TEXT, CALLS_PER_MINUTE } from '../foreman-mcp/tools.mjs';
import { createViewSource, getJson, readHost } from '../foreman-mcp/source.mjs';
import { createReports, REPORT_MAX_BYTES } from '../foreman-mcp/reports.mjs';
import { redact, redactDeep } from '../foreman-mcp/redact.mjs';
import { createCallLog } from '../foreman-mcp/calllog.mjs';
import { buildView } from '../supervisor/dashboard.mjs';
import { Team, validateTeamConfig } from '../supervisor/team.mjs';
import { stateRoot } from '../supervisor/core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url)), mcpDir = path.join(here, '..', 'foreman-mcp');
const tmp = (t, p = 'fmcp-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
// secret-shaped fixtures are assembled at run time so no secret-looking literal sits in the source
const rnd = n => crypto.randomBytes(n).toString('hex'), PW = 'pass' + 'word';
const H = n => String(n).repeat(40).slice(0, 40);
const green = [{ status: 'COMPLETED', conclusion: 'SUCCESS' }];

// ---- a stub dashboard that serves a fixed view; the server only ever sends GET
function viewServer(t, view) {
  const hits = { n: 0, methods: [] };
  const server = http.createServer((req, res) => { hits.n++; hits.methods.push(req.method); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(typeof view === 'function' ? view() : view)); });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => { t.after(() => server.close()); resolve({ url: `http://127.0.0.1:${server.address().port}/api/view.json`, hits }); }));
}
const smallView = () => ({
  health: { state: 'ok', label: 'ok', count: 1, severity: 'ok' }, freshness: { ageMs: 5, level: 'ok', label: 'fresh' }, tick: { at: 1000, status: 'ok', lastOkAt: 1000 }, nextTick: { state: 'scheduled' },
  version: { installed: 'aaaaaaa', main: 'aaaaaaa', behind: 0 }, teamEnabled: true, slots: [{ text: 'Reviewer: idle' }], capNotes: [], breaker: { halt: null, byCause: [] },
  agents: [{ name: 'claude', state: 'idle', idleReason: { text: 'nothing to do' } }], budget: { claude: { mode: 'normal', reason: 'ok', used: 0.1, projected: 0.2 } }, plan: [{ type: 'review', agent: 'claude', pr: 7, why: 'only claude can review' }],
  jobs: [{ id: 'abc', fullId: 'a'.repeat(32), kind: 'review', ref: 7, agent: 'claude', model: 'opus', status: 'completed', attempts: 1, startedAt: 1000, elapsedMs: 5000, tokens: 100, inTokens: 90, outTokens: 10, cost: 0.5, desc: 'Reviewer approved PR #7', hasTranscript: true }],
  prs: [{ number: 7, title: 'seven', status: 'open', head: H(1), checks: 'green', verdict: null, awaitingReview: true }, { number: 8, title: 'eight', status: 'open', head: H(2), checks: 'red', verdict: null }],
  queues: { claude: [{ type: 'review', ref: 7, title: 'seven', reason: 'review PR #7 (next) [review order 1 of 1: mergeable, older first]', next: true, order: 1 }, { type: 'pr', ref: 8, title: 'eight', reason: 'CI failing' }], codex: [] },
  attention: [{ id: 'h-8', text: '#8 needs you', ref: { kind: 'pull', n: 8 }, tried: 't', action: 'a', severity: 'action' }], issues: [{ number: 9, title: 'nine', state: 'OPEN', labels: [] }], excluded: [{ number: 9, kind: 'prerequisite', reason: 'blocked by #1' }], panels: { later: [{ number: 9, waits: 'a prerequisite', ends: 'when #1 closes' }], next: [], nextWhy: {} },
});
const toolsFor = (view, extra = {}) => createTools({ source: { get: async () => ({ view: typeof view === 'function' ? view() : view, ageMs: 0, stale: false }) }, readHost: () => ({ load: { one: 1 } }), ...extra });
const rpc = (p, o) => p.handleLine(JSON.stringify({ jsonrpc: '2.0', ...o }));
const call = async (p, name, args = {}) => (await rpc(p, { id: 1, method: 'tools/call', params: { name, arguments: args } }));

// ---- protocol
test('protocol: initialize negotiates the version, notifications get no reply, ping works, tools/list names twenty-one read-only tools (no inbox configured)', async () => {
  const p = createProtocol({ tools: toolsFor(smallView) });
  for (const v of SUPPORTED) assert.equal((await rpc(p, { id: 1, method: 'initialize', params: { protocolVersion: v } })).result.protocolVersion, v);
  assert.equal((await rpc(p, { id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })).result.protocolVersion, SUPPORTED[0], 'an unknown version gets the newest we support');
  assert.equal(await rpc(p, { method: 'notifications/initialized' }), null);
  assert.equal(p.initialized, true);
  assert.deepEqual((await rpc(p, { id: 3, method: 'ping' })).result, {});
  const list = (await rpc(p, { id: 4, method: 'tools/list' })).result.tools;
  assert.deepEqual(list.map(x => x.name).sort(), ['foreman_breaker_history', 'foreman_budget', 'foreman_config', 'foreman_diagnostics', 'foreman_discarded', 'foreman_host', 'foreman_installs', 'foreman_item_timeline', 'foreman_job_outcome', 'foreman_jobs', 'foreman_mismatches', 'foreman_needs_you', 'foreman_plan', 'foreman_rebase_stats', 'foreman_reports', 'foreman_review_order', 'foreman_status', 'foreman_tests', 'foreman_ticks', 'foreman_waste', 'foreman_why_blocked']);
  assert.ok(list.every(x => x.annotations.readOnlyHint === true && x.annotations.destructiveHint === false && x.inputSchema.type === 'object'));
});
test('protocol: a malformed line, a batch, a bad request, an unknown method and an unknown tool each get a JSON-RPC error and the server carries on', async () => {
  const p = createProtocol({ tools: toolsFor(smallView) });
  assert.equal((await p.handleLine('{nope')).error.code, -32700);
  assert.equal((await p.handleLine('[]')).error.code, -32600);
  assert.equal((await p.handleLine('{"jsonrpc":"2.0","id":5}')).error.code, -32600);
  assert.equal((await p.handleLine('{"jsonrpc":"1.0","id":5,"method":"ping"}')).error.code, -32600);
  assert.equal((await rpc(p, { id: 6, method: 'nope' })).error.code, -32601);
  assert.equal((await call(p, 'delete_everything')).error.code, -32602);
  assert.equal((await p.handleLine('x'.repeat(MAX_LINE_BYTES + 1))).error.code, -32600);
  assert.equal(await p.handleLine('   '), null);
  assert.deepEqual((await rpc(p, { id: 7, method: 'ping' })).result, {}, 'still alive');
});
test('protocol: the real server prints nothing but protocol on stdout and survives a malformed line', async t => {
  const dir = tmp(t), stub = await viewServer(t, smallView());
  const child = spawn(process.execPath, [path.join(mcpDir, 'server.mjs')], { env: { PATH: process.env.PATH, FOREMAN_MCP_VIEW_URL: stub.url, FOREMAN_MCP_LOG: path.join(dir, 'calls.log') }, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => child.kill('SIGKILL'));
  let out = ''; child.stdout.on('data', d => { out += d; });
  const send = o => child.stdin.write((typeof o === 'string' ? o : JSON.stringify({ jsonrpc: '2.0', ...o })) + '\n');
  send({ id: 1, method: 'initialize', params: { protocolVersion: SUPPORTED[0] } }); send({ method: 'notifications/initialized' }); send('garbage'); send({ id: 2, method: 'tools/list' }); send({ id: 3, method: 'tools/call', params: { name: 'foreman_status', arguments: {} } });
  child.stdin.end();
  await new Promise(r => child.on('close', r));
  const lines = out.split('\n').filter(Boolean);
  assert.equal(lines.length, 4, out.slice(0, 300));
  for (const l of lines) { const m = JSON.parse(l); assert.equal(m.jsonrpc, '2.0'); assert.ok('result' in m || 'error' in m); }
  assert.deepEqual(lines.map(l => JSON.parse(l).id), [1, null, 2, 3], 'replies keep the order of requests');
});

// ---- tools
test('foreman_plan breakerHalt: built from the real haltView, lists every halted cause, and surfaces a breaker error (issue #675)', async () => {
  const { haltView, normalize } = await import('../supervisor/breaker.mjs');
  const st = normalize({}); const ent = (cause, since, types) => ({ cause, since, types, jobs: 2, tokens: 10, cost: 0.1, prs: [], trippedBy: 'x' });
  st.halts = { 'ci-fail': ent('ci-fail', 1, ['implement']), 'review-loop': ent('review-loop', 2, ['review']) };
  const view = (breaker) => ({ ...smallView(), breaker });
  const run = async (breaker) => JSON.parse((await call(createProtocol({ tools: toolsFor(() => view(breaker)) }), 'foreman_plan')).result.content[0].text).breakerHalt;
  const h = await run({ halt: haltView(st, []) });
  assert.equal(h.halted, true); assert.equal(h.scope, 'new implement jobs'); assert.equal(h.cause, 'ci-fail'); assert.equal(h.count, 2);
  assert.deepEqual(h.entries.map(e => e.cause), ['ci-fail', 'review-loop']); assert.deepEqual(h.entries[1].types, ['review']);
  // A global halt (real s.global has no types) reports a label, not null.
  const gst = normalize({}); gst.global = { since: 1, trippedBy: 'cost', jobs: 3, tokens: 30, cost: 5, prs: [], causes: ['ci-fail'] };
  const g = await run({ halt: haltView(gst, []) });
  assert.equal(g.entries[0].cause, '@global'); assert.deepEqual(g.entries[0].types, ['every new job']); assert.match(g.scope, /every new job/);
  assert.deepEqual(await run({ halt: null, error: 'boom' }), { halted: false, error: 'boom', note: 'Breaker evaluation failed; existing halts stay in force.' });
  assert.deepEqual(await run({ halt: null, error: null }), { halted: false });
});

test('foreman_status carries the breaker error and no longer a never-set global (issue #753)', async () => {
  const st = async breaker => JSON.parse((await call(createProtocol({ tools: toolsFor(() => ({ ...smallView(), breaker })) }), 'foreman_status')).result.content[0].text).breaker;
  const withErr = await st({ halt: null, byCause: [], error: 'boom' });
  assert.equal(withErr.error, 'boom'); assert.ok(!('global' in withErr));
  assert.equal((await st({ halt: null, byCause: [] })).error, null);
});

test('tools: each tool answers from the view, with the planner\'s queue, reasons and cost', async () => {
  const p = createProtocol({ tools: toolsFor(smallView) });
  const j = async (name, args) => JSON.parse((await call(p, name, args)).result.content[0].text);
  const st = await j('foreman_status'); assert.equal(st.health.state, 'ok'); assert.equal(st.needsYouCount, 1); assert.deepEqual(st.planned.map(x => x.pr), [7]);
  const ro = await j('foreman_review_order'); assert.deepEqual(ro.reviewers.claude.map(x => x.pr), [7]); assert.equal(ro.notQueued[0].pr, 8); assert.match(ro.notQueued[0].why[0], /CI failing/);
  const wb = await j('foreman_why_blocked', { kind: 'pr', number: 8 }); assert.equal(wb.found, true); assert.match(wb.queue[0].reason, /CI failing/); assert.equal(wb.needsYou[0].text, '#8 needs you');
  const wi = await j('foreman_why_blocked', { kind: 'issue', number: 9 }); assert.match(wi.excluded[0].reason, /blocked by #1/); assert.equal(wi.waits[0].waits, 'a prerequisite');
  const jobs = await j('foreman_jobs', { ref: 7 }); assert.equal(jobs.jobs[0].costUsdEquivalent, 0.5); assert.match(jobs.note, /not a cash charge/); assert.equal(jobs.jobs[0].transcriptAvailable, true); assert.ok(!('transcript' in jobs.jobs[0]));
  assert.equal((await j('foreman_plan')).plannedActions[0].type, 'review'); assert.equal((await j('foreman_plan')).breakerHalt.halted, false);
  const halted = createProtocol({ tools: toolsFor(() => ({ ...smallView(), breaker: { halt: { scope: 'every new job', cause: '@global' } } })) });
  const hp = JSON.parse((await call(halted, 'foreman_plan')).result.content[0].text); assert.equal(hp.breakerHalt.halted, true); assert.match(hp.breakerHalt.caution, /would drop/);
  assert.equal((await j('foreman_host')).load.one, 1);
  const bad = await call(p, 'foreman_why_blocked', { kind: 'pr', number: -1 }); assert.equal(bad.result.isError, true);
});
test('tools: output is bounded however large the view, stays valid JSON, and says it was shortened', () => {
  const big = { jobs: Array.from({ length: 300 }, (_, i) => ({ id: i, desc: 'x'.repeat(400) })) };
  const text = bounded(big); assert.ok(text.length <= MAX_TEXT, String(text.length)); const parsed = JSON.parse(text); assert.equal(parsed.truncated, true); assert.ok(parsed.jobs.length < 300);
  assert.ok(bounded({ s: 'y'.repeat(100000) }).length <= MAX_TEXT);
});
test('tools: more than the per-minute limit is refused, then allowed again a minute later', async () => {
  let t0 = 1_000_000; const tools = toolsFor(smallView, { now: () => t0 });
  for (let i = 0; i < CALLS_PER_MINUTE; i++) assert.equal((await tools.call('foreman_host')).isError, false);
  assert.match((await tools.call('foreman_host')).text, /rate limit/);
  t0 += 61000; assert.equal((await tools.call('foreman_host')).isError, false);
});
test('source: a silent dashboard times out, an oversized body is refused, a failure serves the last good copy marked stale, and only http is accepted', async t => {
  const silent = http.createServer(() => {}); await new Promise(r => silent.listen(0, '127.0.0.1', r)); t.after(() => { silent.closeAllConnections?.(); silent.close(); });
  await assert.rejects(getJson(`http://127.0.0.1:${silent.address().port}/x`, { timeoutMs: 200 }), /did not answer/);
  const big = http.createServer((q, r) => r.end(JSON.stringify({ pad: 'z'.repeat(5000) }))); await new Promise(r => big.listen(0, '127.0.0.1', r)); t.after(() => big.close());
  await assert.rejects(getJson(`http://127.0.0.1:${big.address().port}/x`, { maxBytes: 1000 }), /size limit/);
  await assert.rejects(getJson('file:///etc/passwd'), /only an http/);
  let fail = false, now = 0; const src = createViewSource({ url: 'http://x/y', now: () => now, cacheMs: 100, fetchJson: async () => { if (fail) throw new Error('down'); return { a: 1 }; } });
  assert.equal((await src.get()).stale, false); fail = true; now = 50; assert.equal((await src.get()).stale, false, 'cached');
  now = 500; const r = await src.get(); assert.equal(r.stale, true); assert.equal(r.error, 'down'); assert.deepEqual(r.view, { a: 1 });
  await assert.rejects(createViewSource({ url: '', fetchJson: async () => ({}) }).get(), /no dashboard address/);
});
test('source: host figures come from /proc text and anything unreadable is null', () => {
  const files = { '/p/loadavg': '1.5 2.5 3.5 1/200 99\n', '/p/meminfo': 'MemTotal: 1024000 kB\nMemAvailable: 512000 kB\nMemFree: 1000 kB\nCached: 2000 kB\nSwapTotal: 2048000 kB\nSwapFree: 512000 kB\n' };
  const h = readHost({ proc: '/p', fsRead: f => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; } });
  assert.deepEqual(h.load, { one: 1.5, five: 2.5, fifteen: 3.5 }); assert.equal(h.swapMb.usedPercent, 75); assert.equal(h.memoryMb.available, 500); assert.ok(!('memoryPressure' in h));
  files['/p/pressure/memory'] = 'some avg10=0.00\nfull avg10=0.00\n'; assert.equal(readHost({ proc: '/p', fsRead: f => { if (!(f in files)) throw new Error('ENOENT'); return files[f]; } }).memoryPressure.length, 2);
});

// ---- the review order agrees with the planner
test('review order: the tool lists reviews in exactly the order the planner\'s own queue gives (same fixture, real Team and real dashboard view)', async t => {
  const cfg = validateTeamConfig({ schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
    agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [23] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [2] } },
    board: { owner: 'o', number: 1, project_id: 'P', status_field_id: 'F', options: { in_progress: 'a', in_review: 'b', done: 'c' } } });
  const pr = (n, branch, head, extra = {}) => ({ number: n, title: `t${n}`, headRefName: branch, headRefOid: head, baseRefName: 'main', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', statusCheckRollup: green, url: `https://example.invalid/pull/${n}`, labels: [], ...extra });
  const pulls = [pr(10, 'codex/issue-2-a', H(1), { mergeable: 'UNKNOWN' }), pr(20, 'codex/issue-3-b', H(2)), pr(30, 'codex/issue-4-c', H(3)), pr(40, 'codex/issue-5-d', H(4), { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] }), pr(50, 'codex/issue-6-e', H(5), { isDraft: true })];
  const state = { verdicts: { [`30:${H(9)}`]: { verdict: 'CHANGES', reviewer: 'claude', at: 1 } }, jobs: {} };
  const dir = tmp(t);
  const team = new Team({ config: cfg, root: stateRoot(path.join(dir, 'state')), gh: { listPulls: async () => pulls, getPull: async n => pulls.find(p => p.number === n) || null, listIssues: async () => [], listMergedPulls: async () => [] }, jobs: { listActive: async () => [], get: async () => null }, git: { worktreeFor: async () => null }, register: '', clock: { now: () => 5000 } });
  team.s.verdicts = structuredClone(state.verdicts);
  const planner = team.reviewOrder('claude', team.reviewQueue('claude', pulls).map(q => q.pr)).map(p => p.number);
  const view = await buildView({ config: cfg, root: '/nonexistent', jobs: [], events: [], state, cache: { tick: { at: 4000, status: 'ok', lastOkAt: 4000 }, fetchedAt: 4000, pulls, issues: [], merged: [] }, snapshots: [], now: 5000 });
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0, stale: false }) }, readHost: () => ({}) });
  const r = JSON.parse((await tools.call('foreman_review_order')).text);
  assert.deepEqual(planner, [30, 20, 10], 'the planner\'s own order for this fixture');
  assert.deepEqual(r.reviewers.claude.map(x => x.pr), planner, 'the tool agrees with the planner');
  const skipped = Object.fromEntries(r.notQueued.map(x => [x.pr, x.why.join(' ')]));
  assert.match(skipped[40], /CI failing/);
  assert.ok(!(50 in Object.fromEntries(r.reviewers.claude.map(x => [x.pr, 1]))), 'a draft is never queued for review');
});

// ---- it cannot modify Foreman state
test('read-only: the sources contain no file-writing, process-spawning or Foreman imports, apart from the call log', () => {
  const FORBIDDEN = /\b(writeFile(Sync)?|appendFile(Sync)?|mkdir(Sync)?|rm(Sync)?|rmdir(Sync)?|rename(Sync)?|unlink(Sync)?|copyFile(Sync)?|chmod(Sync)?|chown(Sync)?|symlink(Sync)?|truncate(Sync)?|createWriteStream|child_process|execSync|spawnSync|execFile|fork)\b|\bspawn\(|(?<![.\w])exec\(|supervisor\//;
  for (const f of fs.readdirSync(mcpDir).filter(x => x.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(mcpDir, f), 'utf8').replace(/\/\/.*$/gm, '');
    if (f === 'calllog.mjs') { assert.deepEqual([...new Set(src.match(/\b(appendFileSync|mkdirSync|renameSync)\b/g))].sort(), ['appendFileSync', 'mkdirSync', 'renameSync']); assert.ok(!/writeFile|createWriteStream|rmSync|unlink|chmod/.test(src)); continue; }
    // issue #124: the inbox is the one other writer. It may only create a new file (flag wx) in <inbox>/items; no other write call, no spawn, no Foreman import.
    if (f === 'inbox.mjs') { assert.deepEqual([...new Set(src.match(/\b(writeFile(Sync)?|appendFile(Sync)?|mkdir(Sync)?|rm(Sync)?|rename(Sync)?|unlink(Sync)?|copyFile(Sync)?|chmod(Sync)?|createWriteStream)\b/g))], ['writeFileSync']); assert.equal(src.match(/writeFileSync\(/g).length, 1); assert.match(src, /writeFileSync\(file, .*flag: 'wx'/); assert.match(src, /file = path\.join\(items, /); assert.ok(!/child_process|spawn|supervisor\//.test(src)); continue; }
    assert.ok(!FORBIDDEN.test(src), `${f} must not write files, spawn processes or import Foreman code`);
  }
});
test('read-only: run through the launcher with the permission model, every tool leaves a fake Foreman state tree byte-for-byte unchanged and only the call log is written', async t => {
  const dir = tmp(t), stub = await viewServer(t, smallView());
  const copy = path.join(dir, 'srv'); fs.cpSync(mcpDir, copy, { recursive: true });
  const state = path.join(dir, 'state'); fs.mkdirSync(path.join(state, 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(state, 'jobs', 'j.json'), '{"status":"running"}'); fs.writeFileSync(path.join(state, 'team.local.json'), '{"enabled":true}');
  const logDir = path.join(dir, 'logs'); fs.mkdirSync(logDir);
  const cfgFile = path.join(dir, 'config.json'); fs.writeFileSync(cfgFile, JSON.stringify({ viewUrl: stub.url, logFile: path.join(logDir, 'calls.log') }));
  fs.writeFileSync(path.join(copy, 'launcher.env'), `NODE_BIN=${process.execPath}\nCONFIG_FILE=${cfgFile}\nLOG_DIR=${logDir}\n`);
  const snap = () => { const out = {}; const walk = d => { for (const n of fs.readdirSync(d).sort()) { const f = path.join(d, n), s = fs.statSync(f); out[f] = s.isDirectory() ? 'dir' : crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') + ':' + s.mtimeMs; if (s.isDirectory()) walk(f); } }; walk(state); return JSON.stringify(out); };
  const before = snap();
  const names = ['foreman_status', 'foreman_review_order', 'foreman_why_blocked', 'foreman_jobs', 'foreman_plan', 'foreman_host'];
  const input = [{ id: 1, method: 'initialize', params: { protocolVersion: SUPPORTED[0] } }, ...names.map((name, i) => ({ id: 10 + i, method: 'tools/call', params: { name, arguments: name === 'foreman_why_blocked' ? { kind: 'pr', number: 8 } : {} } }))].map(o => JSON.stringify({ jsonrpc: '2.0', ...o })).join('\n') + '\n';
  const r = await new Promise(resolve => { const c = spawn('sh', [path.join(copy, 'launcher.sh')], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] }); let stdout = '', stderr = ''; const timer = setTimeout(() => c.kill('SIGKILL'), 30000); c.stdout.on('data', d => { stdout += d; }); c.stderr.on('data', d => { stderr += d; }); c.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); }); c.stdin.end(input); });
  assert.equal(r.status, 0, r.stderr);
  const replies = r.stdout.split('\n').filter(Boolean).map(l => JSON.parse(l)); assert.equal(replies.length, 7);
  for (const m of replies.slice(1)) { assert.equal(m.result.isError, false, JSON.stringify(m).slice(0, 200)); assert.ok(m.result.content[0].text.length <= MAX_TEXT); }
  assert.equal(snap(), before, 'the fake Foreman state is unchanged');
  assert.deepEqual(stub.hits.methods.filter(m => m !== 'GET'), [], 'only GET requests were sent to the dashboard');
  const log = fs.readFileSync(path.join(logDir, 'calls.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)); assert.deepEqual(log.map(e => e.tool), names); assert.ok(log.every(e => typeof e.ms === 'number' && e.at));
  // and the permission model really refuses a write outside the log directory (so a bug could not write either)
  const probe = spawnSync(process.execPath, ['--permission', `--allow-fs-read=${copy}`, `--allow-fs-write=${logDir}`, '-e', `try { require('fs').writeFileSync(${JSON.stringify(path.join(state, 'x'))}, 'y'); console.log('WROTE'); } catch (e) { console.log(e.code); }`], { encoding: 'utf8' });
  assert.equal(probe.stdout.trim(), 'ERR_ACCESS_DENIED'); assert.equal(snap(), before);
});
test('call log: arguments are redacted, the file is size limited, and a logging failure never fails a call', t => {
  const dir = tmp(t), file = path.join(dir, 'l', 'calls.log'); let now = 0; const log = createCallLog(file, { maxBytes: 400, now: () => (now += 1000) });
  const tok = 'ghp_' + 'Ab1'.repeat(12);
  for (let i = 0; i < 20; i++) log.record({ tool: 'foreman_jobs', args: { id: tok, n: i }, ms: 5, ok: true });
  const text = fs.readFileSync(file, 'utf8') + fs.readFileSync(file + '.1', 'utf8'); assert.ok(!text.includes(tok)); assert.match(text, /\[redacted/);
  assert.ok(fs.statSync(file).size < 1200 && fs.existsSync(file + '.1'));
  fs.writeFileSync(path.join(dir, 'blocker'), 'a file, not a directory');
  assert.doesNotThrow(() => createCallLog(path.join(dir, 'blocker', 'sub', 'calls.log')).record({ tool: 'x' }));
});

// ---- no secret-shaped output
test('secrets: nothing secret-shaped leaves any tool or reaches the call log, whatever the view holds (fixtures built at run time)', async t => {
  const dir = tmp(t), secrets = ['ghp_' + 'Zx9'.repeat(12), 'github_pat_' + 'Q7'.repeat(20), 'sk-' + 'Lm4'.repeat(10), 'AKIA' + 'ABCDEFGH12345678', 'xoxb-' + '1234567890'.repeat(2),
    'Bearer ' + 'eyJ'.repeat(12), PW + '=' + rnd(8), 'https://user:' + rnd(6) + '@example.invalid/x', '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\n' + 'b3BlbnNzaC1rZXk'.repeat(5) + '\n-----END ' + 'OPENSSH PRIVATE KEY-----'];
  const view = smallView(); view.jobs[0].desc = secrets.join(' | '); view.prs[0].title = secrets[0]; view.queues.claude[0].reason = secrets[5]; view.attention[0].action = secrets[6]; view.attention[0].text = secrets[7] + ' ' + secrets[8];
  const log = path.join(dir, 'calls.log'), callLog = createCallLog(log);
  const p = createProtocol({ tools: toolsFor(view), log: e => callLog.record(e) });
  const outputs = [];
  for (const name of ['foreman_status', 'foreman_review_order', 'foreman_why_blocked', 'foreman_jobs', 'foreman_plan', 'foreman_host']) outputs.push((await call(p, name, name === 'foreman_why_blocked' ? { kind: 'pr', number: 8 } : { id: secrets[0] })).result.content[0].text);
  const all = outputs.join('\n') + fs.readFileSync(log, 'utf8');
  for (const s of secrets) for (const frag of [s, s.split(/[= ]/).pop()].filter(x => x.length > 8)) assert.ok(!all.includes(frag.split('\n')[0]), `leaked: ${frag.slice(0, 14)}…`);
  assert.equal(redact('plain text with PR #12 and head 1a2b3c4'), 'plain text with PR #12 and head 1a2b3c4');
  assert.deepEqual(redactDeep({ token: rnd(5), nested: ['ok', PW + ': ' + rnd(5)] }), { token: '[redacted]', nested: ['ok', PW + ': [redacted]'] });
});

// ---- foreman_reports (issue #612): hand-run session reports from one fixed folder
const reportsWorld = (t, files = {}) => {
  const dir = tmp(t, 'fmcp-rep-'), root = path.join(dir, 'reports'); fs.mkdirSync(root);
  for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(root, n), c);
  return { dir, root, tools: createTools({ source: { get: async () => ({ view: smallView(), ageMs: 0, stale: false }) }, readHost: () => ({}), reports: createReports(root, { redact }) }) };
};
test('reports: with no name the tool lists reports newest first with name, time and size, and skips files that are not reports', async t => {
  const w = reportsWorld(t, { 'old.md': 'old', 'new.md': 'newer text', 'notes.txt': 'n', 'secrets.env': 'x', '.hidden.md': 'h', 'noext': 'z' });
  const now = Date.now() / 1000; fs.utimesSync(path.join(w.root, 'old.md'), now - 7200, now - 7200); fs.utimesSync(path.join(w.root, 'new.md'), now - 60, now - 60); fs.utimesSync(path.join(w.root, 'notes.txt'), now - 3600, now - 3600);
  const r = JSON.parse((await w.tools.call('foreman_reports')).text);
  assert.deepEqual(r.reports.map(x => x.name), ['new.md', 'notes.txt', 'old.md']);
  assert.equal(r.reports[0].bytes, 'newer text'.length); assert.match(r.reports[0].modified, /^\d{4}-\d\d-\d\dT/);
});
test('reports: with a name the tool returns that report; an unknown name is an error, not a crash', async t => {
  const w = reportsWorld(t, { 'a.md': 'hello report' });
  const r = await w.tools.call('foreman_reports', { name: 'a.md' }); assert.equal(r.isError, false); assert.match(r.text, /^a\.md \(/); assert.match(r.text, /hello report/);
  const missing = await w.tools.call('foreman_reports', { name: 'nope.md' }); assert.equal(missing.isError, true); assert.match(missing.text, /no such report/);
});
test('reports: a long report is truncated with a clear marker, within the output limit; a huge file is read only up to the byte cap', async t => {
  const w = reportsWorld(t, { 'long.md': 'line of report text\n'.repeat(5000), 'huge.md': 'x'.repeat(REPORT_MAX_BYTES + 5000) });
  const long = await w.tools.call('foreman_reports', { name: 'long.md' }); assert.ok(long.text.length <= MAX_TEXT, String(long.text.length)); assert.match(long.text, /\[truncated: \d+ more characters not shown\]$/);
  const huge = await w.tools.call('foreman_reports', { name: 'huge.md' }); assert.ok(huge.text.length <= MAX_TEXT); assert.match(huge.text, /\[truncated: \d+ more characters not shown\]$/);
  assert.match(huge.text, /^huge\.md \(.*, 267144 bytes\)/);
});
test('reports: secret-shaped text in a report is redacted (fixtures built at run time)', async t => {
  const tok = 'ghp_' + 'Qw7'.repeat(12), pw = PW + '=' + rnd(8);
  const w = reportsWorld(t, { 'r.md': `token ${tok} and ${pw} and url https://user:${rnd(6)}@example.invalid/x` });
  const r = (await w.tools.call('foreman_reports', { name: 'r.md' })).text;
  assert.ok(!r.includes(tok) && !r.includes(pw.split('=')[1]) && !/user:[0-9a-f]{12}@/.test(r)); assert.match(r, /\[redacted/);
});
test('reports: a secret that straddles the truncation cut is redacted whole, never half shown', async t => {
  const tok = 'ghp_' + 'Qw7'.repeat(12), cut = MAX_TEXT - 400;
  for (const offset of [2, 6, 14, 20, 30]) {
    const w = reportsWorld(t, { 'cut.md': 'a'.repeat(cut - offset) + ' ' + tok + ' ' + 'b'.repeat(2000) });
    const header = (await w.tools.call('foreman_reports', { name: 'cut.md' })).text;
    assert.ok(!/ghp_/.test(header) || /\[redacted/.test(header), 'no token prefix in clear at offset ' + offset);
    assert.ok(!header.includes('ghp_Qw'), 'offset ' + offset);
    assert.match(header, /\[truncated: \d+ more characters not shown\]$/);
  }
});
test('reports: path traversal is impossible: separators, dots, absolute paths, encodings and odd names are all refused', async t => {
  const w = reportsWorld(t, { 'a.md': 'a' }); fs.writeFileSync(path.join(w.dir, 'outside.md'), 'outside secret');
  for (const name of ['../outside.md', '..', '../../etc/passwd', '/etc/passwd', 'sub/a.md', 'a/../a.md', '..%2foutside.md', '%2e%2e/outside.md', '.hidden.md', 'a.md\0', 'a.md/', 'a.sh', 'a', '', ' a.md', 'a.md ', 'A'.repeat(200) + '.md', 'C:\\x.md', 42, null, {}]) {
    const r = await w.tools.call('foreman_reports', { name }); assert.equal(r.isError, true, `refused: ${JSON.stringify(name)}`); assert.ok(!r.text.includes('outside secret'));
  }
});
test('reports: a symbolic link is never followed, whether it points outside the folder, inside it, or at a directory', async t => {
  const w = reportsWorld(t, { 'real.md': 'real report' }); fs.writeFileSync(path.join(w.dir, 'outside.md'), 'outside secret'); fs.mkdirSync(path.join(w.dir, 'adir'));
  fs.symlinkSync(path.join(w.dir, 'outside.md'), path.join(w.root, 'link-out.md')); fs.symlinkSync(path.join(w.root, 'real.md'), path.join(w.root, 'link-in.md')); fs.symlinkSync(path.join(w.dir, 'adir'), path.join(w.root, 'link-dir.md'));
  const listed = JSON.parse((await w.tools.call('foreman_reports')).text).reports.map(x => x.name); assert.deepEqual(listed, ['real.md'], 'links are not listed');
  for (const name of ['link-out.md', 'link-in.md', 'link-dir.md']) { const r = await w.tools.call('foreman_reports', { name }); assert.equal(r.isError, true, name); assert.ok(!r.text.includes('outside secret') && !r.text.includes('real report'), name); }
});
test('reports: not configured, or a missing folder, says so; the tool never writes (the folder is unchanged by every call)', async t => {
  const none = createTools({ source: { get: async () => ({ view: smallView(), ageMs: 0, stale: false }) }, readHost: () => ({}), reports: createReports(null) });
  const r = await none.call('foreman_reports'); assert.equal(r.isError, true); assert.match(r.text, /no reports folder is configured/);
  const w = reportsWorld(t, { 'a.md': 'a' }); const before = JSON.stringify(fs.readdirSync(w.root).map(n => [n, fs.statSync(path.join(w.root, n)).mtimeMs]));
  await w.tools.call('foreman_reports'); await w.tools.call('foreman_reports', { name: 'a.md' }); await w.tools.call('foreman_reports', { name: '../x.md' });
  assert.equal(JSON.stringify(fs.readdirSync(w.root).map(n => [n, fs.statSync(path.join(w.root, n)).mtimeMs])), before);
});
test('reports: through the launcher with the permission model, the configured folder is readable and nothing else is', async t => {
  const dir = tmp(t, 'fmcp-repl-'), copy = path.join(dir, 'srv'); fs.cpSync(mcpDir, copy, { recursive: true });
  const reports = path.join(dir, 'reports'), logs = path.join(dir, 'logs'); fs.mkdirSync(reports); fs.mkdirSync(logs); fs.writeFileSync(path.join(reports, 'speedup.md'), 'report body'); fs.writeFileSync(path.join(dir, 'other.md'), 'not a report');
  const cfg = path.join(dir, 'config.json'); fs.writeFileSync(cfg, JSON.stringify({ viewUrl: null, logFile: path.join(logs, 'calls.log'), reportsDir: reports }));
  fs.writeFileSync(path.join(copy, 'launcher.env'), `NODE_BIN=${process.execPath}\nCONFIG_FILE=${cfg}\nLOG_DIR=${logs}\nREPORTS_DIR=${reports}\n`);
  const input = [{ id: 1, method: 'initialize', params: { protocolVersion: SUPPORTED[0] } }, { id: 2, method: 'tools/call', params: { name: 'foreman_reports', arguments: {} } }, { id: 3, method: 'tools/call', params: { name: 'foreman_reports', arguments: { name: 'speedup.md' } } }].map(o => JSON.stringify({ jsonrpc: '2.0', ...o })).join('\n') + '\n';
  const r = await new Promise(resolve => { const c = spawn('sh', [path.join(copy, 'launcher.sh')], { env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'] }); let out = ''; const timer = setTimeout(() => c.kill('SIGKILL'), 30000); c.stdout.on('data', d => { out += d; }); c.on('close', code => { clearTimeout(timer); resolve({ code, out }); }); c.stdin.end(input); });
  assert.equal(r.code, 0); const replies = r.out.split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.deepEqual(JSON.parse(replies[1].result.content[0].text).reports.map(x => x.name), ['speedup.md']); assert.match(replies[2].result.content[0].text, /report body/);
});
