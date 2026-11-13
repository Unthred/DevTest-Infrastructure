// Issue #1162: the advice part of a reset's row on the Limit resets card: the verdict, why, the spacing text and the figures behind it.
// Rendering only; the decisions come from resetadvice.mjs. Helpers (esc, badge) are passed in by the caller.
import { tokensText } from './capacitycheck.mjs';

const VERDICT = {
  use_now: { level: 'action', label: 'Use now' },
  hold: { level: 'info', label: 'Hold' },
  lost_cause: { level: 'info', label: 'Does not help Foreman' },
  use_before_expiry: { level: 'warning', label: 'Use before expiry' },
};

const hoursText = h => (Number.isFinite(h) ? (h >= 48 ? `${Math.round(h / 24 * 10) / 10} days` : `${h} h`) : 'unknown');
const shareText = s => (Number.isFinite(s) ? `${Math.round(s * 100)}%` : 'unknown');

function figuresHtml(f, esc) {
  const rows = [['Would restore', f.restoreTokens === null ? 'not measured' : tokensText(f.restoreTokens)],
    ['Could spend before the natural reset', tokensText(f.spendableTokens ?? NaN)],
    ['Usable share', shareText(f.usableShare)], ['Hours left', hoursText(f.hoursLeft)]];
  return `<dl class="reset-figures">${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

export function adviceHtml(h, advice) {
  if (!advice) return '';
  const v = VERDICT[advice.verdict] || VERDICT.hold;
  const spacing = advice.spacing ? `<br><span class="sub">${h.esc(advice.spacing)}</span>` : '';
  return `<div class="reset-advice" data-verdict="${h.esc(advice.verdict)}">${h.badge(v.level, v.label)} ${h.esc(advice.why)}${spacing}${figuresHtml(advice.figures, h.esc)}</div>`;
}
