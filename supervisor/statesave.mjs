// Saving the dispatcher state (team/state.json). Every failed save is printed with the file and the error (stderr reaches
// reconcile.log) and rethrown with both, so callers keep their behaviour and their report names the cause.
// The homeowner gets one "Foreman cannot save state" alert per failing spell, across ticks: production builds a new Team on every
// tick, so the dedupe is a small marker file beside the state file, not a flag in memory. The marker holds the time of the first
// failure and the message. A good save removes it; an alert that was not delivered removes it so the next failing save retries.
// Limit: when the marker itself cannot be written (for example the disk is full) only an in-memory flag stops repeats, so that
// process alerts at most once but a later process may alert again.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson, SupervisorError } from './core.mjs';

export const SAVE_ALERT_PREFIX = 'Foreman cannot save state';
export const MARKER_NAME = 'state-save-failed.json';

const alertedWithoutMarker = new Set();   // state files this process has alerted for while no marker could be written

const markerOf = file => path.join(path.dirname(file), MARKER_NAME);
const readable = error => String(error?.message || error).slice(0, 300);

function markerExists(marker) {
  try {
    return typeof JSON.parse(fs.readFileSync(marker, 'utf8')) === 'object';
  } catch {
    return false;
  }
}

function removeMarker(marker) {
  try {
    fs.unlinkSync(marker);
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`ai-supervisor: cannot remove ${marker}: ${readable(error)}`);
  }
}

function log(line) {
  console.error(line);
}

// Returns true when this failure should send the alert; the marker (or the in-memory flag) is claimed before anything is sent.
function claimAlert(file, message, now) {
  const marker = markerOf(file);
  if (markerExists(marker) || alertedWithoutMarker.has(file)) return false;
  try {
    atomicJson(marker, { firstFailureAt: now(), message });
  } catch (error) {
    log(`ai-supervisor: cannot write ${marker}, so this process alerts at most once: ${readable(error)}`);
    alertedWithoutMarker.add(file);
  }
  return true;
}

function sendAlert(alert, file, message) {
  Promise.resolve()
    .then(() => alert(`${SAVE_ALERT_PREFIX}: ${message}`))
    .catch(error => {
      removeMarker(markerOf(file));
      log(`ai-supervisor: the "${SAVE_ALERT_PREFIX}" alert was not delivered: ${readable(error)}`);
    });
}

// alertOf: returns the alert function now (the team's alert can be replaced after construction) or null.
export function saveState(file, value, { alertOf = () => null, now = Date.now } = {}) {
  try {
    atomicJson(file, value);
  } catch (error) {
    const message = `${file}: ${readable(error)}`;
    log(`ai-supervisor: cannot save state ${message}`);
    const alert = alertOf();
    if (alert && claimAlert(file, message, now)) sendAlert(alert, file, message);
    throw new SupervisorError(`cannot save state ${message}`);
  }
  alertedWithoutMarker.delete(file);
  removeMarker(markerOf(file));
}
