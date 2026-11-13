// Issue #1163: the probe hook a tick hands to the team (see admissionrefresh.mjs for how it is used at the admission decision).
import { hasProbe, refreshProvider } from './probe.mjs';
import { storeProbes } from './dashdata.mjs';
import { refreshInputs } from './probenow.mjs';

// Which providers have a probe, and how to run one and keep its reading.
export function admissionProbe({ registry, root, found, config }) {
  return { canProbe: id => hasProbe(registry, id), run: async due => {
    // Issue #1330: a held agent's stale or reset probe may run the minimal session; the refresh before a job is admitted only reads the log.
    const held = due.reason === 'stale' || due.reason === 'reset';
    const r = await refreshProvider(registry, due.provider, { ...refreshInputs(root, config, due.provider), allowSession: held });
    if (!r.record) { console.error(`ai-supervisor: allowance probe for ${due.agent} (${due.reason}) produced no reading: ${r.error}`); return null; }
    found[due.provider] = r.record; storeProbes(root, { [due.provider]: r.record });
    return r.record;
  } };
}
