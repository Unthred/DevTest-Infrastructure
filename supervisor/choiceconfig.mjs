// Issue #1166: validation of the optional budget.choice block (job cost defaults and pins) read by slotchoice.mjs.
import { SupervisorError } from './core.mjs';

const SHARE_KEYS = ['implement', 'continue', 'fix', 'cifix', 'rebase', 'review', 'inbox'];

// budget.choice: { min_samples, short_per_weekly, default_shares: { <job type>: share }, pins: { "<issue>": { agent, mode: required|preferred } } }.
export function validateChoiceConfig(choice, agentNames) {
  if (choice === undefined) return;
  const bad = reason => new SupervisorError(`invalid budget config: choice ${reason}`);
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw bad('must be an object');
  const unknown = Object.keys(choice).find(k => !['min_samples', 'short_per_weekly', 'default_shares', 'pins'].includes(k));
  if (unknown) throw bad(`has unknown key ${unknown}`);
  if ('min_samples' in choice && !(Number.isSafeInteger(choice.min_samples) && choice.min_samples >= 1)) throw bad('min_samples');
  if ('short_per_weekly' in choice && !(Number.isFinite(choice.short_per_weekly) && choice.short_per_weekly > 0)) throw bad('short_per_weekly');
  for (const [type, share] of Object.entries(choice.default_shares || {})) {
    if (!SHARE_KEYS.includes(type) || !(Number.isFinite(share) && share > 0 && share <= 1)) throw bad(`default_shares.${type}`);
  }
  for (const [issue, pin] of Object.entries(choice.pins || {})) {
    if (!/^\d+$/.test(issue) || !agentNames.includes(pin?.agent) || !['required', 'preferred'].includes(pin?.mode)) throw bad(`pins.${issue}`);
  }
}

