// Issues #1178, #1221: the app bar agent items (state, role and allowance in one item). Pure item building from plain data, the markup, and the real page render.
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { allowanceItems, levelOf } from '../supervisor/appbaralloc.mjs';
import { agentBarItem, agentBarItems } from '../supervisor/appbaragent.mjs';
import { dur, lt, renderRoute, utc } from '../supervisor/dashrender.mjs';
import { currentView } from '../supervisor/dashserver.mjs';
import { sanitizeBar } from '../supervisor/dashui/appbar.mjs';

const NOW = Date.UTC(2026, 10, 12, 8, 0);
const H = 3600000;
const limits = { highWater: 0.85, exhaustedAt: 0.995 };
const lim = (kind, used, resetsAt, expired = false) => ({ kind, label: kind, used, resetsAt, expired });
const reading = (ls, extra = {}) => ({ limits: ls, stale: false, ageMinutes: 3, maxAgeMinutes: 60, observedAt: NOW - 180000, ...extra });
const view = (agents, budget) => ({ agents: agents.map(name => ({ name })), budget: Object.fromEntries(Object.entries(budget).map(([k, r]) => [k, { reading: r }])), budgetLimits: limits });
const h = { esc: v => String(v ?? '').replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`), lt, dur, utc };
const one = (r, name = 'a', agent = {}) => agentBarItems({ ...view([name], { [name]: r }), agents: [{ name, state: 'idle', ...agent }] })[0];
const allowanceStat = agentBarItem;
const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const summary = html => /<summary[\s\S]*?<\/summary>/.exec(html)[0];

test('one item per configured agent, including a third synthetic agent, with no agent names in the module', () => {
  const items = allowanceItems(view(['alpha', 'beta', 'zed-3'], {}));
  assert.deepEqual(items.map(i => i.agent), ['alpha', 'beta', 'zed-3']);
  assert.ok(items.every(i => i.weekly.state === 'unknown' && i.short.state === 'unknown'));
});

test('weekly only, short only and both', () => {
  const w = one(reading([lim('weekly_all', 0.15, NOW + 5 * H)]));
  assert.equal(w.weekly.used, 0.15); assert.equal(w.short.state, 'unknown'); assert.match(w.short.reason, /5 hour limit not reported/);
  const s = one(reading([lim('session_5h', 0.99, NOW + H)]));
  assert.equal(s.short.used, 0.99); assert.equal(s.short.level, 'high'); assert.match(s.weekly.reason, /weekly limit not reported/);
  const b = one(reading([lim('weekly_all', 0.15, NOW + 5 * H), lim('session_5h', 0.99, NOW + H)]));
  assert.deepEqual([b.weekly.level, b.short.level], ['normal', 'high'], '99% is below the 99.5% exhausted mark');
});

test('no reading and an unknown reading say why, never 0%', () => {
  const none = one(null);
  assert.equal(none.weekly.reason, 'no allowance reading yet');
  const html = allowanceStat(h, none);
  assert.doesNotMatch(html, /0%/);
  assert.match(html, /unknown: no allowance reading yet/);
  assert.doesNotMatch(allowanceStat(h, one(reading([]))), /read .* ago/, 'no figures, no age');
});

test('an expired window is unknown, not the old figure', () => {
  const i = one(reading([lim('weekly_all', 0.4, NOW - H, true), lim('session_5h', 0.99, NOW - 60000, true)]));
  assert.equal(i.weekly.state, 'unknown'); assert.equal(i.short.state, 'unknown');
  assert.match(i.short.reason, /window has reset/);
  const html = allowanceStat(h, i);
  assert.doesNotMatch(html, /99%|40%/);
});

test('a stale reading shows a small stale mark; the age and reason are in the tooltip and detail, not the bar', () => {
  const stale = allowanceStat(h, one(reading([lim('weekly_all', 0.2, NOW + H)], { stale: true, ageMinutes: 125 })));
  assert.match(summary(stale), /class="ai-stale" data-stale="true"/, 'a small stale mark in the bar'); assert.doesNotMatch(text(summary(stale)), /Stale|read 2h/, 'the words stay out of the bar');
  assert.match(stale, /Read 2h 5m ago/); assert.match(stale, /older than the 60 minute limit/, 'the stale reason is in the tooltip and the detail');
  assert.match(summary(stale), /title="[^"]*older than the 60 minute limit/);
  const fresh = allowanceStat(h, one(reading([lim('weekly_all', 0.2, NOW + H)])));
  assert.match(fresh, /data-stale="false"/); assert.doesNotMatch(fresh, /Stale:/); assert.match(fresh, /Read 3m ago/);
  const both = summary(allowanceStat(h, one(reading([lim('weekly_all', 0.2, NOW + H), lim('session_5h', 0.1, NOW + H)]))));
  assert.doesNotMatch(both, /ai-stale/, 'a fresh, complete reading has no stale mark');
  assert.match(summary(fresh), /class="ai-stale" data-stale="false"/, 'an unknown window still gets the mark, never a 0%');
  assert.match(allowanceStat(h, one(reading([lim('weekly_all', 0.2, NOW + H)], { ageMinutes: null }))), /Reading age unknown/);
});

test('markers change exactly at the scheduler thresholds, and are text as well as colour', () => {
  assert.equal(levelOf(0.8499, limits), 'normal'); assert.equal(levelOf(0.85, limits), 'high');
  assert.equal(levelOf(0.9949, limits), 'high'); assert.equal(levelOf(0.995, limits), 'near');
  assert.equal(levelOf(0.9, { highWater: 0.9, exhaustedAt: 0.99 }), 'high', 'configured thresholds are used');
  const html = allowanceStat(h, one(reading([lim('weekly_all', 0.86, NOW + H), lim('session_5h', 0.999, NOW + H)])));
  assert.match(html, /data-window="weekly" data-state="known" data-level="high"[^]*?▲/);
  assert.match(html, /data-window="short" data-state="known" data-level="near"[^]*?■/);
  assert.match(html, /data-window="weekly" data-state="known" data-level="high"><b>Week<\/b> 86% <span class="ai-lvl">High</);
  assert.match(html, /<span class="ai-lvl">Near limit</);
  assert.match(allowanceStat(h, one(reading([lim('weekly_all', 0.1, NOW + H)]))), /<span class="ai-lvl">OK</);
});

test('the item links to the Usage page, carries reset times and is an editable bar item', () => {
  const html = allowanceStat(h, one(reading([lim('weekly_all', 0.15, NOW + 5 * H), lim('session_5h', 0.99, NOW + H)]), 'codex'));
  assert.match(html, /<a href="\/usage">Usage page<\/a>/);
  assert.match(html, /data-bar="agent-codex" data-bar-name="Agent: codex"/);
  assert.equal((html.match(/<time class="lt" datetime="[^"]+" data-local>/g) || []).length, 2, 'both resets follow the dashboard time zone');
  assert.match(html, /15%/); assert.match(html, /99%/);
  assert.deepEqual(sanitizeBar({ v: 1, order: [], removed: ['agent-codex'] }, ['agent-codex', 'agent-x']).removed, ['agent-codex'], 'removable and restorable through the saved bar state');
});

test('agent names and reasons are escaped', () => {
  const html = allowanceStat(h, one(null, '<img src=x onerror=alert(1)>'));
  assert.doesNotMatch(html, /<img/);
});

test('the real dashboard view and page render put one item per configured agent in the bar', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'appbar-alloc-'));
  try {
    for (const d of ['jobs', 'dashboard', 'team']) fs.mkdirSync(path.join(root, d), { recursive: true });
    fs.writeFileSync(path.join(root, 'dashboard', 'cache.json'), JSON.stringify({ tick: { at: NOW - 60000, status: 'ok', lastOkAt: NOW - 60000 }, fetchedAt: NOW - 60000, pulls: [], issues: [] }));
    fs.writeFileSync(path.join(root, 'team', 'state.json'), JSON.stringify({ mergeLog: [] }));
    const config = { schema_version: 1, enabled: true, repository: 'o/r', repo_path: '/p/r', worktree_base: '/p', access: { mode: 'full', decision: 'D-020' }, inbox: { dir: path.join(root, 'inbox') },
      github_app: { app_id: 1, installation_id: 2, key_file: '/nowhere/key.pem' }, limits: { roles: { implementer: 1, reviewer: 1 }, overall: 2, max_review_attempts: 2, max_fix_attempts: 2 },
      agents: Object.fromEntries(['claude', 'codex'].map(n => [n, { provider: n, branch_prefix: `${n}/`, issues: [] }])), budget: { high_water: 0.9 } };
    const v = await currentView({ root, config, now: NOW, tz: 'UTC' });
    assert.deepEqual(v.budgetLimits, { highWater: 0.9, exhaustedAt: 0.995 }, 'the view carries the scheduler thresholds');
    const html = renderRoute(v, { page: 'usage' }, { query: new URLSearchParams(), pathname: '/usage' }).html;
    const bar = html.slice(html.indexOf('<header class="statusbar"'), html.indexOf('</header>'));
    assert.equal((bar.match(/class="stat agent-item"/g) || []).length, 2);
    assert.doesNotMatch(bar, /data-bar="agents"|allowance-item|agent-badge/, 'the two old items are gone from the default layout');
    for (const n of ['claude', 'codex']) assert.ok(bar.indexOf(`data-bar="agent-${n}"`) > 0 && bar.indexOf(`data-bar="agent-${n}"`) < bar.indexOf('id="barEdit"'), n);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const sumText = html => text(summary(html).replace(/ (title|aria-label)="[^"]*"/g, ''));

test('the bar prints name, state dot, role when running, weekly % and 5 hour % only (the real example data of 12 Nov)', () => {
  const claude = allowanceStat(h, one(reading([lim('weekly_all', 0.14, NOW + 7 * 24 * H), lim('session_5h', 0.01, NOW + 16 * H)]), 'claude'));
  assert.equal(sumText(claude), 'claude W 14% 5h 1%');
  assert.match(claude, /<span class="ai-dot" data-state="idle"/);
  const codex = allowanceStat(h, one(reading([lim('weekly_all', 0.31, NOW + H)]), 'codex', { state: 'paused', jobs: [{ role: 'implementer' }] }));
  assert.equal(sumText(codex), 'codex Implementer W 31% 5h unknown ◷', 'a paused agent keeps its job role; the unknown window is a word and a mark, never 0%');
  assert.match(codex, /<span class="ai-dot" data-state="paused"/);
  assert.doesNotMatch(sumText(claude) + sumText(codex), /OK|High|resets|read |ago|UTC/, 'wording, reset times and age are not printed in the bar');
});

test('running and paused show the role, several jobs show a count; held is an idle agent with a named hold; every state has its own dot', () => {
  const r = (agent) => allowanceStat(h, one(reading([lim('weekly_all', 0.1, NOW + H), lim('session_5h', 0.2, NOW + H)]), 'a', agent));
  assert.equal(sumText(r({ state: 'running', jobs: [{ role: 'implementer' }] })), 'a Implementer W 10% 5h 20%');
  assert.equal(sumText(r({ state: 'running', jobs: [{ role: 'reviewer' }] })), 'a Reviewer W 10% 5h 20%');
  assert.equal(sumText(r({ state: 'running', jobs: [{ role: 'reviewer' }, { role: 'rebaser' }] })), 'a 2 jobs W 10% 5h 20%');
  const held = r({ state: 'idle', idleReason: { text: 'held: an install is in progress' } });
  assert.match(held, /<span class="ai-dot" data-state="held"/); assert.match(held, /held: an install is in progress/);
  assert.match(r({ state: 'idle', idleReason: { text: 'nothing to do' } }), /data-state="idle"/);
  assert.match(r({ state: 'paused' }), /data-state="paused"/);
  assert.match(r({ state: 'mystery' }), /data-state="unknown"/, 'an unrecognised state is shown as unknown');
});

test('the tooltip holds the reset times and the reading age; the detail holds the wording', () => {
  const html = allowanceStat(h, one(reading([lim('weekly_all', 0.14, Date.UTC(2026, 10, 19, 4)), lim('session_5h', 0.01, Date.UTC(2026, 10, 13, 0, 40))], { ageMinutes: 14 }), 'claude'));
  const title = /<summary title="([^"]*)"/.exec(html)[1];
  assert.match(title, /Week: 14% OK, resets 2026-11-19 04:00 UTC/); assert.match(title, /5 hour: 1% OK, resets 2026-11-13 00:40 UTC/); assert.match(title, /Read 14m ago/);
  assert.match(html, /<div class="ai-detail">/);
});
