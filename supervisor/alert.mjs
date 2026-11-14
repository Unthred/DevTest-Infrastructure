import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';

// Alerts (#47, #50). Every alert, delivered or not, is appended to <state root>/team/alerts.jsonl with its delivery result.
// The channel is named in team.local.json and there is no default. It is either alerts.command (an absolute program plus
// arguments, text on stdin, so no secret is ever an argument) or alerts.channel "unraid" (the Unraid notify script that feeds
// the AI channel). A default to the real notify script let every live tick a test started on Tower notify the homeowner, and the
// state root's path cannot tell production from a test (/mnt/user and /mnt/cache name the same files). Under the Node test runner
// the real notify script is refused even when configured. A refused or failed delivery is recorded with its reason, printed to
// stderr (which reaches reconcile.log) and thrown, so callers see that nothing reached the channel and can retry.
export const UNRAID_NOTIFY = '/usr/local/emhttp/plugins/dynamix/scripts/notify';
export const ALERT_CHANNELS = ['unraid'];
const NO_CHANNEL = 'no alert channel configured: set alerts.channel to "unraid" or alerts.command in team.local.json';
const TEST_RUN = 'the Unraid notify script is never used from a test run';
const SHAPE = 'invalid team.local.json: alerts must set exactly one of alerts.command (an absolute program plus arguments) or alerts.channel ("unraid"), and may set alerts.notify_levels';

// Issue #1421: every alert has a level. action: the homeowner must decide or do something. problem: something failed and Foreman is
// handling or retrying it. info: something routine happened. A caller that gives no level gets action, so nothing that notifies
// today goes quiet by accident. Only the levels in alerts.notify_levels reach the channel; every level is written to the alert log.
export const ALERT_LEVELS = ['action', 'problem', 'info'];
export const DEFAULT_LEVEL = 'action';
export const DEFAULT_NOTIFY_LEVELS = ['action', 'problem'];
const SUBJECTS = { action: 'Tower | Foreman needs you', problem: 'Tower | Foreman problem' };
const ICONS = { action: 'warning', problem: 'normal' };
const BAD_LEVELS = `invalid team.local.json: alerts.notify_levels must be a list of levels from: ${ALERT_LEVELS.join(', ')}`;

export function checkLevel(level) {
  if (!ALERT_LEVELS.includes(level)) throw new SupervisorError(`unknown alert level ${JSON.stringify(level)}: use one of ${ALERT_LEVELS.join(', ')}`);
  return level;
}

// The alerts section of team.local.json, validated. Throws on anything else. Pure.
export function validateAlertsConfig(alerts) {
  const all = alerts && typeof alerts === 'object' && !Array.isArray(alerts) ? Object.keys(alerts) : [];
  const keys = all.filter(k => k !== 'notify_levels');
  if (keys.length !== 1) throw new SupervisorError(SHAPE);
  const levels = 'notify_levels' in alerts ? { notify_levels: validNotifyLevels(alerts.notify_levels) } : {};
  if (keys[0] === 'channel') {
    const allowed = ALERT_CHANNELS.join(', ');
    if (!ALERT_CHANNELS.includes(alerts.channel)) throw new SupervisorError(`invalid team.local.json: alerts.channel must be one of: ${allowed}`);
    return { channel: alerts.channel, ...levels };
  }
  const cmd = alerts.command;
  const valid = keys[0] === 'command' && Array.isArray(cmd) && cmd.length > 0 && cmd.every(x => typeof x === 'string') && path.isAbsolute(cmd[0]);
  if (!valid) throw new SupervisorError(SHAPE);
  return { command: cmd, ...levels };
}

function validNotifyLevels(list) {
  if (!Array.isArray(list) || !list.every(x => ALERT_LEVELS.includes(x))) throw new SupervisorError(BAD_LEVELS);
  return [...new Set(list)];
}

// Whether an alert of this level goes to the channel. Pure.
export const isSentLevel = (alerts, level) => (alerts?.notify_levels ?? DEFAULT_NOTIFY_LEVELS).includes(level);

// How one alert is delivered ({ program, args, input }) or why it is not ({ refused }). Pure.
export function alertRoute(alerts, text, { notify = UNRAID_NOTIFY, testRun = false, level = DEFAULT_LEVEL } = {}) {
  if (alerts?.command) return { program: alerts.command[0], args: alerts.command.slice(1), input: `${level}\n${text}` };
  if (alerts?.channel !== 'unraid') return { refused: NO_CHANNEL };
  if (testRun && notify === UNRAID_NOTIFY) return { refused: TEST_RUN };
  const args = ['-e', 'AI agent team', '-s', SUBJECTS[level] ?? SUBJECTS.action, '-d', text.slice(0, 500), '-i', ICONS[level] ?? ICONS.action];
  return { program: notify, args, input: undefined };
}

// Why a finished delivery command did not deliver, or null when it did.
function deliveryError(result) {
  if (result.status === 0) return null;
  if (result.error) return `alert command failed: ${result.error.code || result.error.message}`;
  return `alert command failed: exit ${result.status ?? result.signal}`;
}

// The alert log line is written after delivery, so a failed write (no directory, full disk, permission denied) must not turn a
// delivered alert into a failure: the caller would send it again on every tick. The write failure is printed instead.
function recordAlert(root, row, log) {
  try {
    const dir = path.join(root, 'team');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(path.join(dir, 'alerts.jsonl'), JSON.stringify(row) + '\n', { mode: 0o600 });
  } catch (error) {
    const outcome = row.delivered ? 'alert delivered but not recorded' : 'alert not delivered and not recorded';
    log(`ai-supervisor: ${outcome}: ${error.message}`);
  }
}

export function alertSender(root, config, { notify = UNRAID_NOTIFY, run = spawnSync, env = process.env, log = line => console.error(line) } = {}) {
  return async (text, { level = DEFAULT_LEVEL } = {}) => {
    checkLevel(level);
    if (!isSentLevel(config.alerts, level)) {   // not sent by rule: recorded as skipped and never thrown, so no caller retries it
      recordAlert(root, { at: Date.now(), text, level, delivered: false, skipped: `level ${level} is not in alerts.notify_levels` }, log);
      return;
    }
    const route = alertRoute(config.alerts, text, { notify, testRun: Boolean(env.NODE_TEST_CONTEXT), level });
    const childEnv = { PATH: env.PATH, HOME: env.HOME };
    const error = route.refused ?? deliveryError(run(route.program, route.args, { input: route.input, encoding: 'utf8', timeout: 30000, env: childEnv }));
    const row = error ? { at: Date.now(), text, level, delivered: false, error } : { at: Date.now(), text, level, delivered: true };
    recordAlert(root, row, log);
    if (!error) return;
    log(`ai-supervisor: alert not delivered: ${error}`);
    throw new SupervisorError(error);
  };
}
