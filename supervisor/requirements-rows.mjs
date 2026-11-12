// Judges one row of the PR "Requirements check" table (issue #1177).
// Rows from the issue's "before the PR" list must be Met (or Homeowner-only with the stated reason).
// Rows from the "after install" list can only be checked once the change runs on Tower: they use After install
// and do not fail the pr_opened post condition. They stay visible so each becomes a Needs you step after install.
export const normalizedStatus = value => String(value || '').trim().toLowerCase().replace(/\s+/g, '-');

const HOMEOWNER_REASON = /credentials|approval|physical action/i;
const AFTER_INSTALL_CHECKER = /\b(homeowner|overseer)\b/i;

export const ALLOWED_STATUSES = 'Met, Homeowner-only (evidence names the required credentials, approval or physical action), or After install (evidence names who checks it: homeowner or overseer)';

export function rowRefusal(requirement, status, evidence) {
  const named = `requirement "${String(requirement).slice(0, 160)}"`;
  const kind = normalizedStatus(status);
  if (kind === 'met') return null;
  if (kind === 'homeowner-only') {
    if (HOMEOWNER_REASON.test(evidence)) return null;
    return `${named} is Homeowner-only but its evidence does not state the required credentials, approval or physical action. Allowed statuses: ${ALLOWED_STATUSES}. State the specific credentials, approval or physical action in the evidence. If this check can only be made once the change is installed on Tower, set the status to After install instead and name who checks it.`;
  }
  if (kind === 'after-install') {
    if (AFTER_INSTALL_CHECKER.test(evidence)) return null;
    return `${named} is After install but its evidence does not say who checks it. Allowed statuses: ${ALLOWED_STATUSES}. Name the homeowner or overseer in the evidence.`;
  }
  return `${named} is ${status}. Allowed statuses: ${ALLOWED_STATUSES}. If this check needs the change installed on Tower, set the status to After install and name who checks it; otherwise finish the work and set it to Met with a file, line and test.`;
}

export const isAfterInstall = status => normalizedStatus(status) === 'after-install';
