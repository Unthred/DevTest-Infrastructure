// Issue #1162: the limit resets of every agent with their advice, for the dashboard card, the Needs you item and the tick. Shared by all three so
// they cannot disagree. Pure over its inputs (the caller reads the records, the budget view, the jobs and the allowance).
import { adviseAgent } from './resetadvice.mjs';
import { fullPace } from './resetpace.mjs';
import { resetSettings } from './resetsettings.mjs';
import { budgetSettings } from './budget.mjs';

// Every model name in an agent's config (all job types and review candidates), lower case.
export function modelNamesOf(config, agent) {
  const table = config?.models?.agents?.[agent] || {};
  const entries = Object.values(table).flatMap(entry => (Array.isArray(entry) ? entry : [entry]));
  return [...new Set(entries.map(entry => entry?.model).filter(model => typeof model === 'string').map(model => model.toLowerCase()))];
}

// An agent whose allowance has not been read yet: advice still lists its resets, saying what cannot be measured.
const NO_READING = { mode: 'normal', used: null, resetsAt: null, shortWindow: null, held: {}, capacity: null };

export function resetsView({ records, budget, config, jobs, allowance, now }) {
  const settings = { ...resetSettings(config), exhausted_at: budgetSettings(config).exhausted_at };
  const agents = {};
  for (const [name, agent] of Object.entries(config?.agents || {})) {
    const view = budget?.[name] ?? NO_READING;
    const mine = records.filter(record => record.agent === name);
    const pace = fullPace(jobs, agent.provider, now);
    const advice = adviseAgent({ records, name, view, windows: allowance?.[agent.provider]?.windows || [], models: modelNamesOf(config, name), pace, settings, now });
    agents[name] = { advice, used: mine.filter(record => record.state === 'used'), pace };
  }
  return { agents, settings: { usable_share: settings.usable_share, expiry_warn_days: settings.expiry_warn_days } };
}

export const NOTIFY_VERDICTS = new Set(['use_now', 'use_before_expiry']);
