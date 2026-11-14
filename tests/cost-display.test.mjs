// Issue #1097: job cost is shown in pounds, converted by one function from one configured rate; stored records stay in dollars.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GBP_PER_USD, configureDisplay, displayRate, formatCost, gbpAmount, validateDisplay } from '../supervisor/money.mjs';
import { validateTeamConfig, applyLocalOverride } from '../supervisor/team.mjs';
import { gbpOf } from '../foreman-mcp/insights.mjs';
import { discarded } from '../supervisor/joboutcome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const shipped = () => JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));

test('formatCost: pounds with pence, rounding, zero and unknown', t => {
  t.after(() => configureDisplay(undefined));
  configureDisplay({ gbp_per_usd: 0.8 });
  assert.equal(formatCost(1.9), '£1.52');
  assert.equal(formatCost(0), '£0.00');
  assert.equal(formatCost(0.004), '£0.00');
  assert.equal(formatCost(0.0126), '£0.01');          // 0.01008 rounds to a penny
  assert.equal(formatCost(1.25, { rate: 1 }), '£1.25');   // an explicit rate wins over the configured one
  for (const bad of [null, undefined, NaN, Infinity, '1.5']) assert.equal(formatCost(bad), '–', String(bad));
  assert.equal(formatCost(null, { unknown: 'unknown' }), 'unknown');
  assert.equal(gbpAmount(null), null);
  assert.equal(gbpAmount(2, 0.5), 1);
  assert.ok(!formatCost(3).includes('$'));
});

test('display config: documented default, one key, strict validation', () => {
  assert.equal(validateDisplay(undefined).gbp_per_usd, DEFAULT_GBP_PER_USD);
  assert.equal(validateDisplay({ gbp_per_usd: 0.81 }).gbp_per_usd, 0.81);
  for (const bad of [{ gbp_per_usd: 0 }, { gbp_per_usd: -1 }, { gbp_per_usd: '0.8' }, { gbp_per_usd: NaN }, { gbp_per_usd: 11 }, { other: 1 }, null, [], 'x'])
    assert.throws(() => validateDisplay(bad), /invalid team config: display/, JSON.stringify(bad));
  assert.equal(validateTeamConfig(shipped()).display.gbp_per_usd, DEFAULT_GBP_PER_USD);
  const noKey = shipped(); delete noKey.display;
  assert.equal(validateTeamConfig(noKey).display.gbp_per_usd, DEFAULT_GBP_PER_USD);
  const bad = shipped(); bad.display = { gbp_per_usd: 0 };
  assert.throws(() => validateTeamConfig(bad), /display\.gbp_per_usd/);
});

test('team.local.json can override the rate; a bad value is refused', () => {
  assert.equal(validateTeamConfig(applyLocalOverride(shipped(), { display: { gbp_per_usd: 0.9 } })).display.gbp_per_usd, 0.9);
  assert.throws(() => applyLocalOverride(shipped(), { display: { gbp_per_usd: 'x' } }), /invalid team.local.json/);
});

test('MCP helper converts with the view rate and leaves unknown as null', () => {
  assert.equal(gbpOf(2, { display: { gbpPerUsd: 0.75 } }), 1.5);
  assert.equal(gbpOf(null, { display: { gbpPerUsd: 0.75 } }), null);
  assert.equal(gbpOf(2, {}), null);
});

test('the waste record is converted for display and the stored value is untouched', t => {
  t.after(() => configureDisplay(undefined));
  configureDisplay({ gbp_per_usd: 0.5 });
  const state = { breaker: { waste: { a: { job: 'a', at: 1, tokens: 10, cost: 4, cause: 'x' } } } };
  const out = discarded(state, 10);
  assert.equal(out.totalCostGbpEquivalent, 2);
  assert.equal(out.items[0].costGbpEquivalent, 2);
  assert.equal(state.breaker.waste.a.cost, 4);   // A3: the stored USD stays
  assert.equal(displayRate(), 0.5);
});

test('the breaker replay report honours the configured rate (host override) and the default', t => {
  const run = override => {
    const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'replay-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'jobs'));
    fs.writeFileSync(path.join(root, 'jobs', 'a.json'), JSON.stringify({ id: 'a', kind: 'implement', status: 'failed', updatedAt: 1000, createdAt: 900, usage: { inputTokens: 10, outputTokens: 5, costUsdEstimate: 4 } }));
    if (override) fs.writeFileSync(path.join(root, 'team.local.json'), JSON.stringify(override));
    return execFileSync(process.execPath, [new URL('../tools/breaker-replay.mjs', import.meta.url).pathname, '--root', root], { encoding: 'utf8' });
  };
  assert.match(run(null), /£3\.00/);                              // default 0.75
  assert.match(run({ display: { gbp_per_usd: 0.5 } }), /£2\.00/);  // host override
});

// Issue #1433: a half-penny tie rounds away from zero for either sign, so the dashboard and the MCP card agree.
test('gbpAmount: a half-penny tie rounds away from zero for positive and negative amounts', t => {
  t.after(() => configureDisplay(undefined));
  assert.equal(gbpAmount(2.82, 0.75), 2.12);
  assert.equal(gbpAmount(-2.82, 0.75), -2.12);
  assert.equal(gbpAmount(0, 0.75), 0);
  assert.ok(Object.is(gbpAmount(-0.001, 0.75), 0));
  configureDisplay({ gbp_per_usd: 0.75 });
  assert.equal(formatCost(2.82), '£2.12');
});
