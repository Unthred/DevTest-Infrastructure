// Issue #947: alert levels, once-per-cause, push configuration, digest and history.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SelfUpgrade, PROBLEM_REPORT_GAP_MS } from '../supervisor/upgrade.mjs';
import { alertSender, needsLink, readAlerts, sendDigest, validateAlertsConfig, UNRAID_NOTIFY } from '../supervisor/alert.mjs';

const H = 3600000;
function rig(t, config = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-levels-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = []; let clock = 1_700_000_000_000, status = 0;
  const run = (p, a, o) => (calls.push({ p, a, input: o?.input }), { status });
  const opts = { notify: process.execPath, run, now: () => clock };
  return { root, calls, send: alertSender(root, config, opts), digest: () => sendDigest(root, config, opts), advance: ms => { clock += ms; }, fail: v => { status = v ? 1 : 0; } };
}
const subjectOf = c => c.a[c.a.indexOf('-s') + 1];

test('an alert without a level, or with an unknown one, is refused and sends nothing (issue #947)', async t => {
  const r = rig(t);
  await assert.rejects(r.send('x'), /without a valid level/);
  await assert.rejects(r.send('x', {}), /without a valid level/);
  await assert.rejects(r.send('x', { level: 'urgent' }), /without a valid level/);
  assert.equal(r.calls.length, 0);
});

test('every alert call in the source names a level (issue #947)', () => {
  const dir = path.resolve('supervisor'); const found = [];
  for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.mjs') && x !== 'alert.mjs')) {
    fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line) || /async alert\(/.test(line)) return;
      for (const m of line.matchAll(/(?:this\.alert|\bawait alert|\bd\.alert|\bsendAlert)\(/g)) {
        const rest = line.slice(m.index);
        found.push({ at: `${f}:${i + 1}`, ok: /\{ level: '(action|problem|info)'|\{ level, key[,\s}]/.test(rest) || (/this\.alert\(/.test(rest) && /, '(action|problem|info)'[,)]/.test(rest)) });
      }
    });
  }
  assert.ok(found.length >= 15, `expected to find the alert calls, found ${found.length}`);
  assert.deepEqual(found.filter(x => !x.ok).map(x => x.at), []);
});

test('levels choose the subject and icon; info is never pushed by default (issue #947)', async t => {
  const r = rig(t);
  await r.send('Fix limit reached', { level: 'action', key: 'a' });
  assert.equal(subjectOf(r.calls[0]), 'Tower | Foreman needs you'); assert.equal(r.calls[0].a.at(-1), 'warning');
  await r.send('Supervisor upgraded', { level: 'info', key: 'u' });
  await r.send('Upgrade skipped, retrying', { level: 'problem', key: 'p' });
  assert.equal(r.calls.length, 1);
  const h = readAlerts(r.root);
  assert.deepEqual(h.map(x => [x.level, x.pushed]), [['problem', false], ['info', false], ['action', true]]);
});

test('the same cause is sent once while it lasts and repeats only count; a quiet day makes it new (issue #947)', async t => {
  const r = rig(t);
  for (let i = 0; i < 4; i++) { await r.send('Needs the homeowner: PR 5 is rejected', { level: 'action', key: 'fixlimit:5' }); r.advance(2 * H); }
  assert.equal(r.calls.length, 1);
  assert.deepEqual(readAlerts(r.root).map(x => x.count), [4, 3, 2, 1]);
  r.advance(25 * H);
  await r.send('Needs the homeowner: PR 5 is rejected', { level: 'action', key: 'fixlimit:5' });
  assert.equal(r.calls.length, 2);
  await r.send('Another cause', { level: 'action', key: 'fixlimit:6' });
  assert.equal(r.calls.length, 3);
});

test('a failed delivery is not recorded as sent and is retried (issue #947)', async t => {
  const r = rig(t); r.fail(true);
  await assert.rejects(r.send('x', { level: 'action', key: 'k' }), /failed/);
  r.fail(false); await r.send('x', { level: 'action', key: 'k' });
  assert.equal(r.calls.length, 2);
});

test('a problem is pushed only after it has lasted, and only when configured (issue #947)', async t => {
  const off = rig(t); off.advance(0);
  for (let i = 0; i < 3; i++) { await off.send('retrying', { level: 'problem', key: 'p' }); off.advance(5 * H); }
  assert.equal(off.calls.length, 0, 'default pushes action only');
  const on = rig(t, { alerts: { push_levels: ['action', 'problem'], problem_after_minutes: 60 } });
  await on.send('retrying', { level: 'problem', key: 'p' }); assert.equal(on.calls.length, 0, 'first sight is not pushed');
  on.advance(30 * 60000); await on.send('retrying', { level: 'problem', key: 'p' }); assert.equal(on.calls.length, 0);
  on.advance(31 * 60000); await on.send('retrying', { level: 'problem', key: 'p' }); assert.equal(on.calls.length, 1);
  assert.equal(subjectOf(on.calls[0]), 'Tower | Foreman problem');
  on.advance(H); await on.send('retrying', { level: 'problem', key: 'p' }); assert.equal(on.calls.length, 1, 'then once');
});

test('the action link is sent with the alert (issue #947)', async t => {
  const r = rig(t);
  await r.send('stopped', { level: 'action', key: 'a', link: 'https://example.invalid/issues/9' });
  assert.match(r.calls[0].a[r.calls[0].a.indexOf('-d') + 1], /https:\/\/example\.invalid\/issues\/9/);
  assert.equal(readAlerts(r.root)[0].link, 'https://example.invalid/issues/9');
});

test('the daily digest lists unpushed alerts with counts, once a day, and retries on failure (issue #947)', async t => {
  const r = rig(t);
  assert.deepEqual(await r.digest(), []);   // first call only starts the clock
  for (let i = 0; i < 3; i++) await r.send('Allowance: claude normal', { level: 'info', key: 'allow' });
  await r.send('Supervisor upgraded to abc', { level: 'info', key: 'up' });
  await r.send('Pushed action', { level: 'action', key: 'a' });
  assert.equal(await r.digest(), null, 'not due yet');
  r.advance(25 * H); const before = r.calls.length;
  r.fail(true); await assert.rejects(r.digest(), /digest not delivered/);
  r.fail(false); const lines = await r.digest();
  assert.equal(lines.length, 2); assert.ok(lines.some(l => /Allowance.*\(x3\)/.test(l))); assert.ok(!lines.some(l => /Pushed action/.test(l)));
  assert.equal(subjectOf(r.calls.at(-1)), 'Tower | Foreman digest'); assert.equal(r.calls.length, before + 2);
  r.advance(H); assert.equal(await r.digest(), null);
  r.advance(25 * H); assert.deepEqual(await r.digest(), [], 'nothing new means no message');
  assert.equal(r.calls.length, before + 2);
});

test('history filters by level and treats pre-level records as action (issue #947)', t => {
  const r = rig(t); fs.mkdirSync(path.join(r.root, 'team'), { recursive: true });
  fs.writeFileSync(path.join(r.root, 'team', 'alerts.jsonl'), [JSON.stringify({ at: 1, text: 'old', delivered: true }), JSON.stringify({ at: 2, level: 'info', text: 'i' }), 'not json'].join('\n') + '\n');
  assert.deepEqual(readAlerts(r.root, { levels: ['action'] }).map(x => x.text), ['old']);
  assert.deepEqual(readAlerts(r.root, { levels: ['info'] }).map(x => x.text), ['i']);
  assert.equal(readAlerts(r.root).length, 2);
});

test('alerts configuration accepts only the known keys and values (issue #947)', () => {
  assert.deepEqual(validateAlertsConfig({ push_levels: ['action', 'problem'], problem_after_minutes: 30 }), { push_levels: ['action', 'problem'], problem_after_minutes: 30 });
  for (const bad of [{ push_levels: ['loud'] }, { push_levels: 'action' }, { push_levels: ['action', 'action'] }, { problem_after_minutes: -1 }, { problem_after_minutes: 1.5 }, { problem_after_minutes: 99999 }, { extra: 1 }, [], null])
    assert.throws(() => validateAlertsConfig(bad), /alerts/);
});

test('the dashboard serves the alert history with level filters, redacted and escaped (issue #947)', async t => {
  const http = await import('node:http'), { handler } = await import('../supervisor/dashserver.mjs');
  const r = rig(t);
  await r.send('Fix limit <b>reached</b>', { level: 'action', key: 'a' });
  await r.send('Supervisor upgraded to abc1234', { level: 'info', key: 'u' });
  await r.send('retrying', { level: 'problem', key: 'p' });
  const server = http.createServer(); await new Promise(res => server.listen(0, '127.0.0.1', res)); t.after(() => server.closeAllConnections?.() || server.close());
  const port = server.address().port;
  server.on('request', handler({ root: r.root, config: { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/nonexistent/repo', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, limits: {}, agents: {}, depends_on_overrides: {} }, host: '127.0.0.1', port }));
  const get = p => new Promise((res, rej) => { http.get({ host: '127.0.0.1', port, path: p, headers: { host: `127.0.0.1:${port}` } }, q => { let b = ''; q.on('data', d => (b += d)); q.on('end', () => res({ status: q.statusCode, body: b })); }).on('error', rej); });
  const all = await get('/api/alerts.json'); assert.equal(all.status, 200);
  assert.deepEqual(JSON.parse(all.body).alerts.map(x => x.level), ['problem', 'info', 'action']);
  assert.deepEqual(JSON.parse((await get('/api/alerts.json?level=info')).body).alerts.map(x => x.level), ['info']);
  assert.deepEqual(JSON.parse((await get('/api/alerts.json?level=action,problem')).body).alerts.map(x => x.level), ['problem', 'action']);
  assert.equal(JSON.parse((await get('/api/alerts.json?level=bogus')).body).alerts.length, 3, 'an unknown level filters nothing');
  const page = await get('/alerts?level=action');
  assert.equal(page.status, 200); assert.match(page.body, /data-level="action"/); assert.doesNotMatch(page.body, /data-level="info"/);
  assert.doesNotMatch(page.body, /<b>reached/); assert.match(page.body, /&lt;b&gt;|&#60;b&#62;/);
});
void UNRAID_NOTIFY;

// ---- fix round for the CHANGES verdict on PR #1010
test('needsLink names the issue or repository and the dashboard when configured (issue #947)', () => {
  assert.equal(needsLink({ repository: 'o/r' }), 'https://github.com/o/r');
  assert.equal(needsLink({ repository: 'o/r', self_upgrade: { public_dashboard_url: 'https://d.example/' } }, 5), 'https://github.com/o/r/issues/5 https://d.example/');
});

test('the self-upgrade action alerts carry a link, and a lasting problem is re-reported so it can be pushed after problem_after_minutes (issue #947)', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alert-up-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const got = []; let now = 1_700_000_000_000;
  const up = new SelfUpgrade({ root, deps: { config: { agents: {} }, needsLink: () => 'https://dash.example/', alert: async (text, o) => got.push(o) }, clock: { now: () => now } });
  await up.alert('t:upgrader', 'x', 'action', up.d.needsLink());
  await up.alert('t:upgrader', 'x', 'action', up.d.needsLink());
  assert.deepEqual(got, [{ level: 'action', key: 't:upgrader', link: 'https://dash.example/' }], 'an action alert is reported once and with its link');
  got.length = 0;
  await up.alert('t:eligibility', 'p', 'problem'); await up.alert('t:eligibility', 'p', 'problem');
  assert.equal(got.length, 1, 'too soon for another report');
  now += PROBLEM_REPORT_GAP_MS; await up.alert('t:eligibility', 'p', 'problem');
  assert.equal(got.length, 2, 'the lasting problem is reported again');
  await up.alert('t:info', 'i', 'info'); now += 10 * PROBLEM_REPORT_GAP_MS; await up.alert('t:info', 'i', 'info');
  assert.equal(got.filter(g => g.level === 'info').length, 1, 'info is still reported once');
});

test('a problem reported repeatedly by the upgrader is pushed once it has lasted, end to end through the sender (issue #947)', async t => {
  const r = rig(t, { alerts: { push_levels: ['action', 'problem'], problem_after_minutes: 120 } });
  await r.send('p', { level: 'problem', key: 'k' });
  for (let i = 0; i < 13; i++) { r.advance(H); await r.send('p', { level: 'problem', key: 'k' }); }
  assert.equal(r.calls.length, 1, 'pushed once, after two hours');
});

test('the rebase-lost and review-limit action alerts exist and carry a link (issue #947)', () => {
  const src = fs.readFileSync(path.resolve('supervisor/team.mjs'), 'utf8');
  for (const k of ['rebase-lost:', 'rebase-lost-changes:', 'reviewlimit:']) assert.ok(src.includes(k), k);
  assert.match(src, /alertRebaseLost\(pr, key[\s\S]*?level: 'action', key, link: this\.needsLink\(pr\)/);
  assert.match(src, /level: 'action', key: `reviewlimit:[^\n]*link: this\.needsLink/);
});
