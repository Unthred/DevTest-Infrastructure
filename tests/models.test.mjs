// Model and effort routing per job type (issue #64): resolution, local overrides, escalation, allowance threshold, fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Team, applyLocalOverride, validateTeamConfig } from '../supervisor/team.mjs';
import { validateManifest, stateRoot, provider, defaultRegistry } from '../supervisor/core.mjs';
import { resolveModel, weeklyUtilization, modelArgs, validateModelsConfig, checkEntry } from '../supervisor/models.mjs';
import * as codex from '../supervisor/adapters/codex.mjs';
import { modelUsage } from '../supervisor/dashboard.mjs';
import { claudeAllowance, codexAllowance } from '../supervisor/allowance.mjs';

const shipped = JSON.parse(fs.readFileSync(new URL('../supervisor/team.json', import.meta.url), 'utf8'));
const manifest = n => JSON.parse(fs.readFileSync(new URL(`../supervisor/providers/${n}.json`, import.meta.url), 'utf8'));
const claudeModels = manifest('claude').models, codexModels = manifest('codex').models;
const H = n => String(n).repeat(40).slice(0, 40);

test('shipped defaults: Claude sonnet for routine work, opus for implement; Codex low effort for review and rebase, high for implement', () => {
  validateTeamConfig(shipped);
  const r = (agent, kind, m, extra = {}) => resolveModel({ modelsConfig: shipped.models, agent, kind, manifestModels: m, escalation: null, utilization: null, ...extra }).fields;
  for (const k of ['fix', 'review', 'rebase', 'cifix']) assert.equal(r('claude', k, claudeModels).model, 'sonnet', k);
  assert.equal(r('claude', 'implement', claudeModels).model, 'opus');
  assert.equal(r('codex', 'review', codexModels).effort, 'low');
  assert.equal(r('codex', 'rebase', codexModels).effort, 'low');
  assert.equal(r('codex', 'implement', codexModels).effort, 'high');
  assert.equal(r('codex', 'implement', codexModels).model, undefined);   // Codex keeps its standard model
  assert.ok(!JSON.stringify(shipped.models.agents).match(/\d\.\d|claude-|gpt/), 'aliases only, no version strings');
});

test('local override changes one entry and keeps the rest; structural mistakes are refused', () => {
  const out = applyLocalOverride(shipped, { models: { allowance_threshold: 0.5, agents: { claude: { review: { model: 'haiku', effort: 'low' } } } } });
  assert.equal(out.models.allowance_threshold, 0.5);
  assert.deepEqual(out.models.agents.claude.review, { model: 'haiku', effort: 'low' });
  assert.equal(out.models.agents.claude.fix.model, 'sonnet');
  assert.equal(shipped.models.allowance_threshold, 0.8, 'shipped object not mutated');
  assert.throws(() => applyLocalOverride(shipped, { models: { agents: { nobody: {} } } }), /unknown agent/);
  assert.throws(() => applyLocalOverride(shipped, { models: { agents: { claude: { deploy: { model: 'opus' } } } } }), /claude\.deploy/);
  assert.throws(() => applyLocalOverride(shipped, { models: { allowance_threshold: 5 } }), /allowance_threshold/);
  assert.throws(() => validateModelsConfig({ agents: { claude: { fix: { model: 3 } } } }, ['claude']), /claude\.fix/);
});

test('invalid or unknown model: dropped with a warning, the valid effort is kept, nothing throws', () => {
  const cfg = { agents: { claude: { fix: { model: 'sonnet-9000', effort: 'medium' }, review: { model: 'sonnet', effort: 'ludicrous' }, rebase: { model: 'x; rm -rf /', effort: 'low' } } } };
  const fix = resolveModel({ modelsConfig: cfg, agent: 'claude', kind: 'fix', manifestModels: claudeModels });
  assert.equal(fix.fields.model, undefined); assert.equal(fix.fields.effort, 'medium'); assert.match(fix.fields.modelWarning, /not accepted/); assert.equal(fix.warnings.length, 1);
  const review = resolveModel({ modelsConfig: cfg, agent: 'claude', kind: 'review', manifestModels: claudeModels });
  assert.equal(review.fields.model, 'sonnet'); assert.equal(review.fields.effort, undefined); assert.match(review.fields.modelWarning, /effort/);
  assert.equal(resolveModel({ modelsConfig: cfg, agent: 'claude', kind: 'rebase', manifestModels: claudeModels }).fields.model, undefined);
  const none = resolveModel({ modelsConfig: cfg, agent: 'claude', kind: 'fix', manifestModels: null });   // provider without model selection
  assert.deepEqual([none.fields.model, none.fields.effort], [undefined, undefined]); assert.equal(none.warnings.length, 1);
  assert.equal(checkEntry({ model: 'claude-opus-9-9' }, claudeModels).model, 'claude-opus-9-9', 'a full model name is accepted by pattern');
});

test('arguments come from the manifest and are single argv entries; bad values never reach the command line', () => {
  assert.deepEqual(modelArgs(claudeModels, { model: 'sonnet', effort: 'medium' }), ['--model', 'sonnet', '--effort', 'medium']);
  assert.deepEqual(modelArgs(codexModels, { effort: 'low' }), ['-c', 'model_reasoning_effort=low']);
  assert.deepEqual(modelArgs(claudeModels, { model: 'nonsense', effort: '$(id)' }), []);
  assert.deepEqual(modelArgs(codexModels, { model: 'unknown-model-123' }), [], 'an unknown Codex model is dropped, not forwarded');
  assert.deepEqual(modelArgs(codexModels, { model: 'gpt-5.6-terra' }), ['--model', 'gpt-5.6-terra']);
  for (const bad of ['gpt-not-a-real-model', 'gpt-definitely-unknown-9999']) {
    assert.deepEqual(modelArgs(codexModels, { model: bad }), [], `${bad} is not a listed Codex model`);
    const c = codex.command({ command: ['codex'], manifest: manifest('codex') }, { role: 'devtest', worktree: '/w', access: 'standard', model: bad }, false);
    assert.ok(!c.includes('--model'), 'adapter argv has no --model for an invented gpt- name');
    assert.equal(checkEntry({ model: bad }, codexModels).warnings.length, 1);
  }
  const unk = checkEntry({ model: 'unknown-model-123' }, codexModels);
  assert.equal(unk.model, null); assert.equal(unk.warnings.length, 1);
  const cu = codex.command({ command: ['codex'], manifest: manifest('codex') }, { role: 'devtest', worktree: '/w', access: 'standard', model: 'unknown-model-123' }, false);
  assert.ok(!cu.includes('--model'), 'adapter argv has no --model for an unknown model');
  assert.deepEqual(modelArgs(null, { model: 'sonnet' }), []);
  assert.deepEqual(modelArgs(claudeModels, {}), []);
  const cmd = codex.command({ command: ['codex'], manifest: manifest('codex') }, { role: 'devtest', worktree: '/w', access: 'standard', effort: 'high', model: 'gpt-5.6-terra' }, false);
  assert.ok(cmd.join(' ').includes('--model gpt-5.6-terra -c model_reasoning_effort=high'));
  assert.equal(cmd.at(-1), '-');
  const plain = codex.command({ command: ['codex'], manifest: manifest('codex') }, { role: 'devtest', worktree: '/w', access: 'standard' }, false);
  assert.ok(!plain.includes('--model') && !plain.join(' ').includes('model_reasoning_effort'), 'no model flags without a configured model');
});

test('manifest validation covers the models section', async () => {
  validateManifest(manifest('claude'), 'claude'); validateManifest(manifest('codex'), 'codex');
  const bad = patch => { const m = structuredClone(manifest('claude')); Object.assign(m.models, patch); return () => validateManifest(m, 'claude'); };
  assert.throws(bad({ model_args: ['--model'] }), /model arguments/);
  assert.throws(bad({ pattern: '(' }), /pattern/);
  assert.throws(bad({ surprise: 1 }), /unknown or missing/);
  for (const id of ['claude', 'codex']) assert.ok((await provider(defaultRegistry, id)).config.manifest.models);
});

test('weekly utilisation is read from the provider-reported windows; stale or missing means unknown', () => {
  const now = 1_000_000;
  const claude = claudeAllowance({ status: 'allowed', unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 2000 }, seven_day: { utilization: 0.85, resetsAt: 5000 } } });
  assert.equal(weeklyUtilization(claude, 1000), 0.85);
  assert.equal(weeklyUtilization(claude, 10_000_000), null, 'window already reset');
  const cx = codexAllowance({ primary: { used_percent: 10, window_minutes: 300, resets_at: 2000 }, secondary: { used_percent: 90, window_minutes: 10080, resets_at: 5000 } });
  assert.equal(weeklyUtilization(cx, 1000), 0.9);
  assert.equal(weeklyUtilization(null, now), null);
  assert.equal(weeklyUtilization({ windows: [{ type: 'five_hour', utilization: 0.99 }] }, now), null, 'a short window is not the weekly one');
});

test('allowance at the threshold keeps the cheap model for everything but implement, and beats escalation', () => {
  const base = { modelsConfig: shipped.models, agent: 'claude', manifestModels: claudeModels };
  const hot = kind => resolveModel({ ...base, kind, utilization: 0.8, escalation: { reason: 'x' } }).fields;
  assert.equal(hot('fix').model, 'sonnet'); assert.equal(hot('fix').modelSource, 'allowance'); assert.match(hot('fix').modelReason, /80%/);
  assert.equal(hot('implement').model, 'opus');
  assert.equal(resolveModel({ ...base, kind: 'fix', utilization: 0.79, escalation: { reason: 'x' } }).fields.model, 'opus', 'below the threshold escalation applies');
  const custom = { ...shipped.models, allowance_threshold: 0.5 };
  assert.equal(resolveModel({ ...base, modelsConfig: custom, kind: 'fix', utilization: 0.6, escalation: { reason: 'x' } }).fields.modelSource, 'allowance');
  assert.equal(resolveModel({ ...base, kind: 'fix', utilization: null, escalation: null }).fields.modelSource, 'configured', 'unknown allowance changes nothing');
});

test('modelUsage groups tokens per job type and model', () => {
  const rows = [{ kind: 'fix', model: 'sonnet', effort: 'medium', inTokens: 10, outTokens: 5, cost: 0.5 }, { kind: 'fix', model: 'sonnet', effort: 'medium', inTokens: 1, outTokens: 1, cost: null },
    { kind: 'implement', model: null, effort: null, inTokens: null, outTokens: null, cost: null }];
  const g = modelUsage(rows);
  assert.deepEqual(g[0], { kind: 'fix', model: 'sonnet', effort: 'medium', jobs: 2, inTokens: 11, outTokens: 6, cost: 0.5 });
  assert.deepEqual([g[1].model, g[1].effort], ['CLI default', 'default']);
});
