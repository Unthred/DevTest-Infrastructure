// Judges one row of the PR "Requirements check" table (issue #1177).
// Rows from the issue's "before the PR" list must be Met (or Homeowner-only with the stated reason).
// Rows from the "after install" list can only be checked once the change runs on Tower: they use After install
// and do not fail the pr_opened post condition. They stay visible so each becomes a Needs you step after install.
export const normalizedStatus = value => String(value || '').trim().toLowerCase().replace(/\s+/g, '-');

const HOMEOWNER_REASON = /credentials|approval|physical action/i;
// A conditional requirement ("when V2 item 6 is merged") whose condition is not met is not applicable. The evidence must name the item
// and say it is still open or not merged, so Not applicable cannot be used to skip work that does apply.
const CONDITION_ITEM = /(?:#\d+|\b(?:issue|pull request|PR|item)\s+\d+)/i;
const CONDITION_UNMET = /\b(?:still open|not (?:yet )?(?:merged|closed|installed))\b/i;
// A requirement that itself says the check happens on Tower after install is an After install row, whatever the
// issue calls its list (#1184: issues write it as an "Acceptance: on Tower after install ..." bullet).
const AFTER_INSTALL_WORDING = /\bafter (?:install|deploy)|\bonce installed\b/i;
const AFTER_INSTALL_CHECKER = /\b(homeowner|overseer)\b/i;

export const ALLOWED_STATUSES = 'Met, Homeowner-only (evidence names the required credentials, approval or physical action), After install (evidence names who checks it: homeowner or overseer), or Not applicable (a conditional requirement whose condition is not met; evidence names the item that is still open or not merged)';

export function rowRefusal(requirement, status, evidence) {
  const named = `requirement "${String(requirement).slice(0, 160)}"`;
  const kind = normalizedStatus(status);
  if (kind === 'met') return null;
  if (kind === 'homeowner-only') {
    if (AFTER_INSTALL_WORDING.test(requirement)) return `${named} is marked Homeowner-only, but it is a check made on Tower once the change is installed. Do not finish it before the PR: set the status to After install and name who checks it (homeowner or overseer) in the evidence. Homeowner-only is for work needed before the pull request. Allowed statuses: ${ALLOWED_STATUSES}.`;
    if (HOMEOWNER_REASON.test(evidence)) return null;
    return `${named} is Homeowner-only but its evidence does not state the required credentials, approval or physical action. Allowed statuses: ${ALLOWED_STATUSES}. State the specific credentials, approval or physical action in the evidence. If this check can only be made once the change is installed on Tower, set the status to After install instead and name who checks it.`;
  }
  if (kind === 'after-install') {
    if (AFTER_INSTALL_CHECKER.test(evidence)) return null;
    return `${named} is After install but its evidence does not say who checks it. Allowed statuses: ${ALLOWED_STATUSES}. Name the homeowner or overseer in the evidence.`;
  }
  if (kind === 'not-applicable') {
    if (CONDITION_ITEM.test(evidence) && CONDITION_UNMET.test(evidence)) return null;
    return `${named} is Not applicable but its evidence does not name the open item its condition waits on. Allowed statuses: ${ALLOWED_STATUSES}. Name the issue or pull request (for example #1148) and say it is still open or not merged; otherwise finish the work and set it to Met.`;
  }
  return `${named} is ${status}. Allowed statuses: ${ALLOWED_STATUSES}. If this check needs the change installed on Tower, set the status to After install and name who checks it; otherwise finish the work and set it to Met with a file, line and test.`;
}

export const isAfterInstall = status => normalizedStatus(status) === 'after-install';
