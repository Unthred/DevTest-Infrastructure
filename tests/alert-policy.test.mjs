// Issue #634: Foreman alerts only when the homeowner must act or a watched item finishes; rate limit, de-duplication, daily summary.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { rateLimited, alertNeedsYou, dailySummary, summarise, summaryText, causeOf, readPolicy } from '../supervisor/alertpolicy.mjs';
import { advanceWatchlist, applyAction, factsFromCache } from '../supervisor/watchlist.mjs';

const NOW = Date.UTC(2026, 10, 6, 9, 0, 0);
const tmp = t => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'alertpol-')); t.after(() => fs.rmSync(r, { recursive: true, force: true })); return r; };
const recorder = () => { const texts = []; return { texts, send: async x => { texts.push(x); } }; };
const card = (id, n, over = {}) => ({ id, ref: { kind: 'pr', n }, text: `item ${n}`, decision: 'Decide.', ...over });

test('causeOf groups ids the way foreman_needs_you does', () => {
  assert.equal(causeOf('homeowner-pr-538'), 'homeowner-pr');
  assert.equal(causeOf('job-0123456789abcdef'), 'job');
});

test('a group of Needs you items is one alert, not one per member; the same items never alert twice', async t => {
  const root = tmp(t), r = recorder(), items = [card('homeowner-pr-1', 1), card('homeowner-pr-2', 2), card('homeowner-pr-3', 3)];
  await alertNeedsYou({ root, items, send: r.send });
  assert.equal(r.texts.length, 1);
  assert.match(r.texts[0], /3 items \(homeowner-pr\)/);
  await alertNeedsYou({ root, items, send: r.send });
  assert.equal(r.texts.length, 1, 'same items and cause: nothing more is sent');
  await alertNeedsYou({ root, items: [...items, card('homeowner-pr-4', 4)], send: r.send });
  assert.equal(r.texts.length, 2, 'a new member of the group alerts once');
  await alertNeedsYou({ root, items: [], send: r.send });
  await alertNeedsYou({ root, items: [card('homeowner-pr-1', 1)], send: r.send });
  assert.equal(r.texts.length, 3, 'an item that left Needs you and came back may alert again');
});

test('nothing is sent when Needs you is empty (work Foreman handles itself)', async t => {
  const root = tmp(t), r = recorder();
  assert.deepEqual((await alertNeedsYou({ root, items: [], send: r.send })).sent, []);
  assert.equal(r.texts.length, 0);
});

test('a burst of events sends at most the limit, and the rest are delivered later, not lost', async t => {
  const root = tmp(t); let clock = NOW; const r = recorder();
  const send = rateLimited(root, r.send, { now: () => clock, limit: { max: 3, windowMs: 3600000 } });
  const items = Array.from({ length: 10 }, (_, i) => card(`cause${String.fromCharCode(97 + i)}-${i + 1}`, i + 1));
  await alertNeedsYou({ root, items, send });
  assert.equal(r.texts.length, 3);
  clock += 10 * 60000;
  await alertNeedsYou({ root, items, send });
  assert.equal(r.texts.length, 3, 'still inside the window');
  clock += 3600000;
  await alertNeedsYou({ root, items, send });
  assert.equal(r.texts.length, 6, 'the next window delivers the next three, none twice');
  assert.equal(new Set(r.texts).size, 6);
});

test('a failed delivery does not count against the limit and is retried', async t => {
  const root = tmp(t); let fail = true; const texts = [];
  const send = rateLimited(root, async x => { if (fail) throw new Error('down'); texts.push(x); }, { limit: { max: 1, windowMs: 3600000 } });
  await alertNeedsYou({ root, items: [card('homeowner-pr-1', 1)], send });
  assert.equal(readPolicy(root).sent.length, 0);
  fail = false;
  await alertNeedsYou({ root, items: [card('homeowner-pr-1', 1)], send });
  assert.equal(texts.length, 1);
});

test('the daily summary is correct for a fixture day, counts only that day, and is sent once', async t => {
  const root = tmp(t), r = recorder(), H = 3600000;
  const jobs = [
    { status: 'failed', updatedAt: NOW - 2 * H, usage: { costUsdEstimate: 1.234 } },
    { status: 'completed', updatedAt: NOW - 5 * H, usage: { costUsdEstimate: 2 } },
    { status: 'failed', updatedAt: NOW - 30 * H, usage: { costUsdEstimate: 50 } },        // yesterday: excluded
    { status: 'running', createdAt: NOW - H },                                              // no usage yet
  ];
  const mergeLog = [{ pr: 1, mergedAt: NOW - H }, { pr: 2, mergedAt: NOW - 3 * H }, { pr: 3, mergedAt: NOW - 40 * H }];
  const facts = { jobs, mergeLog, waiting: 4 };
  const s = summarise({ ...facts, now: NOW });
  assert.deepEqual(s, { merged: 2, failed: 1, cost: 3.23, waiting: 4 });
  assert.equal(summaryText(s), 'Foreman daily summary: 2 merged, 1 failed, cost $3.23 (usage equivalent), 4 waiting on you.');
  assert.equal((await dailySummary({ root, now: NOW, facts, send: r.send })).sent, true);
  assert.equal((await dailySummary({ root, now: NOW + H, facts, send: r.send })).sent, false, 'once per day');
  assert.equal(r.texts.length, 1);
  assert.equal((await dailySummary({ root, now: NOW + 24 * H, facts, send: r.send })).sent, true, 'next day');
});

test('the summary waits until its hour, and a refused send is retried', async t => {
  const root = tmp(t), r = recorder();
  assert.equal((await dailySummary({ root, now: Date.UTC(2026, 10, 6, 3), facts: {}, send: r.send })).sent, false);
  const refuse = rateLimited(root, r.send, { limit: { max: 0, windowMs: 1000 } });
  assert.equal((await dailySummary({ root, now: NOW, facts: {}, send: refuse })).sent, false);
  assert.equal((await dailySummary({ root, now: NOW, facts: {}, send: r.send })).sent, true);
});

test('a watched item reaching a final state sends exactly one alert; an unfinished one sends none', async t => {
  const root = tmp(t), r = recorder();
  applyAction(root, { kind: 'issue', number: 10, action: 'watch', now: NOW - 1000 });
  const step = (cache, state = {}) => advanceWatchlist({ root, now: NOW, alert: r.send, cache, state, factsFor: factsFromCache({ cache, state, now: NOW, checksOf: () => 'green' }) });
  await step({ pulls: [], merged: [], issues: [{ number: 10, state: 'OPEN', labels: [] }] });
  assert.equal(r.texts.length, 0, 'in progress: silent');
  await step({ pulls: [], merged: [], issues: [{ number: 10, state: 'CLOSED', labels: [] }] });
  await step({ pulls: [], merged: [], issues: [{ number: 10, state: 'CLOSED', labels: [] }] });
  assert.equal(r.texts.length, 1);
  assert.match(r.texts[0], /closed with no merged pull request/);
});

test('no secret-shaped output escapes an alert (fixtures built at run time)', async t => {
  const root = tmp(t), r = recorder();
  const token = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join(''), bearer = `Bearer ${['abcdefgh', 'ijklmnop', '1234'].join('')}`;
  const send = rateLimited(root, r.send);
  await alertNeedsYou({ root, items: [card('homeowner-pr-9', 9, { text: `leak ${token}`, decision: `use ${token} and ${bearer}` })], send });
  assert.equal(r.texts.length, 1);
  for (const bad of [token, bearer]) assert.ok(!r.texts[0].includes(bad), 'redacted');
  assert.ok(!fs.readFileSync(path.join(root, 'team', 'alert-policy.json'), 'utf8').includes(token), 'the state file holds no secret text');
});

test('policySender: Team and self-upgrade alerts send only actionable text, under the shared rate limit', async t => {
  const { policySender, classifyAlert } = await import('../supervisor/alertpolicy.mjs');
  const root = tmp(t), r = recorder(), send = policySender(root, r.send, { limit: { max: 2, windowMs: 3600000 } });
  const informational = ['Allowance: codex normal', 'Supervisor upgraded to abc1234 (PR #1).', 'Supervisor upgrade to abc1234: tests failed once (flaky: x). The install went ahead.', 'Supervisor self-upgrade skipped: installed a is not an ancestor of main b.', 'Supervisor upgrade to abc1234 not done: pre-check failed (x).'];
  const covered = ['Needs the homeowner: PR #5 is still rejected after 3 fix rounds', 'Supervisor upgrade to abc: needs the homeowner: changes the bootstrap installer'];
  for (const x of [...informational, ...covered]) { assert.notEqual(classifyAlert(x), 'actionable', x); await send(x); }
  assert.equal(r.texts.length, 0, 'work Foreman handles itself, and items already in Needs you, send nothing here');
  for (const x of ['Upgrade to abc rolled back: x.', 'Dashboard server was not answering: y', 'Dashboard server was not restarted: z']) { assert.equal(classifyAlert(x), 'actionable'); }
  await send('Upgrade to abc rolled back: x.'); await send('Dashboard server was not answering: y');
  await assert.rejects(send('Dashboard server was not restarted: z'), /rate limit/);
  assert.equal(r.texts.length, 2);
});

test('the tick builds Needs you with the main decision register, so it matches the dashboard', async () => {
  const { pendingProposals } = await import('../supervisor/dashboard.mjs');
  const e = (id, st) => `## ${id} — title ${id}\n- Status: ${st}\n- Date: 2026-11-02\n- Source: issue #1\n- Decision: Something. More.\n\n`, main = e('D-001', 'homeowner-approved') + e('D-002', 'agent-proposal');
  const pulls = [{ number: 311, isDraft: false }];
  assert.deepEqual(pendingProposals({}, pulls, main, () => main), [], 'a PR that adds nothing proposes nothing');
  assert.ok(pendingProposals({}, pulls, '', () => main).length > 0, 'the empty register is the bug');
  const cli = fs.readFileSync(new URL('../supervisor/cli.mjs', import.meta.url), 'utf8');
  assert.match(cli, /buildView\(\{[^}]*register, registerUnreadable: !register \}\)/, 'the tick passes the register');
});
