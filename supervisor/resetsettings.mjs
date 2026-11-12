// Issue #1162: the `budget.resets` thresholds and their validation. Defaults: a reset is worth using when 60 % of what it restores could be spent before the
// natural reset, and an expiry is flagged amber from 14 days before it.
import { SupervisorError } from './core.mjs';

export const RESET_DEFAULTS = { usable_share: 0.6, expiry_warn_days: 14 };

export function validateResetsConfig(resets) {
  if (resets === undefined) return;
  if (!resets || typeof resets !== 'object' || Array.isArray(resets)) throw new SupervisorError('invalid budget config: resets');
  const bad = Object.keys(resets).find(key => !Object.hasOwn(RESET_DEFAULTS, key));
  if (bad) throw new SupervisorError(`invalid budget config: unknown key resets.${String(bad).slice(0, 30)}`);
  const inRange = (key, low, high) => {
    if (key in resets && !(Number.isFinite(resets[key]) && resets[key] >= low && resets[key] <= high)) throw new SupervisorError(`invalid budget config: resets.${key}`);
  };
  inRange('usable_share', 0.05, 1);
  inRange('expiry_warn_days', 1, 365);
}

export const resetSettings = config => ({ ...RESET_DEFAULTS, ...(config?.budget?.resets || {}) });
