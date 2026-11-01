// Model and effort routing per agent and job type (issue #64). Provider-agnostic (D-012): nothing here names a provider.
// What a CLI accepts is declared by its manifest (`models`: aliases, a full-name pattern, efforts and the argument templates);
// the team config only says which alias/effort each agent uses for each job type. Aliases are used, never version strings.
// An unknown or invalid value never fails a job: it is dropped (the CLI default applies) and a warning is returned.
import { SupervisorError } from './core.mjs';
import { windowExpired } from './allowance.mjs';

// 'interim-review' (D-021): a same-provider review while every other agent is out of allowance; falls back to the review entry.
export const JOB_TYPES = ['implement', 'fix', 'review', 'rebase', 'ci-fix', 'continue', 'interim-review'];
export const typeOfKind = kind => (kind === 'cifix' ? 'ci-fix' : kind);
// Work that keeps the strong model even when the allowance is nearly used up.
export const STRONG_TYPES = new Set(['implement', 'continue']);
// Escalation (issue #78) applies to fix and ci-fix only. A rebase is mechanical and never escalates; `continue` already runs the implement entry.
const REPAIR_TYPES = new Set(['fix', 'ci-fix']);
export const DEFAULT_THRESHOLD = 0.8;
const SHAPE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const entryOk = e => e && typeof e === 'object' && !Array.isArray(e) && Object.keys(e).every(k => ['model', 'effort'].includes(k)) && Object.values(e).every(v => typeof v === 'string');

// Structure only. Whether a model name is *accepted* is judged per use, against the manifest, and degrades to a warning.
export function validateModelsConfig(m, agentNames) {
  if (m === undefined) return;
  if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).some(k => !['allowance_threshold', 'agents'].includes(k))) throw new SupervisorError('invalid models config');
  if ('allowance_threshold' in m && !(Number.isFinite(m.allowance_threshold) && m.allowance_threshold > 0 && m.allowance_threshold <= 1)) throw new SupervisorError('invalid models config: allowance_threshold');
  for (const [agent, table] of Object.entries(m.agents || {})) {
    if (!agentNames.includes(agent)) throw new SupervisorError(`invalid models config: unknown agent ${agent}`);
    if (!table || typeof table !== 'object' || Array.isArray(table)) throw new SupervisorError(`invalid models config: ${agent}`);
    for (const [type, e] of Object.entries(table)) {
      if (![...JOB_TYPES, 'strong', 'low'].includes(type) || !entryOk(e)) throw new SupervisorError(`invalid models config: ${agent}.${type}`);
    }
  }
}
export function mergeModelsConfig(shipped, local) {
  if (local === undefined) return shipped;
  const out = structuredClone(shipped || {});
  if (local && typeof local === 'object' && 'allowance_threshold' in local) out.allowance_threshold = local.allowance_threshold;
  out.agents ||= {};
  for (const [agent, table] of Object.entries(local?.agents || {})) out.agents[agent] = { ...(out.agents[agent] || {}), ...(table && typeof table === 'object' ? table : {}) };
  for (const k of Object.keys(local || {})) if (!['allowance_threshold', 'agents'].includes(k)) out[k] = local[k];
  return out;
}

// Judge one {model, effort} pair against a manifest's `models` section. Returns the usable parts and warnings.
export function checkEntry(entry, spec) {
  const out = { model: null, effort: null }, warnings = [];
  if (!entry) return { ...out, warnings };
  if (!spec) { if (entry.model || entry.effort) warnings.push('provider declares no model selection; CLI default used'); return { ...out, warnings }; }
  if (entry.model != null) {
    const ok = typeof entry.model === 'string' && SHAPE.test(entry.model) && ((spec.aliases || []).includes(entry.model) || (typeof spec.pattern === 'string' && new RegExp(spec.pattern).test(entry.model)));
    if (ok) out.model = entry.model; else warnings.push(`model "${String(entry.model).slice(0, 40)}" is not accepted by the provider; CLI default model used`);
  }
  if (entry.effort != null) {
    if ((spec.efforts || []).includes(entry.effort)) out.effort = entry.effort; else warnings.push(`effort "${String(entry.effort).slice(0, 20)}" is not accepted by the provider; CLI default effort used`);
  }
  return { ...out, warnings };
}

// Weekly utilisation 0..1 from a provider-reported allowance record, or null when unknown or the window has already reset.
export function weeklyUtilization(allowance, now = Date.now()) {
  const w = (allowance?.windows || []).find(x => Number.isFinite(x.utilization) && (/^seven_day|week/.test(x.type || '') || x.windowMinutes >= 10000) && !windowExpired(x, now));
  return w ? w.utilization : null;
}

// ctx: { modelsConfig, agent, kind, manifestModels, escalation: {reason}|null, utilization: number|null, reReview, low }
// reReview + low (issue #56): a fix-round re-review while the reviewer's allowance is low uses the agent's `low` entry when configured.
export function resolveModel(ctx) {
  const table = ctx.modelsConfig?.agents?.[ctx.agent];
  let type = typeOfKind(ctx.kind);
  if (type === 'interim-review' && table && !table[type]) type = 'review';
  if (!table || !table[type]) return { fields: {}, warnings: [] };
  const threshold = ctx.modelsConfig.allowance_threshold ?? DEFAULT_THRESHOLD;
  if (type === 'rebase') ctx = { ...ctx, escalation: null };
  const strong = table.strong || table.implement || table[type];
  let entry = table[type], source = 'configured', reason = `configured for ${type}`;
  const hot = Number.isFinite(ctx.utilization) && ctx.utilization >= threshold;
  if (type === 'review' && ctx.reReview && ctx.low && table.low) { entry = table.low; source = 'allowance'; reason = 'fix-round re-review while the allowance is low: lower-cost entry'; }
  else if (hot && !STRONG_TYPES.has(type)) { source = 'allowance'; reason = `weekly allowance ${Math.round(ctx.utilization * 100)}% >= ${Math.round(threshold * 100)}%: cheaper model kept for ${type}`; }
  else if (ctx.low && ctx.escalation && !STRONG_TYPES.has(type)) { source = 'allowance'; reason = `allowance low: escalation suppressed for ${type}`; }
  else if (ctx.escalation && !STRONG_TYPES.has(type)) { entry = strong; source = 'escalated'; reason = `escalated: ${ctx.escalation.reason}`; }
  else if (hot) reason = `${type} keeps its model although weekly allowance is ${Math.round(ctx.utilization * 100)}%`;
  const checked = checkEntry(entry, ctx.manifestModels);
  const fields = { modelSource: source, modelReason: reason.slice(0, 200) };
  if (checked.model) fields.model = checked.model;
  if (checked.effort) fields.effort = checked.effort;
  if (checked.warnings.length) fields.modelWarning = checked.warnings.join('; ').slice(0, 200);
  return { fields, warnings: checked.warnings };
}

// CHANGES verdicts are keyed `<pr>:<head>`; two on one PR (across heads) escalate its repair jobs.
export function repeatedChanges(verdicts, pr) {
  return Object.entries(verdicts || {}).filter(([k, v]) => k.startsWith(`${pr}:`) && v.verdict === 'CHANGES').length >= 2;
}
export const isRepair = type => REPAIR_TYPES.has(type);

// Argument templates from the manifest: `{model}` / `{effort}` are substituted into single argv entries (no shell involved).
export function modelArgs(manifestModels, job) {
  if (!manifestModels) return [];
  const checked = checkEntry({ model: job.model, effort: job.effort }, manifestModels);
  const sub = (tpl, key, value) => (Array.isArray(tpl) ? tpl.map(x => x.replace(`{${key}}`, value)) : []);
  return [...(checked.model ? sub(manifestModels.model_args, 'model', checked.model) : []), ...(checked.effort ? sub(manifestModels.effort_args, 'effort', checked.effort) : [])];
}
