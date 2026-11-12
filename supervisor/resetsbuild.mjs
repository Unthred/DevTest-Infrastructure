// Issue #1162: reads the stored resets and notices and builds everything the dashboard shows about them: the per-agent advice and the Needs you items.
import { readRecords } from './resetrecords.mjs';
import { resetsView } from './resetsview.mjs';
import { readSeen } from './resetnotices.mjs';
import { resetAttention } from './resetattention.mjs';

export function limitResetsFor({ root, config, budget, jobs, allowance, now }) {
  const records = readRecords(root);
  const resets = resetsView({ records, budget, config, jobs, allowance, now });
  const notices = readSeen(root).notices;
  return { view: { ...resets, agentNames: Object.keys(config?.agents || {}), recordCount: records.length }, attention: resetAttention(resets, notices) };
}
