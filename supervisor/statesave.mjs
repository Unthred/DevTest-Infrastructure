// Saving the dispatcher state (team/state.json). Every failed save is printed with the file and the error (stderr reaches
// reconcile.log) and rethrown with both, so callers keep their behaviour and their report names the cause. The homeowner gets
// one "Foreman cannot save state" alert per failing spell: once per process until a save succeeds again, so a save that keeps
// failing cannot turn every tick into an alert. The alert is sent in the background because a save is synchronous.
import { atomicJson, SupervisorError } from './core.mjs';

export const SAVE_ALERT_PREFIX = 'Foreman cannot save state';

// alertOf: returns the alert function now (the team's alert can be replaced after construction) or null.
export function stateSaver({ file, alertOf = () => null, write = atomicJson, log = line => console.error(line) }) {
  let alerting = false;
  const raise = message => {
    const alert = alertOf();
    if (alerting || !alert) return;
    alerting = true;
    Promise.resolve()
      .then(() => alert(`${SAVE_ALERT_PREFIX}: ${message}`))
      .catch(error => {
        alerting = false;
        log(`ai-supervisor: the "${SAVE_ALERT_PREFIX}" alert was not delivered: ${String(error?.message || error)}`);
      });
  };
  return value => {
    try {
      write(file, value);
    } catch (error) {
      const message = `${file}: ${String(error?.message || error).slice(0, 300)}`;
      log(`ai-supervisor: cannot save state ${message}`);
      raise(message);
      throw new SupervisorError(`cannot save state ${message}`);
    }
    alerting = false;
  };
}
