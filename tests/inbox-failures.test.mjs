// Issue #1154: failed Inbox jobs are diagnosed and resolved, never left to expire. Real inbox files in a temp folder; no model, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as inbox from '../supervisor/inbox.mjs';
import { inboxEndPatch } from '../supervisor/inboxoutcome.mjs';
import { isReadOnlyPrompt } from '../supervisor/inboxcause.mjs';
import { backfillFailures } from '../supervisor/inboxbackfill.mjs';
import { inboxAttention } from '../supervisor/inboxattention.mjs';
import { resolveByHomeowner } from '../supervisor/inboxresolve.mjs';
import { waitedMs, pollingOf } from '../supervisor/inboxpolling.mjs';
import { changedLimits } from '../supervisor/inboxconfig.mjs';
import http from 'node:http';
import { handler } from '../supervisor/dashserver.mjs';
import { writeToken } from '../supervisor/dashwrite.mjs';
import { createTools } from '../foreman-mcp/tools.mjs';
import { createToolset } from '../foreman-mcp/toolset.mjs';
import { createInbox, checkProposal } from '../foreman-mcp/inbox.mjs';

const hex = n => crypto.randomBytes(n).toString('hex');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'inboxfail-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const makeInbox = t => { const d = tmp(t); fs.mkdirSync(path.join(d, 'items')); fs.mkdirSync(path.join(d, 'status')); return d; };
const drop = (dir, item) => { const id = hex(16); fs.writeFileSync(path.join(dir, 'items', `${id}.json`), JSON.stringify(item)); return id; };
const PROMPT = { kind: 'prompt', title: 'Tidy the docs index', prompt: 'Fix the broken link in docs/README.md.' };
const NOW = Date.UTC(2026, 10, 12);

// A finished job's summary file, as the end-of-job code reads it.
function endWith(t, { summary, status = 'completed', capStopped = false, item = PROMPT, incompleteReason, extra = {} }) {
  const teamDir = tmp(t), ticket = 'tk1';
  fs.mkdirSync(path.join(teamDir, 'inbox', ticket), { recursive: true });
  if (summary !== undefined) fs.writeFileSync(path.join(teamDir, 'inbox', ticket, 'inbox-result.txt'), summary);
  return inboxEndPatch({ id: hex(16), j: { ticket, capStopped, ...extra }, job: { status, incompleteReason }, teamDir, capMs: 15 * 60000, item });
}

test('requirement 1: a read only prompt that wrote its result and changed nothing is done; a change-required prompt that changed nothing fails', t => {
  const verify = { kind: 'prompt', title: 'Verify issue 924 is installed and working', prompt: 'Check the installed version.' };
  const ok = endWith(t, { summary: 'STATUS: nothing_changed\nVerified read-only. Nothing was changed.', item: verify });
  assert.equal(ok.state, 'done'); assert.equal(ok.cause, null); assert.equal(ok.reason, null);
  const marked = endWith(t, { summary: 'STATUS: nothing_changed\nlooked', item: { ...PROMPT, prompt: 'This task is read only. List the open pull requests.' } });
  assert.equal(marked.state, 'done');
  const bad = endWith(t, { summary: 'STATUS: nothing_changed\nI found nothing to fix.' });
  assert.equal(bad.state, 'failed'); assert.equal(bad.cause, 'no_change'); assert.match(bad.evidence, /changed nothing/);
  // "check and fix" asks for a change, so it is not read only even though it starts with "check"
  assert.equal(isReadOnlyPrompt({ title: 'Check the link and fix it', prompt: 'x' }), false);
  assert.equal(isReadOnlyPrompt({ title: 'Do it', prompt: 'This is not read only; edit the file.' }), false);
  assert.equal(endWith(t, { summary: 'STATUS: nothing_changed\nx', item: { ...PROMPT, title: 'Check the link and fix it' } }).cause, 'no_change');
});

test('requirement 2: every failure records a cause from the fixed list with an evidence line', t => {
  const cases = [
    [{ summary: undefined, status: 'failed', capStopped: true }, 'time_cap'],
    [{ summary: '', status: 'completed' }, 'no_result'],
    [{ summary: 'STATUS: failed\nbroke' }, 'fault'],
    [{ status: 'failed', incompleteReason: { cause: 'crash', detail: 'worker exited' } }, 'fault'],
    [{ status: 'failed', incompleteReason: { cause: 'usage_limit', detail: 'allowance reached' } }, 'allowance'],
    [{ status: 'failed', incompleteReason: { cause: 'guard', detail: 'refused by policy' } }, 'guard_refused'],
  ];
  for (const [args, cause] of cases) {
    const p = endWith(t, args);
    assert.equal(p.state, 'failed'); assert.equal(p.cause, cause, JSON.stringify(args)); assert.ok(p.evidence.length > 0);
  }
});

test('requirement 3: an unresolved failed item never leaves Needs you or the keep-days sweep; any resolution releases it', t => {
  const dir = makeInbox(t), a = drop(dir, PROMPT), b = drop(dir, { ...PROMPT, prompt: 'Second' });
  inbox.scan(dir, NOW);
  inbox.finish(dir, a, { state: 'failed', cause: 'fault', evidence: 'boom', reason: 'boom' }, NOW);
  inbox.finish(dir, b, { state: 'failed', cause: 'fault', evidence: 'boom2', reason: 'boom2' }, NOW);
  const later = NOW + 365 * 86400000;
  inbox.scan(dir, later);
  assert.equal(inbox.failedCards(dir).length, 2, 'both still shown a year on');
  assert.ok(inbox.statusOf(dir, a) && inbox.statusOf(dir, b));
  assert.equal(resolveByHomeowner(inbox, dir, a, { decision: 'drop', note: '' }, later).ok, false, 'a note is required');
  assert.equal(resolveByHomeowner(inbox, dir, a, { decision: 'done_elsewhere', note: 'pull request 12' }, later).ok, true);
  assert.deepEqual(inbox.failedCards(dir).map(c => c.id), [b]);
  assert.equal(resolveByHomeowner(inbox, dir, a, { decision: 'drop', note: 'again' }, later).ok, false, 'resolved once');
  inbox.scan(dir, later + 15 * 86400000);
  assert.equal(inbox.statusOf(dir, a), null, 'a resolved item is swept after keep-days like any final item');
  assert.ok(inbox.statusOf(dir, b), 'the unresolved one is kept');
});

test('requirement 3: existing failed items are backfilled with a cause and shown with no resolution', t => {
  const dir = makeInbox(t), a = drop(dir, PROMPT), cap = drop(dir, { ...PROMPT, prompt: 'two' });
  inbox.scan(dir, NOW);
  inbox.finish(dir, a, { state: 'failed', kind: 'prompt', title: 'Verify issue 924 is installed', job: '867710c6', reason: 'the agent reported that it changed nothing', result: 'the agent reported that it changed nothing. Agent summary: STATUS: nothing_changed\nVerified read-only.' }, NOW);
  inbox.finish(dir, cap, { state: 'failed', job: 'd674cc94', reason: 'stopped after the 15-minute inbox time cap (limits.inbox_max_minutes)', result: 'stopped after the 15-minute inbox time cap; it left no summary' }, NOW);
  backfillFailures(inbox, dir, NOW);
  assert.equal(inbox.statusOf(dir, a).state, 'done', 'the read only verification is put right');
  assert.equal(inbox.statusOf(dir, a).reason, null);
  assert.equal(inbox.statusOf(dir, cap).cause, 'time_cap');
  assert.match(inbox.statusOf(dir, cap).evidence, /time cap/);
  assert.equal(inbox.statusOf(dir, cap).resolution, undefined);
  backfillFailures(inbox, dir, NOW + 1);   // idempotent
  assert.equal(inbox.statusOf(dir, cap).updatedAt, NOW);
});

test('requirement 3 and 4: `resolves` links the old item when the new proposal is picked up, and is refused for anything else', t => {
  const dir = makeInbox(t), old = drop(dir, PROMPT);
  inbox.scan(dir, NOW);
  inbox.finish(dir, old, { state: 'failed', cause: 'time_cap', evidence: 'cap', reason: 'cap' }, NOW);
  const next = drop(dir, { ...PROMPT, prompt: 'Again, without waiting', resolves: old.slice(0, 8) });
  inbox.scan(dir, NOW + 1000);
  assert.equal(inbox.statusOf(dir, next).state, 'pending');
  assert.deepEqual(inbox.statusOf(dir, old).resolution, { type: 're-proposed', ref: next, at: NOW + 1000 });
  assert.equal(inbox.failedCards(dir).length, 0);
  // the same item cannot be resolved twice; an unknown id and a non-failed item are refused with a reason
  const twice = drop(dir, { ...PROMPT, prompt: 'Third', resolves: old });
  const unknown = drop(dir, { ...PROMPT, prompt: 'Fourth', resolves: 'f'.repeat(32) });
  const notFailed = drop(dir, { ...PROMPT, prompt: 'Fifth', resolves: next });
  inbox.scan(dir, NOW + 2000);
  for (const id of [twice, unknown, notFailed]) { assert.equal(inbox.statusOf(dir, id).state, 'refused'); assert.match(inbox.statusOf(dir, id).reason, /resolves must name one failed/); }
  // superseded, and a bad resolution word
  const old2 = drop(dir, { ...PROMPT, prompt: 'six' }); inbox.scan(dir, NOW + 3000);
  inbox.finish(dir, old2, { state: 'failed', cause: 'fault', reason: 'x' }, NOW + 3000);
  const sup = drop(dir, { ...PROMPT, prompt: 'seven', resolves: old2, resolution: 'superseded' }); inbox.scan(dir, NOW + 4000);
  assert.equal(inbox.statusOf(dir, old2).resolution.type, 'superseded'); assert.equal(inbox.statusOf(dir, old2).resolution.ref, sup);
  assert.match(inbox.validateItem({ ...PROMPT, resolves: old, resolution: 'done' }).reason, /resolution must be/);
  assert.match(inbox.validateItem({ ...PROMPT, resolves: 'nope' }).reason, /resolves must be/);
  assert.equal(inbox.validateItem({ kind: 'control', title: 't', action: 'park', target: '5', reason: 'r', resolves: old }).ok, false);
});

test('requirement 4: the MCP accepts resolves, and foreman_inbox_failures lists every failed item including resolved ones, uncut', async t => {
  assert.equal(checkProposal({ ...PROMPT, resolves: 'a'.repeat(8), resolution: 'superseded' }).ok, true);
  assert.match(checkProposal({ ...PROMPT, resolves: 'zz' }).error, /resolves must be/);
  assert.match(checkProposal({ ...PROMPT, resolves: 'a'.repeat(8), resolution: 'dropped' }).error, /resolution must be/);
  const dir = makeInbox(t), ids = [];
  for (let i = 0; i < 40; i++) { const id = drop(dir, { ...PROMPT, prompt: `job ${i}` }); ids.push(id); }
  inbox.scan(dir, NOW, { maxPending: 100 });
  ids.forEach((id, i) => inbox.finish(dir, id, { state: 'failed', title: `Title ${i}`, job: hex(4), cause: 'time_cap', evidence: 'x'.repeat(150), reason: 'r' }, NOW + i));
  inbox.finish(dir, ids[0], { resolution: { type: 'dropped', note: 'no longer wanted', at: NOW } }, NOW);
  const okId = drop(dir, PROMPT); inbox.scan(dir, NOW, { maxPending: 100 }); inbox.finish(dir, okId, { state: 'done' }, NOW);
  const tools = createToolset({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), inbox: createInbox({ dir }) });
  assert.ok(tools.has('foreman_inbox_failures'));
  const out = await tools.call('foreman_inbox_failures', {});
  assert.equal(out.isError, false);
  const body = JSON.parse(out.text);
  assert.equal(body.total, 40); assert.equal(body.unresolved, 39); assert.equal(body.rows.length, 40, 'nothing cut from the list'); assert.equal(body.omitted, undefined);
  const rows = body.rows.map(r => JSON.parse(r));
  assert.equal(rows[0].resolution, null); assert.equal(rows[39].resolution.type, 'dropped'); assert.equal(rows[39].resolution.note, 'no longer wanted');
  assert.deepEqual(Object.keys(rows[0]).sort(), ['cause', 'evidence', 'failedAt', 'jobId', 'kind', 'proposalId', 'resolution', 'shortId', 'state', 'title']);
  assert.ok(!rows.some(r => r.proposalId === okId), 'done items are not listed');
  // far past the answer bound: resolved rows go first and the answer says so, never a half-cut row
  for (let i = 0; i < 90; i++) { const id = drop(dir, { ...PROMPT, prompt: `more ${i}` }); inbox.scan(dir, NOW, { maxPending: 300 }); inbox.finish(dir, id, { state: 'failed', cause: 'fault', evidence: 'y'.repeat(150), reason: 'r' }, NOW + 100 + i); }
  const big = JSON.parse((await tools.call('foreman_inbox_failures', {})).text);
  assert.equal(big.total, 130); assert.ok(big.omitted > 0); assert.equal(big.rows.length + big.omitted, 130);
  assert.ok(big.rows.every(r => JSON.parse(r).resolution === null), 'unresolved rows are kept first');
});

test('acceptance: a failed item corrected to done is still listed, shown as done, so the overseer sees it was re-judged', async t => {
  const dir = makeInbox(t), a = drop(dir, PROMPT), b = drop(dir, { ...PROMPT, prompt: 'two' });
  inbox.scan(dir, NOW);
  inbox.finish(dir, a, { state: 'failed', kind: 'prompt', title: 'Verify issue 924 is installed', job: '867710c6', reason: 'the agent reported that it changed nothing', result: 'Agent summary: STATUS: nothing_changed\nVerified read-only.' }, NOW);
  inbox.finish(dir, b, { state: 'failed', job: 'd674cc94', reason: 'stopped after the 15-minute inbox time cap', result: 'stopped' }, NOW + 1);
  backfillFailures(inbox, dir, NOW + 2);
  const tools = createToolset({ source: { get: async () => ({ view: {}, ageMs: 0 }) }, readHost: () => ({}), inbox: createInbox({ dir }) });
  const body = JSON.parse((await tools.call('foreman_inbox_failures', {})).text);
  const rows = body.rows.map(r => JSON.parse(r));
  assert.equal(body.unresolved, 1);
  assert.equal(rows[0].jobId, 'd674cc94'); assert.equal(rows[0].state, 'failed'); assert.equal(rows[0].cause, 'time_cap');
  assert.equal(rows[1].jobId, '867710c6'); assert.equal(rows[1].state, 'done'); assert.match(rows[1].correctedFrom, /changed nothing/);
});

test('requirement 5: a setting an Inbox job changed and did not restore is a Needs you line naming the setting and the value now in force', t => {
  const dir = makeInbox(t), id = drop(dir, PROMPT); inbox.scan(dir, NOW);
  const before = { max_fix_attempts: 3, inbox_max_minutes: 15 };
  assert.deepEqual(changedLimits(before, { max_fix_attempts: 3, inbox_max_minutes: 15 }), []);
  const patch = endWith(t, { summary: 'STATUS: done\nraised it', extra: { limitsBefore: before } });   // no live limits given: nothing to compare
  assert.equal(patch.configChanges, null);
  const changes = changedLimits(before, { max_fix_attempts: 9, inbox_max_minutes: 15 });
  assert.deepEqual(changes, [{ key: 'max_fix_attempts', was: 3, now: 9 }]);
  inbox.finish(dir, id, { state: 'done', job: 'abc12345', configChanges: changes }, NOW);
  const lines = limits => inboxAttention(inbox, dir, limits);
  const found = lines({ max_fix_attempts: 9 });
  assert.equal(found.length, 1); assert.match(found[0].text, /max_fix_attempts is 9 \(was 3\)/);
  assert.equal(lines({ max_fix_attempts: 3 }).length, 0, 'restored: the line leaves');
  assert.equal(lines({ max_fix_attempts: 7 }).length, 1); assert.match(lines({ max_fix_attempts: 7 })[0].text, /is 7 \(was 3\)/, 'the value now in force');
  assert.equal(resolveByHomeowner(inbox, dir, id, { decision: 'keep_setting', note: 'on purpose' }, NOW).ok, true);
  assert.equal(lines({ max_fix_attempts: 9 }).length, 0, 'kept on purpose');
});

test('requirement 5: the end-of-job patch compares the snapshot taken at start with the live limits', t => {
  const patch = (extra, limits) => { const teamDir = tmp(t); fs.mkdirSync(path.join(teamDir, 'inbox', 'k'), { recursive: true }); fs.writeFileSync(path.join(teamDir, 'inbox', 'k', 'inbox-result.txt'), 'STATUS: done\nok'); return inboxEndPatch({ id: hex(16), j: { ticket: 'k', ...extra }, job: { status: 'completed' }, teamDir, capMs: 900000, limits }); };
  assert.deepEqual(patch({ limitsBefore: { a: 1 } }, { a: 2 }).configChanges, [{ key: 'a', was: 1, now: 2 }]);
  assert.equal(patch({ limitsBefore: { a: 1 } }, { a: 1 }).configChanges, null);
  assert.equal(patch({}, { a: 2 }).configChanges, null, 'a job started before the snapshot existed is not judged');
});

test('requirement 6: waiting between checks is measured from the transcript timestamps; most of the cap flags the job, and the prompt contract forbids waiting', t => {
  const root = tmp(t), id = hex(16);
  fs.mkdirSync(path.join(root, 'transcripts'));
  const line = (seq, at, tool, command, kind = 'tool_call') => JSON.stringify({ v: 1, seq, at: NOW + at * 1000, kind, tool, text: command.slice(0, 20), detail: JSON.stringify({ command }) });
  // The shape of job d674cc94: loops that sleep many times (counted once by a literal count), a Monitor call and a Codex 'shell' call.
  const waiting = [line(1, 0, 'Bash', 'until [ x ]; do sleep 20; done'), line(2, 300, 'Read', 'f'), line(3, 301, 'Monitor', 'while true; do jq; sleep 5; done'),
    line(4, 500, 'assistant', 'waiting', 'assistant'), line(5, 501, 'shell', 'while true; do sleep 30; done'), line(6, 601, 'Read', 'f')];
  fs.writeFileSync(path.join(root, 'transcripts', `${id}.jsonl`), waiting.join('\n') + '\n');
  assert.equal(waitedMs(waiting.map(l => JSON.parse(l))), 300000 + 199000 + 100000, 'loops, Monitor and shell calls count by wall time');
  assert.equal(waitedMs([JSON.parse(line(1, 0, 'Bash', 'grep while file')), JSON.parse(line(2, 900, 'Read', 'f'))]), 0, 'a command that only mentions the word is not waiting');
  const flagged = pollingOf({ root, jobId: id, capMs: 900000 });
  assert.deepEqual(flagged, { sleptMs: 599000, capMs: 900000 });
  assert.equal(pollingOf({ root, jobId: id, capMs: 3600000 }), null, 'a small share of a long cap is not flagged');
  const teamDir = tmp(t); fs.mkdirSync(path.join(teamDir, 'inbox', 'k'), { recursive: true });
  const patch = inboxEndPatch({ id, j: { ticket: 'k', capStopped: true }, job: { status: 'stopped' }, teamDir, capMs: 900000, root });
  assert.equal(patch.cause, 'time_cap'); assert.deepEqual(patch.polling, flagged); assert.match(patch.result, /must not wait on queue state/);
  assert.match(fs.readFileSync(new URL('../supervisor/inbox-report-contract.txt', import.meta.url), 'utf8'), /Do not wait on queue state/);
});

// The real dashboard handler over HTTP: the page shows the forms, a drop needs the proof and a reason, and the line leaves only then.
test('requirement 3: on the dashboard a failed item stays a year on, offers the forms, and only a proven drop with a reason releases it', async t => {
  const dir = makeInbox(t), a = drop(dir, PROMPT); inbox.scan(dir, NOW);
  inbox.finish(dir, a, { state: 'failed', job: 'abcdef12', cause: 'time_cap', evidence: 'stopped at the cap', reason: 'stopped at the cap' }, NOW);
  const root = tmp(t); for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
  fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: Date.now() - 60000, status: 'ok', lastOkAt: Date.now() - 60000 }, fetchedAt: Date.now() - 60000, pulls: [], issues: [{ number: 10, title: 'Ten', state: 'OPEN', labels: [] }] }));
  const server = http.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.close(r); server.closeAllConnections(); }));
  const port = server.address().port, clock = { now: NOW + 400 * 86400000 };
  const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir },
    limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 }, agents: { claude: { provider: 'claude', branch_prefix: 'claude/', issues: [10] } } };
  server.on('request', handler({ wake: () => {}, root, config, host: '127.0.0.1', port, now: () => clock.now }));
  const req = (method, p, body) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...(body ? { origin: `http://127.0.0.1:${port}`, 'content-type': 'application/x-www-form-urlencoded' } : {}) } }, res => { let b = ''; res.on('data', c => { b += c; }); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', reject); r.end(body);
  });
  const lines = async () => JSON.parse((await req('GET', '/api/view.json')).body).panels.needsYou.filter(x => x.id.startsWith('inboxfail-'));
  const found = await lines();
  assert.equal(found.length, 1); assert.match(found[0].text, /Cause: time cap\. stopped at the cap/);
  const page = (await req('GET', '/')).body;
  assert.match(page, /name="decision" value="drop"/); assert.match(page, /name="decision" value="done_elsewhere"/);
  const post = (decision, note, proof = writeToken(root)) => req('POST', '/inbox', new URLSearchParams({ id: a, decision, note, proof }).toString());
  assert.equal((await post('drop', 'x', 'f'.repeat(64))).status, 403, 'no proof, no drop');
  assert.equal((await post('drop', '')).status, 409, 'a reason is required');
  assert.equal((await lines()).length, 1);
  assert.equal((await post('drop', 'no longer wanted')).status, 303);
  assert.equal((await lines()).length, 0);
  assert.deepEqual({ type: inbox.statusOf(dir, a).resolution.type, note: inbox.statusOf(dir, a).resolution.note }, { type: 'dropped', note: 'no longer wanted' });
});

test('the end-of-job patch loads the approved prompt itself, so a read only verification is done through the real code path', t => {
  const dir = makeInbox(t), id = drop(dir, { kind: 'prompt', title: 'Verify issue 924 is installed', prompt: 'Look and report.' }); inbox.scan(dir, NOW);
  assert.equal(inbox.decide(dir, id, 'approve', NOW).ok, true);
  const teamDir = tmp(t); fs.mkdirSync(path.join(teamDir, 'inbox', 'k'), { recursive: true });
  fs.writeFileSync(path.join(teamDir, 'inbox', 'k', 'inbox-result.txt'), 'STATUS: nothing_changed\nVerified. Nothing was changed.');
  const patch = inboxEndPatch({ id: hex(16), j: { ticket: 'k', inboxId: id }, job: { status: 'completed' }, teamDir, capMs: 900000, inboxDir: dir });
  assert.equal(patch.state, 'done');
  inbox.finish(dir, id, patch, NOW + 5);
  assert.equal(inbox.statusOf(dir, id).state, 'done'); assert.equal(inbox.failedCards(dir).length, 0);
});
