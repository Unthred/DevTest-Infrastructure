// Issue #1162: the advice on limit resets is a pure decision. Every case builds plain inputs and reads the verdict and the figures behind it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { adviseAgent, spacingText } from '../supervisor/resetadvice.mjs';
import { RESET_DEFAULTS } from '../supervisor/resetsettings.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const settings = { ...RESET_DEFAULTS, exhausted_at: 0.995 };
const CAPACITY = 10e6;
const PACE = 100e3;   // tokens an hour at full pace

const weekly = { id: 'aaaa0001', agent: 'claude', limit: 'weekly', scope: 'all', expiry: NOW + 120 * DAY, state: 'available' };
const fable = { id: 'aaaa0002', agent: 'claude', limit: 'weekly', scope: 'fable', expiry: Date.UTC(2027, 2, 8, 23, 59, 59), state: 'available' };
const fiveHour = { id: 'aaaa0003', agent: 'claude', limit: 'five_hour', scope: 'all', expiry: NOW + 120 * DAY, state: 'available' };

const view = (over = {}) => ({ mode: 'reviews_only', used: 0.97, resetsAt: NOW + 4 * DAY, hoursLeft: 96, shortWindow: null, held: { implement: 'reviews only' },
  capacity: { capacity: CAPACITY, belowReserve: true }, ...over });
const advise = (records, v = view(), extra = {}) => adviseAgent({ records, name: 'claude', view: v, models: ['sonnet', 'opus'], pace: PACE, settings, now: NOW, ...extra });
const one = (record, v, extra) => advise([record], v, extra)[0];

test('weekly reset: held by allowance with work queued and 4 days left gives use now, with the figures', () => {
  const a = one(weekly);
  assert.equal(a.verdict, 'use_now');
  assert.equal(a.figures.restoreTokens, 9.7e6);
  assert.equal(a.figures.spendableTokens, 9.6e6);
  assert.ok(a.figures.usableShare > 0.98);
  assert.equal(a.figures.hoursLeft, 96);
});

test('weekly reset: 19 hours left gives hold, with a usable share near the real figure and what would make it worthwhile', () => {
  const a = one(weekly, view({ resetsAt: NOW + 19 * HOUR }));
  assert.equal(a.verdict, 'hold');
  assert.ok(Math.abs(a.figures.usableShare - 1.9e6 / 9.7e6) < 0.001, `share ${a.figures.usableShare}`);
  assert.match(a.why, /worth it when held with about 2\.4 days to go/);
});

test('weekly reset: an agent that is not held by allowance gets hold, and one with no queued work gets hold', () => {
  const free = one(weekly, view({ mode: 'normal', capacity: { capacity: CAPACITY, belowReserve: false }, held: {} }));
  assert.equal(free.verdict, 'hold');
  assert.match(free.why, /not held by its allowance/);
  const idle = one(weekly, view({ held: {} }));
  assert.equal(idle.verdict, 'hold');
  assert.match(idle.why, /no queued work/);
});

test('weekly reset: below the configured usable share is a hold, and the share is the threshold the setting names', () => {
  const v = view({ resetsAt: NOW + 50 * HOUR });   // 5M of 9.7M = 51 %
  assert.equal(one(weekly, v).verdict, 'hold');
  assert.equal(one(weekly, v, { settings: { ...settings, usable_share: 0.5 } }).verdict, 'use_now');
});

test('weekly reset: unknown capacity or pace is never guessed', () => {
  assert.match(one(weekly, view({ capacity: { capacity: null, belowReserve: null } })).why, /capacity is not learned/);
  assert.match(one(weekly, view(), { pace: null }).why, /no job history/);
});

test('model scoped reset: no model in that scope in the config means it does not help Foreman', () => {
  const a = one(fable);
  assert.equal(a.verdict, 'lost_cause');
  assert.match(a.why, /does not help Foreman: no fable model is in claude's model config/);
});

test('model scoped reset: a worker in that scope is judged against the window the provider reports for it, else it cannot be measured', () => {
  const models = ['sonnet', 'claude-fable-5-2'];
  const none = one(fable, view(), { models });
  assert.equal(none.verdict, 'hold');
  assert.match(none.why, /cannot be measured/);
  const windows = [{ type: 'seven_day_fable', utilization: 0.9, resetsAt: NOW + 4 * DAY }];
  const judged = one(fable, view(), { models, windows });
  assert.equal(judged.verdict, 'use_now');
  assert.equal(judged.figures.restoreTokens, 9e6);
});

test('expiry: a lost cause turns to use before expiry inside the warning period, and is amber', () => {
  const near = { ...fable, expiry: NOW + 10 * DAY };
  const a = one(near);
  assert.equal(a.verdict, 'use_before_expiry');
  assert.equal(a.expiring, true);
  assert.match(a.why, /use it for your own work or lose it/);
  assert.equal(one(fable).expiring, false);
});

test('expiry: a reset that lapses before the next point the advice expects it to be worth using gets use before expiry', () => {
  const free = view({ mode: 'normal', capacity: { capacity: CAPACITY, belowReserve: false }, held: {}, resetsAt: NOW + 19 * HOUR });
  assert.equal(one(weekly, free).verdict, 'hold');
  const lapsing = one({ ...weekly, expiry: NOW + 10 * HOUR }, free);
  assert.equal(lapsing.verdict, 'use_before_expiry');
  assert.match(lapsing.why, /lapses in 10 hours/);
  assert.equal(one({ ...weekly, expiry: NOW - HOUR }, free).expired, true);
});

test('expiry: amber from expiry_warn_days before, not earlier', () => {
  assert.equal(one({ ...weekly, expiry: NOW + 14 * DAY }).expiring, true);
  assert.equal(one({ ...weekly, expiry: NOW + 15 * DAY }).expiring, false);
});

test('five hour reset: held by the five hour window with 2 or more hours left and room in the week gives use now', () => {
  const v = view({ mode: 'waiting', used: 0.4, held: { implement: 'x' }, capacity: { capacity: CAPACITY, belowReserve: false }, shortWindow: { used: 1, resetsAt: NOW + 3 * HOUR } });
  const a = one(fiveHour, v);
  assert.equal(a.verdict, 'use_now');
  assert.equal(a.figures.hoursLeft, 3);
  assert.equal(a.figures.spendableTokens, 300e3);
});

test('five hour reset: under 2 hours left, a used up week, or a window that is not the holder each give hold', () => {
  const held = { mode: 'waiting', used: 0.4, held: { implement: 'x' }, capacity: { capacity: CAPACITY, belowReserve: false } };
  assert.match(one(fiveHour, view({ ...held, shortWindow: { used: 1, resetsAt: NOW + 90 * 60000 } })).why, /only 1\.5 hours/);
  assert.match(one(fiveHour, view({ ...held, used: 0.996, shortWindow: { used: 1, resetsAt: NOW + 3 * HOUR } })).why, /weekly window is used up/);
  assert.match(one(fiveHour, view({ ...held, shortWindow: { used: 0.3, resetsAt: NOW + 3 * HOUR } })).why, /not held by its five hour window/);
  assert.match(one(fiveHour, view({ ...held, shortWindow: null })).why, /five hour window is not reported/);
});

test('spacing: several resets of one kind show the gap that keeps them all', () => {
  const three = [1, 2, 3].map(n => ({ ...fable, id: `bbbb000${n}` }));
  assert.equal(spacingText(three, Date.UTC(2026, 10, 12)), '3 left, 17 weeks: one every 5 weeks keeps them all');
  const advice = advise(three);
  assert.ok(advice.every(a => a.spacing === advice[0].spacing && /3 left/.test(a.spacing)));
  assert.equal(spacingText([three[0]], NOW), null);
});

test('used resets get no advice', () => {
  assert.deepEqual(advise([{ ...weekly, state: 'used' }]), []);
});
