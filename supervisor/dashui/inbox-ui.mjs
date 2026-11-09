// Inbox decision logic for the dashboard script (issue #856). No DOM here: app.js passes in what to disable, label and show, so the order
// of events (both buttons off at once, the pressed one labelled, a refusal giving them back with the reason) is the same code the tests run.

import { bindApproveAll } from './approve-all.mjs';

export const PRESSED = { approve: 'Approved ✓', reject: 'Rejected ✗' };
export const OUTCOME_LABEL = { approve: 'Approved', reject: 'Rejected' };
// Issue #925: what an approved item says until the tick takes it ({t} is the time); a rejected one is final at once.
export const OUTCOME_TEMPLATE = { approve: 'Approved {t}, queued for the inbox lane', reject: 'Rejected {t}' };
// A refusal that says the item was already decided (a second tab, a stale page): the item is settled, so its buttons stay off.
export const ALREADY_DECIDED = /^the item is already (approved|rejected|running|posting|done|failed|refused)\b/;

// POST one decision as JSON. Any answer that is not the server's JSON (a proxy page, an old server, a network failure) is a refusal with
// a reason, never a silent success.
export async function postDecision(fetchFn, url, params) {
  let r;
  try { r = await fetchFn(url, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params).toString(), credentials: 'same-origin' }); }
  catch { return { ok: false, reason: 'The dashboard could not be reached; nothing was changed.' }; }
  let j = null; try { j = await r.json(); } catch { /* not JSON */ }
  if (j && typeof j.ok === 'boolean') return j.ok || typeof j.reason === 'string' ? j : { ok: false, reason: `The dashboard refused the decision (HTTP ${r.status}).` };
  return { ok: false, reason: `The dashboard refused the decision (HTTP ${r.status}).` };
}

// ui: { lock(label), unlock(), error(text|null), decided(result), settled(text) }.
export async function runDecision({ decision, post, ui }) {
  if (!PRESSED[decision]) throw new Error('unknown decision');
  ui.error(null);
  ui.lock(PRESSED[decision]);   // both buttons at once, before the answer: a second click cannot decide the other way
  const result = await post();
  if (!result.ok && ui.settled && ALREADY_DECIDED.test(result.reason || '')) { ui.settled(`Already decided: ${result.reason.replace(/^the item is /, 'it is ')}. Nothing was changed.`); return result; }
  if (!result.ok) { ui.unlock(); ui.error(`Not recorded: ${result.reason}`); return result; }
  ui.decided(result);
  return result;
}

// The Needs you heading count after a card leaves: "Needs you (3)" -> "Needs you (2)"; no count when none are left.
export const lowerCount = (heading, by = 1) => String(heading).replace(/\((\d+)\)/, (m, n) => (Number(n) - by > 0 ? `(${Number(n) - by})` : '')).trim();

// Issue #1101: the "Waiting for approval" dropdown's Approve all and live badge, bound once in the browser (app.js already loads this file).
if (typeof document !== 'undefined') bindApproveAll(postDecision);
