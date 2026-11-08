// Issue #1070: the shipped config no longer contradicts itself (out_of_allowance vs exhausted_at), the dead review_exception route is gone,
// and a split job has its own cheap entry. Real files and real functions; no network, no model.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateTeamConfig, weeklyAtOf } from '../supervisor/team.mjs';
import { outOfAllowance } from '../supervisor/interim.mjs';
import { resolveModel } from '../supervisor/models.mjs';

const shipped = () => JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
const NOW = Date.parse('2026-11-08T12:00:00Z'), RESET = NOW + 3 * 86400000;
const allowance = used => ({ observedAt: NOW, windows: [{ type: 'weekly', utilization: used, resetsAt: RESET }] });

test('shipped out_of_allowance.weekly_at equals budget.exhausted_at', () => {
  const c = shipped();
  assert.equal(c.out_of_allowance.weekly_at, c.budget.exhausted_at);
  assert.equal(weeklyAtOf(validateTeamConfig(c)), 0.995);
});

test('a reviews_only agent at 97% may review; one at or above exhausted_at may not', () => {
  const c = validateTeamConfig(shipped()), weeklyAt = weeklyAtOf(c);
  const out = used => outOfAllowance({ provider: 'codex', allowance: allowance(used), weeklyAt, now: NOW });
  assert.equal(out(0.97).out, false);          // was held at 0.95 before #1070
  assert.equal(out(0.994).out, false);
  assert.equal(out(0.995).out, true);
  assert.equal(out(0.999).out, true);
});

test('review_exception is no longer accepted shipped, and the shipped agent issue lists are empty', () => {
  const c = shipped();
  assert.equal('review_exception' in c, false);
  assert.deepEqual(Object.values(c.agents).map(a => a.issues), [[], []]);
  assert.ok(!fs.existsSync(new URL('../supervisor/review-exception.mjs', import.meta.url)));
});

test('a split job resolves to the implementer provider at low effort, not the review entry', () => {
  const c = validateTeamConfig(shipped());
  const r = resolveModel({ modelsConfig: c.models, agent: 'claude', kind: 'split', manifestModels: { aliases: ['sonnet', 'opus'], efforts: ['low', 'medium'] }, escalation: null, utilization: null, reReview: false, low: false });
  assert.equal(r.fields.model, 'sonnet');
  assert.equal(r.fields.effort, 'low'); assert.equal(r.fields.modelReason, 'configured for split');
});
