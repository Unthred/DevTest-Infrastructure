// Issue #1163: the probe hook a tick hands to the team (see admissionrefresh.mjs for how it is used at the admission decision).
import { hasProbe, refreshProvider } from './probe.mjs';
import { storeProbes } from './dashdata.mjs';

// Which providers have a probe, and how to run one and keep its reading.
export function admissionProbe({ registry, root, found }) {
  return { canProbe: id => hasProbe(registry, id), run: async due => {
    const r = await refreshProvider(registry, due.provider);
    if (!r.record) { console.error(`ai-supervisor: allowance probe for ${due.agent} (${due.reason}) produced no reading: ${r.error}`); return null; }
    found[due.provider] = r.record; storeProbes(root, { [due.provider]: r.record });
    return r.record;
  } };
}
