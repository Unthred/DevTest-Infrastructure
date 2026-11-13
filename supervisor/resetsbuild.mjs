// Issue #1162: advice for the limit resets the homeowner recorded (limitresets.mjs, #1159), for the dashboard card, the Needs you items and the
// tick. Shared by all three so they cannot disagree. Reads the records and the open notices; everything else comes in as plain data.
import { readResets, expiryTime } from './limitresets.mjs';
import { modelsOf } from './resetsview.mjs';
import { adviseAgent } from './resetadvice.mjs';
import { fullPace } from './resetpace.mjs';
import { resetSettings } from './resetsettings.mjs';
import { budgetSettings } from './budget.mjs';
import { readNotices } from './resetnotices.mjs';
import { resetAttention } from './resetattention.mjs';

// An agent whose allowance has not been read yet: advice still lists its resets, saying what cannot be measured.
const NO_READING = { mode: 'normal', used: null, resetsAt: null, shortWindow: null, held: {}, capacity: null };

// The stored record in the shape the advice reads: the expiry as an end-of-day time and the state as available or used.
export const adviceRecord = r => ({ id: r.id, agent: r.agent, limit: r.limit, scope: r.scope, expiry: expiryTime(r.expires), state: r.usedAt ? 'used' : 'available' });

// { agent: [advice] } for every configured agent, from the stored records.
export function adviceByAgent({ records, config, budget, jobs, allowance, now }) {
  const settings = { ...resetSettings(config), exhausted_at: budgetSettings(config).exhausted_at };
  const rows = records.map(adviceRecord);
  const out = {};
  for (const [name, agent] of Object.entries(config?.agents || {})) {
    out[name] = adviseAgent({ records: rows, name, view: budget?.[name] ?? NO_READING, windows: allowance?.[agent.provider]?.windows || [],
      models: modelsOf(config, name), pace: fullPace(jobs, agent.provider, now), settings, now });
  }
  return out;
}

export function resetAdviceFor({ root, config, budget, jobs, allowance, now }) {
  const byAgent = adviceByAgent({ records: readResets(root), config, budget, jobs, allowance, now });
  const all = Object.values(byAgent).flat();
  return { byId: Object.fromEntries(all.map(a => [a.id, a])), attention: resetAttention(all, readNotices(root).notices) };
}
