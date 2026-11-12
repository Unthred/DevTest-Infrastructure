// Issue #1162: the Needs you items for limit resets. One item per reset whose notice is open (resetnotices.mjs) and whose advice still says use now or
// use before expiry; marking the reset used removes it at once, before the tick closes the notice.
import { NOTIFY_VERDICTS } from './resetsview.mjs';
import { redact } from './redact.mjs';

const WHAT = { weekly: 'weekly', five_hour: 'five hour' };

export function resetAttention(resets, notices) {
  const items = [];
  for (const [agent, group] of Object.entries(resets.agents)) {
    for (const advice of group.advice) {
      if (!NOTIFY_VERDICTS.has(advice.verdict) || notices?.[advice.id]?.status !== 'open') continue;
      const scope = advice.scope === 'all' ? '' : ` ${advice.scope}`;
      const lead = advice.verdict === 'use_now' ? 'Applying a limit reset now would turn most of it into work' : 'A limit reset is about to lapse';
      items.push({
        id: `resets-${advice.id}`,
        text: redact(`${agent}: ${lead} (${WHAT[advice.limit]}${scope} reset). ${advice.why}`, 400),
        ref: null,
        severity: 'action',
        action: 'Apply the reset on claude.ai (Settings, Usage) if you agree, then press "Mark used" on the Limit resets card on the Usage and cost page.',
      });
    }
  }
  return items;
}
