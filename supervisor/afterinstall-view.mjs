// Issue #1177: the dashboard side of the After install items. Kept apart from afterinstall.mjs, which the team state imports,
// so the team does not load the dashboard data modules.
import { redact } from './dashdata.mjs';
import { afterInstallItems } from './afterinstall.mjs';
import { readUpgrades } from './suphealth.mjs';

// PRs that are part of a completed install (upgrade record verified).
export const installedPrsOf = root => new Set((() => { try { return readUpgrades(root).filter(r => r.result === 'verified' && Array.isArray(r.prs)).flatMap(r => r.prs); } catch { return []; } })());

// The Needs you items of the dashboard: reads the upgrade records for the installed PRs.
export function afterInstallAttention({ state, root, names, config }) {
  const installed = installedPrsOf(root);
  const url = n => `https://github.com/${config.repository}/pull/${n}`;
  return afterInstallItems({ steps: state.afterInstallSteps, merged: state.mergeLog, installed, name: n => names.pr(n).text, url })
    .map(i => ({ ...i, text: redact(i.text, 300), tried: redact(i.tried, 300), action: redact(i.action, 300) }));
}
