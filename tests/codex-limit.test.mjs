// First real exhausted-state capture (Codex CLI 0.165.0, interactive). The reset-time parser is verified ONLY for the two
// message shapes in the fixture; the exec --json wrapper, session resume and the manifests stay unverified.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { nextDatedOccurrence, nextLocalOccurrence, parseStatusWindow, parseTryAgain, zonedToUtc } from '../supervisor/clocktext.mjs';
import { createJob, drive, stateRoot } from '../supervisor/core.mjs';
import { runProcess } from '../supervisor/process.mjs';
import * as codex from '../supervisor/adapters/codex.mjs';

const raw = fs.readFileSync(new URL('./fixtures/allowance/codex-0.165.0-interactive-usage-limit.txt', import.meta.url), 'utf8');
const LIMIT = raw.split('\n').find(l => l.includes("You've hit your usage limit"));
const FIVE = raw.split('\n').find(l => l.startsWith('5h limit'));
const WEEK = raw.split('\n').find(l => l.startsWith('Weekly limit'));
const LON = 'Europe/London';
const at = iso => Date.parse(iso);

test('fixture lines are the captured ones', () => {
  assert.ok(LIMIT.includes('purchase more credits') && LIMIT.includes('try again at 11:44 AM.'));
  assert.ok(FIVE.includes('0% left (resets 11:44 AM)') && WEEK.includes('51% left (resets 7:18 AM on 4 Nov)'));
});

test('"try again at H:MM AM|PM" is read in the host zone and rolls to the next day when already past', () => {
  assert.equal(parseTryAgain(LIMIT, at('2026-10-30T09:25:00Z'), LON), at('2026-10-30T11:44:00Z'));
  assert.equal(parseTryAgain(LIMIT, at('2026-10-30T12:00:00Z'), LON), at('2026-10-31T11:44:00Z'));       // passed today: tomorrow
  assert.equal(parseTryAgain(LIMIT, at('2026-10-30T11:44:00Z'), LON), at('2026-10-31T11:44:00Z'));       // exactly now: not "now"
  // BST: the same wall-clock text is one hour earlier in UTC
  assert.equal(parseTryAgain(LIMIT, at('2026-07-15T08:00:00Z'), LON), at('2026-07-15T10:44:00Z'));
  // across the end of BST (25 Oct 2026, 02:00 -> 01:00): 11:44 BST today is 10:44Z (passed); tomorrow 11:44 GMT is 11:44Z
  assert.equal(parseTryAgain(LIMIT, at('2026-10-24T12:00:00Z'), LON), at('2026-10-25T11:44:00Z'));
  assert.equal(parseTryAgain(LIMIT, at('2026-10-24T08:00:00Z'), LON), at('2026-10-24T10:44:00Z'));
  // and across the start of BST (29 Mar 2026, 01:00 -> 02:00)
  assert.equal(parseTryAgain(LIMIT, at('2026-03-28T12:00:00Z'), LON), at('2026-03-29T10:44:00Z'));
  // the zone is a real input
  assert.equal(parseTryAgain(LIMIT, at('2026-10-30T09:25:00Z'), 'America/New_York'), at('2026-10-30T15:44:00Z'));
});

test('12-hour edge cases and malformed times', () => {
  const now = at('2026-10-30T01:00:00Z');
  assert.equal(parseTryAgain('try again at 12:05 AM', now, LON), at('2026-10-31T00:05:00Z'));
  assert.equal(parseTryAgain('try again at 12:05 PM', now, LON), at('2026-10-30T12:05:00Z'));
  assert.equal(parseTryAgain('try again at 1:30 pm', now, LON), at('2026-10-30T13:30:00Z'));
  for (const bad of ['try again at 13:00 PM', 'try again at 0:30 AM', 'try again at 11:75 AM', 'try again at 11:44', 'try again later', '']) assert.equal(parseTryAgain(bad, now, LON), null, bad);
});

test('/status windows: percent left and dated resets; a past dated reset rolls to next year', () => {
  const now = at('2026-10-30T09:25:00Z');
  assert.deepEqual(parseStatusWindow(FIVE, now, LON), { percentLeft: 0, resetsAt: at('2026-10-30T11:44:00Z') });
  assert.deepEqual(parseStatusWindow(WEEK, now, LON), { percentLeft: 51, resetsAt: at('2026-11-04T07:18:00Z') });
  assert.equal(parseStatusWindow('0% left (resets 7:18 AM on 4 Nov)', at('2026-12-01T00:00:00Z'), LON).resetsAt, at('2027-11-04T07:18:00Z'));
  assert.equal(parseStatusWindow('0% left (resets 7:18 AM on 31 Feb)', now, LON), null);
  assert.equal(parseStatusWindow('0% left (resets 7:18 AM on 4 Smarch)', now, LON), null);
  assert.equal(parseStatusWindow('Permissions: Full Access', now, LON), null);
  assert.equal(zonedToUtc({ y: 2026, m: 11, d: 4, h: 7, mi: 18 }, LON), at('2026-11-04T07:18:00Z'));
  assert.equal(nextLocalOccurrence(11, 44, at('2026-10-30T09:25:00Z'), LON), at('2026-10-30T11:44:00Z'));
  assert.ok(nextDatedOccurrence(7, 18, 4, 10, at('2026-10-30T09:25:00Z'), LON) > at('2026-10-30T09:25:00Z'));
});

test('the real limit line is a plain usage_limit: reset parsed and verified for this shape, "purchase more credits" implies no billing action', () => {
  const r = codex.observe(LIMIT, at('2026-10-30T09:25:00Z'));
  assert.equal(r.event, 'usage_limit'); assert.equal(r.resetAt, at('2026-10-30T11:44:00Z')); assert.equal(r.resetSource, 'provider_reported'); assert.equal(r.verified, true);
  assert.notEqual(r.event, 'approval_required'); assert.equal(r.billing, undefined);
  // a quoted exec --json wrapper is SIMULATED (not captured); it uses the same text
  const wrapped = codex.observe(JSON.stringify({ type: 'error', message: LIMIT.replace('■ ', '') }), at('2026-10-30T09:25:00Z'));
  assert.equal(wrapped.event, 'usage_limit'); assert.equal(wrapped.resetAt, at('2026-10-30T11:44:00Z'));
  // the explicit reset-limits upsell and model switching remain approval_required
  assert.equal(codex.observe('Reset your current usage limits to continue', 0).event, 'approval_required');
  // an unparsable reset is unreported, never invented, and not verified
  const none = codex.observe("You've hit your usage limit. Try again sometime.", at('2026-10-30T09:25:00Z'));
  assert.equal(none.event, 'usage_limit'); assert.ok(!none.resetAt); assert.equal(none.verified, false);
});

test('/status lines: only an exhausted window is a limit', () => {
  const now = at('2026-10-30T09:25:00Z');
  assert.equal(codex.observe(FIVE, now).event, 'usage_limit'); assert.equal(codex.observe(FIVE, now).resetAt, at('2026-10-30T11:44:00Z'));
  assert.equal(codex.observe(WEEK, now).event, undefined);
  assert.equal(codex.observe('Permissions:  Full Access', now).event, undefined);
});

const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8' }).trim();
function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codexlimit-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, 'repo'), wt = path.join(dir, 'wt'); fs.mkdirSync(repo); git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'a@b.invalid'); git(repo, 'config', 'user.name', 't'); fs.writeFileSync(path.join(repo, 'r'), 'x'); git(repo, 'add', 'r'); git(repo, 'commit', '-qm', 'i'); git(repo, 'worktree', 'add', '-qb', 'i', wt);
  const m = { schema_version: 1, id: 'codex', display_name: 'c', adapter_version: '0.1.0', launch: { command: 'x', args: [] }, capabilities: Object.fromEntries(['launch', 'resume', 'session_status', 'usage_limit_detection', 'reset_time_parsing', 'checkpoint', 'non_interactive'].map(k => [k, 'supported'])), billing: { model: 'subscription', fallback_to_other_billing: false } };
  // A test manifest with every capability supported isolates the drive/wait behaviour; the production manifests are checked separately.
  fs.writeFileSync(path.join(dir, 'codex.json'), JSON.stringify(m)); const registry = path.join(dir, 'reg.json'); fs.writeFileSync(registry, JSON.stringify({ schemaVersion: 1, providers: { codex: { adapter: 'codex', manifest: 'codex.json' } } }));
  return { dir, registry, root: stateRoot(path.join(dir, 's')), spec: { role: 'devtest', provider: 'codex', repository: repo, worktree: wt, issue: 20, scope: 's', allowed_actions: ['read'], prompt: 'p', autoResume: true } };
}
const NOW = at('2026-10-30T09:25:00Z');
function fakeClock() { let now = NOW; const sleeps = []; return { now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }, sleeps }; }
const agent = (w, lines, code) => { const s = path.join(w.dir, 'a.mjs'); fs.writeFileSync(s, `${lines.map(l => `console.log(${JSON.stringify(l)});`).join('\n')}\nprocess.exit(${code});`); return s; };
const runner = (w, script, clock) => async (c, ad, j, cl) => runProcess(w.root, j, { manifest: { launch: { env_allowlist: ['PATH'] } } }, { command: () => [process.execPath, script], observe: codex.observe, preflight: () => true }, cl);

test('end to end on a fake clock: restart waits for the reported reset + 2 minutes, then runs fresh; nothing is called while waiting', async t => {
  const w = world(t), clock = fakeClock(), job = await createJob(w.root, w.spec, w.registry, clock);
  const script = path.join(w.dir, 'a.mjs'); const marker = path.join(w.dir, 'runs');
  fs.writeFileSync(script, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(marker)}, 'x');
if (fs.readFileSync(${JSON.stringify(marker)}, 'utf8').length === 1) { console.log(${JSON.stringify(LIMIT)}); process.exit(1); } console.log('done');`);
  let runsAtSleep = null; const orig = clock.sleep; clock.sleep = async ms => { runsAtSleep = fs.readFileSync(marker, 'utf8').length; await orig(ms); };
  const r = await drive(w.root, job, w.registry, clock, runner(w, script, clock));
  assert.equal(r.status, 'completed'); assert.equal(r.attempts, 2); assert.equal(runsAtSleep, 1, 'no launch while waiting');
  assert.deepEqual(clock.sleeps, [at('2026-10-30T11:44:00Z') + 120000 - NOW]);
});

test('two exhausted windows: the later reset wins in either order; a non-exhausted window is ignored', async t => {
  const cases = [
    [[FIVE, '0% left (resets 7:18 AM on 4 Nov)'], at('2026-11-04T07:18:00Z')],
    [['0% left (resets 7:18 AM on 4 Nov)', FIVE], at('2026-11-04T07:18:00Z')],
    [[LIMIT, FIVE, WEEK], at('2026-10-30T11:44:00Z')]        // weekly has 51% left: not exhausted
  ];
  for (const [lines, expected] of cases) {
    const w = world(t), clock = fakeClock(), job = await createJob(w.root, { ...w.spec, autoResume: false }, w.registry, clock);
    const r = await drive(w.root, job, w.registry, clock, runner(w, agent(w, lines, 1), clock));
    assert.equal(r.status, 'blocked'); assert.equal(r.lastEvent, 'usage_limit');
    assert.equal(r.resetAt, null);                                         // not restartable: nothing scheduled
    const restartable = world(t), c2 = fakeClock(), j2 = await createJob(restartable.root, restartable.spec, restartable.registry, c2);
    let n = 0, resetSeen = null;
    await drive(restartable.root, j2, restartable.registry, c2, async (cfg, ad, j, cl) => { n++; if (n === 1) { const res = await runner(restartable, agent(restartable, lines, 1), c2)(cfg, ad, j, cl); resetSeen = res.resetAt; return res; } return { code: 0 }; });
    assert.equal(resetSeen, expected, JSON.stringify(lines));
    assert.equal(j2.nextAttemptAt, expected + 120000);
  }
});

test('the manifests stay unverified and auto-resume stays refused: this is one captured message shape only', async t => {
  const m = JSON.parse(fs.readFileSync(new URL('../supervisor/providers/codex.json', import.meta.url), 'utf8'));
  for (const k of ['resume', 'session_status', 'usage_limit_detection', 'reset_time_parsing']) assert.equal(m.capabilities[k], 'unverified', k);
  const w = world(t); const registry = new URL('../supervisor/providers.json', import.meta.url).pathname;
  await assert.rejects(createJob(w.root, { ...w.spec, autoResume: true }, registry), /auto-resume requires verified/);
});
