// Issue #1346: validation of the optional budget.choice block read by slotchoice.mjs.
import { SupervisorError } from './core.mjs';
import { DEFAULT_JOB_SHARE } from './jobshare.mjs';

const SHARE_TYPES = [...Object.keys(DEFAULT_JOB_SHARE.shares), 'continue'];
const KEYS = ['min_samples', 'short_per_weekly', 'default_shares', 'pins'];

const refusal = reason => new SupervisorError(`invalid budget config: choice ${reason}`);

function validateShares(shares) {
  for (const [type, share] of Object.entries(shares ?? {})) {
    const valid = SHARE_TYPES.includes(type) && Number.isFinite(share) && share > 0 && share <= 1;
    if (!valid) throw refusal(`default_shares.${type} must be a job type with a share above 0 and at most 1`);
  }
}

function validatePins(pins, agentNames) {
  for (const [issue, pin] of Object.entries(pins ?? {})) {
    if (!/^\d+$/.test(issue)) throw refusal(`pins.${issue} must be named by issue number`);
    if (!agentNames.includes(pin?.agent)) throw refusal(`pins.${issue} names an unknown agent`);
    if (!['required', 'preferred'].includes(pin?.mode)) throw refusal(`pins.${issue} mode must be required or preferred`);
  }
}

// budget.choice: { min_samples, short_per_weekly, default_shares: { <job type>: share }, pins: { "<issue>": { agent, mode } } }.
export function validateChoiceConfig(choice, agentNames) {
  if (choice === undefined) return;
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) throw refusal('must be an object');
  const unknown = Object.keys(choice).find(key => !KEYS.includes(key));
  if (unknown) throw refusal(`has unknown key ${unknown}`);
  const { min_samples: minSamples, short_per_weekly: shortPerWeekly } = choice;
  if ('min_samples' in choice && !(Number.isSafeInteger(minSamples) && minSamples >= 1)) {
    throw refusal('min_samples must be a whole number of at least 1');
  }
  if ('short_per_weekly' in choice && !(Number.isFinite(shortPerWeekly) && shortPerWeekly > 0)) {
    throw refusal('short_per_weekly must be above 0');
  }
  validateShares(choice.default_shares);
  validatePins(choice.pins, agentNames);
}
