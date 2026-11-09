// Issue #623: foreman_job_outcome and foreman_discarded (D-030). The dashboard serves two bounded, redacted, read-only records and the
// MCP tools read them. Every secret-shaped fixture is assembled at run time; no model is called and no real state is read.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { jobOutcome, discarded, LOG_TAIL_ENTRIES } from '../supervisor/joboutcome.mjs';
import { handler } from '../supervisor/dashserver.mjs';
import { TranscriptWriter } from '../supervisor/transcript.mjs';
import { createTools, fitItems } from '../foreman-mcp/tools.mjs';
import { getJson } from '../foreman-mcp/source.mjs';

const ID = 'c'.repeat(32), ID2 = 'd'.repeat(32);
const GH = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');
const PW = ['pass', 'word'].join('');
const PWVAL = ['hunter2', 'hunter2x'].join('');
const BEARER = ['Bear', 'er ', 'abcdefgh', 'ijklmnop', '1234'].join('');
const tmp = (t, p = 'jo-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const CONFIG = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/nonexistent/repo', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' },
  limits: { per_agent: 1, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [30] }, codex: { provider: 'codex', branch_prefix: 'codex/', issues: [3] } } };

function seed(root) {
  fs.mkdirSync(path.join(root, 'jobs'), { recursive: true }); fs.mkdirSync(path.join(root, 'events'), { recursive: true }); fs.mkdirSync(path.join(root, 'team'), { recursive: true });
  fs.writeFileSync(path.join(root, 'jobs', `${ID}.json`), JSON.stringify({ id: ID, kind: 'rebase', provider: 'claude', status: 'completed', issue: 533, branch: `claude/issue-533-x ${PW}=${PWVAL}`, scope: `rebase PR 538 using ${GH}`, prompt: 'SHOULD NOT APPEAR: full prompt',
    createdAt: 1000, updatedAt: 9000, attempts: 2, lastEvent: 'incomplete', usage: { inputTokens: 900, outputTokens: 100, costUsdEstimate: 1.25 }, model: 'sonnet',
    postcondition: { kind: 'rebased', pr: 538 }, incompleteReason: { cause: 'postcondition_not_met', detail: `still conflicts ${PW}: ${PWVAL}`, attempt: 2 },
    checkpoint: { head: 'b'.repeat(40), status: [' M a.txt', ' M b.txt'] } }));
  fs.writeFileSync(path.join(root, 'events', `${ID}.jsonl`), ['created', 'started', 'checkpoint', 'incomplete'].map((kind, i) => JSON.stringify({ at: 1000 + i, job: ID, kind })).join('\n') + '\n');
  fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ jobs: { [ID]: { pr: 538, agent: 'claude', head: 'a'.repeat(40) } }, breaker: { waste: {
    [ID2]: { job: ID2, at: 5000, type: 'review', cause: 'review:refused:independence', agent: 'codex', pr: 575, issue: null, model: 'gpt', tokens: 5000, inputTokens: 4000, outputTokens: 1000, cost: 2.5 },
    [ID]: { job: ID, at: 4000, type: 'rebase', cause: `rebase:failed:x ${GH}`, agent: 'claude', pr: 538, issue: 533, model: 'sonnet', tokens: 1000, cost: 1.25 } } } }));
  const w = new TranscriptWriter(root, ID);
  for (let i = 0; i < 40; i++) w.append({ kind: 'tool_call', tool: 'Bash', text: i === 39 ? 'git push origin HEAD' : `step ${i}`, detail: `step ${i}` });
  w.append({ kind: 'assistant', text: `I could not finish: the key is ${GH} and ${PW}=${PWVAL} and ${BEARER}` });
}

test('the outcome says what was asked, what happened, how it ended and what it cost, and never the full prompt', t => {
  const root = tmp(t); seed(root);
  const o = jobOutcome(root, ID);
  assert.equal(o.status, 'completed'); assert.equal(o.kind, 'rebase'); assert.equal(o.pr, 538); assert.equal(o.attempts, 2);
  assert.match(o.asked, /rebase PR 538/);
  assert.equal(o.postcondition.kind, 'rebased'); assert.equal(o.postcondition.met, false); assert.equal(o.postcondition.notMetBecause.cause, 'postcondition_not_met'); assert.match(o.postcondition.notMetBecause.detail, /still conflicts/);
  assert.equal(o.pushed.headMovedLocally, true); assert.equal(o.pushed.uncommittedFiles, 2); assert.equal(o.pushed.pushCommandsInLog, 1);
  assert.deepEqual(o.cost, { tokens: 1000, gbpEquivalent: 0.94 });
  assert.deepEqual(o.events.map(e => e.kind), ['created', 'started', 'incomplete'], 'checkpoints are left out');
  assert.equal(o.logTail.length, LOG_TAIL_ENTRIES); assert.equal(o.did.toolCalls.Bash, 40);
  assert.ok(!JSON.stringify(o).includes('SHOULD NOT APPEAR'));
});

test('no secret-shaped text escapes the outcome or the discarded list (fixtures built at run time)', t => {
  const root = tmp(t); seed(root);
  for (const text of [JSON.stringify(jobOutcome(root, ID)), JSON.stringify(discarded(JSON.parse(fs.readFileSync(path.join(root, 'team', 'state.json'), 'utf8'))))]) {
    for (const bad of [GH, PWVAL, BEARER.split(' ')[1]]) assert.ok(!text.includes(bad), `leaked ${bad.slice(0, 6)}…`);
  }
});

test('an unknown job, a short id and a damaged record give nothing; a missing transcript is stated', t => {
  const root = tmp(t); seed(root);
  assert.equal(jobOutcome(root, 'e'.repeat(32)), null); assert.equal(jobOutcome(root, 'abc'), null); assert.equal(jobOutcome(root, '../../etc/passwd'), null);
  fs.writeFileSync(path.join(root, 'jobs', `${ID2}.json`), '{not json'); assert.equal(jobOutcome(root, ID2), null);
  fs.writeFileSync(path.join(root, 'jobs', `${ID2}.json`), JSON.stringify({ id: ID2, status: 'failed' }));
  const o = jobOutcome(root, ID2); assert.equal(o.did.transcriptAvailable, false); assert.deepEqual(o.logTail, []); assert.equal(o.postcondition.met, null); assert.equal(o.pushed.headMovedLocally, null);
});

test('discarded lists waste newest first with causes and cost, respects the limit and survives empty state', () => {
  const state = { breaker: { waste: { a: { job: 'a', at: 1, type: 'review', cause: 'review:no-verdict:x', tokens: 10, cost: 0.1 }, b: { job: 'b', at: 2, type: 'review', cause: 'review:refused:independence', tokens: 20, cost: 0.2 }, c: { job: 'c', at: 3, type: 'fix', cause: 'fix:failed:y', tokens: 30, cost: 0.3 } } } };
  const d = discarded(state, 2);
  assert.deepEqual(d.items.map(i => i.job), ['c', 'b']); assert.equal(d.count, 3); assert.equal(d.shown, 2); assert.equal(d.totalTokens, 60); assert.equal(d.totalCostGbpEquivalent, 0.45);
  assert.deepEqual(discarded({}).items, []); assert.deepEqual(discarded(null).items, []);
});

async function serve(t, root) {
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); t.after(() => server.closeAllConnections?.() || server.close());
  const port = server.address().port; server.on('request', handler({ root, config: CONFIG, host: '127.0.0.1', port }));
  const raw = (method, p) => new Promise((res, rej) => { const q = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}` } }, r => { let b = ''; r.on('data', d => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b })); }); q.on('error', rej); q.end(); });
  return { port, base: `http://127.0.0.1:${port}`, raw };
}

test('the dashboard routes are GET-only, strict about the id, and end to end through the MCP tools', async t => {
  const root = tmp(t); seed(root); const s = await serve(t, root);
  const out = JSON.parse((await s.raw('GET', `/api/jobs/${ID}/outcome.json`)).body); assert.equal(out.id, ID);
  assert.equal((await s.raw('GET', `/api/jobs/${'e'.repeat(32)}/outcome.json`)).status, 404);
  assert.equal((await s.raw('GET', '/api/jobs/short/outcome.json')).status, 404);
  assert.equal((await s.raw('GET', '/api/jobs/..%2f..%2fx/outcome.json')).status, 404);
  assert.equal((await s.raw('POST', `/api/jobs/${ID}/outcome.json`)).status !== 200, true);
  assert.equal((await s.raw('POST', '/api/discarded.json')).status !== 200, true);
  assert.equal(JSON.parse((await s.raw('GET', '/api/discarded.json')).body).count, 2);
  // More than 50 records: the dashboard must serve up to 200, not the helper's default of 50.
  const stPath = path.join(root, 'team', 'state.json'); const st0 = JSON.parse(fs.readFileSync(stPath, 'utf8')); const waste0 = st0.breaker.waste;
  st0.breaker.waste = { ...waste0, ...Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`w${i}`, { job: `w${i}`, at: 100 + i, type: 'review', cause: 'review:no-verdict:x', tokens: 1, cost: 0.01 }])) };
  fs.writeFileSync(stPath, JSON.stringify(st0));
  const big = JSON.parse((await s.raw('GET', '/api/discarded.json')).body); assert.equal(big.count, 122); assert.equal(big.items.length, 122);
  st0.breaker.waste = waste0; fs.writeFileSync(stPath, JSON.stringify(st0));
  const before = fs.readFileSync(path.join(root, 'team', 'state.json'), 'utf8');
  const view = { jobs: [{ fullId: ID }, { fullId: ID2 }, { fullId: ID.slice(0, 7) + 'a'.repeat(25) }] };
  const tools = createTools({ source: { get: async () => ({ view, ageMs: 0, stale: false }) }, readHost: () => ({}), getPath: p => getJson(new URL(p, `${s.base}/api/view.json`).href) });
  const names = tools.list().map(x => x.name); assert.ok(names.includes('foreman_job_outcome') && names.includes('foreman_discarded'));
  assert.ok(tools.list().filter(x => ['foreman_job_outcome', 'foreman_discarded'].includes(x.name)).every(x => x.annotations.readOnlyHint === true));
  const byFull = JSON.parse((await tools.call('foreman_job_outcome', { id: ID })).text); assert.equal(byFull.status, 'completed');
  assert.equal((await tools.call('foreman_job_outcome', { id: 'cccc' })).isError, true, 'too short');
  assert.match((await tools.call('foreman_job_outcome', { id: ID.slice(0, 7) })).text, /more than one job/);
  assert.equal((await tools.call('foreman_job_outcome', { id: 'zzzzzzzz' })).isError, true);
  assert.match((await tools.call('foreman_job_outcome', { id: 'ffffff' })).text, /no job with that id/);
  const d = JSON.parse((await tools.call('foreman_discarded', { limit: 1 })).text); assert.equal(d.items.length, 1); assert.equal(d.count, 2);
  for (const bad of [GH, PWVAL]) assert.ok(!(await tools.call('foreman_job_outcome', { id: ID })).text.includes(bad) && !(await tools.call('foreman_discarded')).text.includes(bad));
  assert.equal(fs.readFileSync(path.join(root, 'team', 'state.json'), 'utf8'), before, 'state is untouched');
});

test('foreman_discarded with a limit above 50 keeps shown equal to the list and states any cut', async () => {
  const mk = n => ({ count: n, items: Array.from({ length: n }, (_, i) => ({ job: `j${i}`.padEnd(32, 'a'), at: new Date(1e12 + i).toISOString(), type: 'review', cause: 'review:no-verdict:' + 'x'.repeat(90), agent: 'codex', model: 'gpt-5-codex-long-model-name', pr: 600 + i, issue: 100 + i, tokens: 123456, costGbpEquivalent: 1.23 })) });
  const run = async (n, args) => { const tools = createTools({ source: { get: async () => ({ view: {}, ageMs: 0, stale: false }) }, readHost: () => ({}), getPath: async () => mk(n) }); const r = await tools.call('foreman_discarded', args); return { r, d: JSON.parse(r.text) }; };
  // Few enough records: all 200 requested are returned, with no cut.
  const small = await run(30, { limit: 200 }); assert.equal(small.d.items.length, 30); assert.equal(small.d.shown, 30); assert.equal(small.d.truncated, undefined);
  // Realistic 200 records exceed the cap: the list is cut, flagged, and shown matches what is returned.
  const big = await run(200, { limit: 200 }); assert.ok(big.d.items.length > 0 && big.d.items.length < 200);
  assert.equal(big.d.shown, big.d.items.length); assert.equal(big.d.truncated, true); assert.match(big.d.truncatedNote, /fit the output limit/);
  assert.ok(big.r.text.length <= 24000); assert.equal(big.d.items[0].job, 'j0'.padEnd(32, 'a'), 'newest-first order is kept');
  // A smaller limit that fits is honoured exactly.
  const lim = await run(200, { limit: 10 }); assert.equal(lim.d.items.length, 10); assert.equal(lim.d.shown, 10); assert.equal(lim.d.truncated, undefined);
  // Null fields are left out; an entry that cannot fit gives zero entries and a note, not an oversize preview.
  const nn = createTools({ source: { get: async () => ({}) }, readHost: () => ({}), getPath: async () => ({ count: 1, items: [{ job: 'a', model: null, pr: null }] }) });
  assert.deepEqual(JSON.parse((await nn.call('foreman_discarded', {})).text).items, [{ job: 'a' }]);
  const huge = fitItems({ items: [{ cause: 'x'.repeat(2000) }] }, 'items', 5, 1000); assert.equal(huge.items.length, 0); assert.equal(huge.shown, 0); assert.match(huge.truncatedNote, /not even one/);
  const desc = createTools({ source: { get: async () => ({}) }, readHost: () => ({}), getPath: async () => mk(1) }).list().find(x => x.name === 'foreman_discarded').description; assert.match(desc, /at most 200/);
});

test('without a dashboard address the two tools fail cleanly', async () => {
  const tools = createTools({ source: { get: async () => ({ view: { jobs: [] }, ageMs: 0 }) }, readHost: () => ({}) });
  assert.equal((await tools.call('foreman_discarded')).isError, true);
  assert.equal((await tools.call('foreman_job_outcome', { id: 'a'.repeat(32) })).isError, true);
});
