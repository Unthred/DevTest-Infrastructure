// Sending a homeowner alert and recording that it was sent are two outcomes, reported apart. A channel that refused the alert is
// a delivery failure: nothing is recorded and a later tick retries. A delivered alert is marked sent in memory first, so this
// process never sends it again, and only then saved; a failing save is reported as a save failure, never as a delivery failure.
// Calling the save failure a delivery failure is what let one delivered alert be re-sent on every tick.
const messageOf = error => String(error?.message || error).slice(0, 200);

function skip(report, what, reason, log) {
  (report.skipped ||= []).push({ what, reason });
  log(`ai-supervisor: ${what}: ${reason}`);
}

// team: { alert, save }. sent: marks the alert as sent in state (omitted for an alert that is never retried). level: issue #1421; none means action.
export async function alertThenRecord(team, { report, what, text, sent = null, level = undefined, log = line => console.error(line) }) {
  if (!team.alert) return false;
  try {
    await team.alert(text, level ? { level } : undefined);
  } catch (error) {
    skip(report, what, `alert delivery failed${sent ? '; will retry' : ''}: ${messageOf(error)}`, log);
    return false;
  }
  if (!sent) return true;
  sent();
  try {
    team.save();
  } catch (error) {
    skip(report, what, `alert delivered; saving that it was sent failed: ${messageOf(error)}`, log);
  }
  return true;
}
