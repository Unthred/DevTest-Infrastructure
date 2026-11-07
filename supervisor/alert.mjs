import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SupervisorError } from './core.mjs';

// Alerts (#47, #50, #947). Every alert is appended to <state root>/team/alerts.jsonl with its level and delivery result.
// Every call names a level (a call without one is refused, and a test scans the source for it):
//   action  Foreman has stopped and only the homeowner can unblock it. Pushed: "Tower | Foreman needs you".
//   problem something failed but Foreman is retrying or working around it. Pushed only after the same cause has lasted
//           alerts.problem_after_minutes, and only when "problem" is in alerts.push_levels: "Tower | Foreman problem".
//   info    upgraded, installed, allowance mode. Never pushed; collected into a daily digest (sendDigest).
// The same cause (its key) is sent once and not repeated while it lasts; repeats only increment a count that the digest shows.
// Delivery uses alerts.command from team.local.json (an absolute program plus arguments, text on stdin, so no secret is ever an
// argument); without it, the Unraid notify script that feeds the AI channel is used. With neither, a pushed alert FAILS
// (delivered=false and an error), so callers see that nothing reached the channel and can retry.
export const UNRAID_NOTIFY = '/usr/local/emhttp/plugins/dynamix/scripts/notify';
export const LEVELS = Object.freeze(['action', 'problem', 'info']);
export const DEFAULT_PUSH_LEVELS = Object.freeze(['action']);
export const DEFAULT_PROBLEM_AFTER_MINUTES = 120;
export const CAUSE_QUIET_MS = 24 * 3600 * 1000;   // a cause that has not been reported for this long is over; the next report is new
export const DIGEST_GAP_MS = 24 * 3600 * 1000;
const SUBJECTS = { action: 'Tower | Foreman needs you', problem: 'Tower | Foreman problem', info: 'Tower | Foreman digest' };

export function validateAlertsConfig(a) {
  const bad = m => { throw new SupervisorError(`invalid team.local.json: alerts: ${m}`); };
  if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['command', 'push_levels', 'problem_after_minutes'].includes(k))) bad('only alerts.command, push_levels and problem_after_minutes may be set');
  if ('command' in a && !(Array.isArray(a.command) && a.command.length && a.command.every(x => typeof x === 'string') && path.isAbsolute(a.command[0]))) bad('alerts.command must be an absolute program plus arguments');
  if ('push_levels' in a && !(Array.isArray(a.push_levels) && a.push_levels.every(l => LEVELS.includes(l)) && new Set(a.push_levels).size === a.push_levels.length)) bad(`push_levels must be a list of ${LEVELS.join(', ')}`);
  if ('problem_after_minutes' in a && !(Number.isInteger(a.problem_after_minutes) && a.problem_after_minutes >= 0 && a.problem_after_minutes <= 10080)) bad('problem_after_minutes must be a whole number of minutes, 0 to 10080');
  return { ...(a.command ? { command: a.command } : {}), ...(a.push_levels ? { push_levels: [...a.push_levels] } : {}), ...(a.problem_after_minutes !== undefined ? { problem_after_minutes: a.problem_after_minutes } : {}) };
}

const files = root => ({ dir: path.join(root, 'team'), log: path.join(root, 'team', 'alerts.jsonl'), state: path.join(root, 'team', 'alert-causes.json') });
function readState(f) { try { const s = JSON.parse(fs.readFileSync(f.state, 'utf8')); return { causes: s.causes || {}, digestAt: s.digestAt ?? null }; } catch { return { causes: {}, digestAt: null }; } }
function writeState(f, s) { fs.writeFileSync(f.state, JSON.stringify(s), { mode: 0o600 }); }
// A key from the text when the caller gave none: digits and hashes removed, so "3 fix rounds" and "4 fix rounds" are one cause.
const defaultKey = (level, text) => `${level}:${String(text).replace(/[0-9a-f]{7,40}/g, '#').replace(/\d+/g, '#').slice(0, 160)}`;

// The link an action alert carries (issue #947): the issue or pull request that holds the Needs you item (the repository page when there is
// none), and the dashboard when self_upgrade.public_dashboard_url is configured.
export function needsLink(config, number = null) {
  const base = config.self_upgrade?.public_dashboard_url;
  return `https://github.com/${config.repository}${number != null ? `/issues/${number}` : ''}${base ? ` ${base.replace(/\/+$/, '')}/` : ''}`;
}

function deliver({ config, notify, run, haveNotify, env }, { subject, text, link, level }) {
  if (config.alerts?.command) { const [program, ...rest] = config.alerts.command; return run(program, rest, { input: text + (link ? `\n${link}` : ''), encoding: 'utf8', timeout: 30000, env }).status === 0; }
  if (haveNotify) return run(notify, ['-e', 'AI agent team', '-s', subject, '-d', (text.slice(0, 450) + (link ? ` ${link}` : '')).slice(0, 500), '-i', level === 'action' ? 'warning' : 'normal'], { encoding: 'utf8', timeout: 30000, env }).status === 0;
  return false;
}

export function alertSender(root, config, { notify = UNRAID_NOTIFY, run = spawnSync, now = () => Date.now() } = {}) {
  return async (text, { level, key, link } = {}) => {
    if (!LEVELS.includes(level)) throw new SupervisorError(`alert without a valid level (${LEVELS.join(', ')}): ${String(text).slice(0, 80)}`);
    const f = files(root); fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
    const at = now(), cause = key ? `${level}:${key}` : defaultKey(level, text), st = readState(f), c = st.causes[cause];
    const push = config.alerts?.push_levels || DEFAULT_PUSH_LEVELS, afterMs = (config.alerts?.problem_after_minutes ?? DEFAULT_PROBLEM_AFTER_MINUTES) * 60000;
    const lasting = c && at - c.last < CAUSE_QUIET_MS;
    const entry = lasting ? { ...c, last: at, count: c.count + 1 } : { first: at, last: at, count: 1, pushedAt: null };
    const log = rec => fs.appendFileSync(f.log, JSON.stringify({ at, level, cause, count: entry.count, text, ...(link ? { link } : {}), ...rec }) + '\n', { mode: 0o600 });
    // Already delivered for this cause and it still lasts: counted, not sent again.
    if (lasting && c.pushedAt) { st.causes[cause] = entry; writeState(f, st); log({ pushed: false, repeat: true, delivered: null }); return; }
    const wanted = level !== 'info' && push.includes(level) && (level === 'action' || at - entry.first >= afterMs);
    if (!wanted) {
      st.causes[cause] = entry; writeState(f, st);
      log({ pushed: false, repeat: Boolean(lasting), delivered: null }); return;
    }
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const haveNotify = !config.alerts?.command && fs.existsSync(notify);
    const delivered = deliver({ config, notify, run, haveNotify, env }, { subject: SUBJECTS[level], text, link, level });
    log({ pushed: true, delivered });
    if (delivered) entry.pushedAt = at;
    st.causes[cause] = entry; writeState(f, st);
    if (!delivered) throw new SupervisorError(config.alerts?.command || haveNotify ? 'alert command failed' : 'no alert channel configured');
  };
}

// The alert history, newest first, for the dashboard and the tests. `levels` filters; nothing else is returned from the log.
export function readAlerts(root, { levels = LEVELS, limit = 200 } = {}) {
  let lines; try { lines = fs.readFileSync(files(root).log, 'utf8').split('\n'); } catch { return []; }
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
    let r; try { r = JSON.parse(lines[i]); } catch { continue; }
    if (r && typeof r === 'object') { const level = LEVELS.includes(r.level) ? r.level : 'action'; if (levels.includes(level)) out.push({ ...r, level }); }   // records from before levels were all pushed as action
  }
  return out;
}

// The daily digest: everything not pushed since the last digest, one line per cause with its count. Sent through the same channel at
// level info; the digest time is recorded only after delivery, so a failing channel retries on the next tick. Returns the lines sent.
export async function sendDigest(root, config, { notify = UNRAID_NOTIFY, run = spawnSync, now = () => Date.now() } = {}) {
  const f = files(root), st = readState(f), at = now();
  if (st.digestAt && at - st.digestAt < DIGEST_GAP_MS) return null;
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  const since = st.digestAt ?? at - DIGEST_GAP_MS, byCause = new Map();
  for (const r of readAlerts(root, { limit: 5000 })) {
    if (r.at < since) break;
    if (r.digest || r.pushed) continue;
    const e = byCause.get(r.cause) || { level: r.level, text: r.text, n: 0 }; e.n++; byCause.set(r.cause, e);
  }
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  if (!byCause.size) { st.digestAt = at; writeState(f, st); return []; }
  const lines = [...byCause.values()].map(e => `[${e.level}] ${String(e.text).replace(/\s+/g, ' ').slice(0, 140)}${e.n > 1 ? ` (x${e.n})` : ''}`);
  const text = `Foreman digest, last 24 h:\n${lines.join('\n')}`;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME }, haveNotify = !config.alerts?.command && fs.existsSync(notify);
  const delivered = deliver({ config, notify, run, haveNotify, env }, { subject: SUBJECTS.info, text, level: 'info' });
  fs.appendFileSync(f.log, JSON.stringify({ at, level: 'info', digest: true, cause: 'digest', count: lines.length, text, pushed: true, delivered }) + '\n', { mode: 0o600 });
  if (!delivered) throw new SupervisorError('digest not delivered');
  st.digestAt = at; writeState(f, st);
  return lines;
}
