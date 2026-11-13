// Issue #1162: the Needs you items for limit resets. One item per reset whose notice is open (resetnotices.mjs) and whose advice still says use now or
// use before expiry; marking the reset used removes it at once, before the tick closes the notice.
import { NOTIFY_VERDICTS } from './resetadvice.mjs';
import { redact } from './redact.mjs';

const WHAT = { weekly: 'weekly', five_hour: 'five hour' };

export function resetAttention(advice, notices) {
  const items = [];
  for (const a of advice) {
    if (!NOTIFY_VERDICTS.has(a.verdict) || notices?.[a.id]?.status !== 'open') continue;
    const scope = a.scope === 'all' ? '' : ` ${a.scope}`;
    const lead = a.verdict === 'use_now' ? 'Applying a limit reset now would turn most of it into work' : 'A limit reset is about to lapse';
    items.push({
      id: `resets-${a.id}`,
      text: redact(`${a.agent}: ${lead} (${WHAT[a.limit]}${scope} reset). ${a.why}`, 400),
      ref: null,
      severity: 'action',
      action: 'Apply the reset on the provider\'s site (for Claude: claude.ai, Settings, Usage) if you agree, then press "Mark used" on the Limit resets card on the Usage and cost page.',
    });
  }
  return items;
}
