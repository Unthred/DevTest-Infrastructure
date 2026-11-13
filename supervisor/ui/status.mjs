// Issue #1266: the one status function. A condition { state, attention, reason_code, reason_text, since } becomes a tone; the tone picks the
// shape drawn by app.css (circle, ring, two bars, diamond for you, triangle for fault, dashed ring for unknown, square, dash). The shape is
// always shown with a word, so colour only reinforces. groups maps a state to its group, built from the meta model.
export const TONES = ['active', 'waiting', 'held', 'done', 'off', 'you', 'fault', 'unknown'];
const ATTENTION_TONE = { fault: 'fault', homeowner: 'you', unknown: 'unknown' };
const GROUP_TONE = { failed: 'fault' };

export function toneOf(condition, groups) {
  const forced = ATTENTION_TONE[condition?.attention];
  if (forced) return forced;
  const group = groups.get(condition?.state);
  const tone = GROUP_TONE[group] ?? group;
  return TONES.includes(tone) ? tone : 'unknown';
}
