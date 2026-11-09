// Issue #855: values specific to this host that must not go into the public repository (an origin, a hostname). Foreman observes the
// value (for example the Origin of the first refused dashboard write), raises ONE inbox item with it filled in, and on approval merges it
// into <state root>/team.local.json: timestamped backup (mode 600), merge, validation, write, then a parse check that restores the backup
// if the written file does not parse. Only the keys in HOST_KEYS can be set this way; the value shape is checked per key.
import fs from 'node:fs';
import path from 'node:path';
// Issue #556: exact lowercase scheme://host[:port] only (browsers send a lowercase Origin), no path, wildcard or credentials. Defined here (a leaf
// module) so the inbox and the team config share one pattern without an import cycle.
export const ORIGIN_PATTERN = /^https?:\/\/[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;

export const LOCAL_FILE = 'team.local.json';
export const REFUSED_FILE = root => path.join(root, 'team', 'refused-origins.json');
const DEFAULT_PORT_ORIGIN = /^http:\/\/[^/]*:80$|^https:\/\/[^/]*:443$/;
// Issue #1115: github_app travels as one string "<app_id>:<installation_id>:<absolute key file>" (the key itself is never a value here).
export const GITHUB_APP_VALUE = /^[1-9]\d{0,14}:[1-9]\d{0,14}:\/[^\s:]{1,200}$/;
export const parseGithubApp = v => { const [a, i, ...k] = String(v).split(':'); return { app_id: Number(a), installation_id: Number(i), key_file: k.join(':') }; };
export const HOST_KEYS = {
  github_app: { list: false, noun: 'GitHub App', check: v => typeof v === 'string' && GITHUB_APP_VALUE.test(v), toValue: parseGithubApp },
  'dashboard.allowed_origins': { list: true, noun: 'dashboard origin', check: v => typeof v === 'string' && ORIGIN_PATTERN.test(v) && !DEFAULT_PORT_ORIGIN.test(v) },
};
export const validateHostValue = (key, value) => Object.hasOwn(HOST_KEYS, key) && HOST_KEYS[key].check(value);

const writeAtomic = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, text, { mode: 0o600 }); fs.chmodSync(temp, 0o600); fs.renameSync(temp, file);
};
const setPath = (obj, key, fn) => {
  const parts = key.split('.'); let o = obj;
  for (const p of parts.slice(0, -1)) { if (!o[p] || typeof o[p] !== 'object' || Array.isArray(o[p])) o[p] = {}; o = o[p]; }
  const last = parts.at(-1); o[last] = fn(o[last]);
};

// Returns { changed, backup }. Throws (the file is left as it was) when the value is not allowed, the file does not parse, validation
// refuses the merged result, or the written file does not parse back.
export function applyHostValue({ root, key, value, validate = () => {}, now = Date.now() }) {
  if (!validateHostValue(key, value)) throw new Error('the host value is not an allowed key or has the wrong shape');
  const file = path.join(root, LOCAL_FILE);
  let text = null;
  try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw new Error('team.local.json is unreadable'); }
  let cur = {};
  if (text !== null) { try { cur = JSON.parse(text); } catch { throw new Error('team.local.json is not valid JSON'); } }
  if (!cur || typeof cur !== 'object' || Array.isArray(cur)) throw new Error('team.local.json is not a JSON object');
  const next = structuredClone(cur);
  setPath(next, key, old => HOST_KEYS[key].list ? [...new Set([...(Array.isArray(old) ? old : []), value])] : (HOST_KEYS[key].toValue ? HOST_KEYS[key].toValue(value) : value));
  if (JSON.stringify(next) === JSON.stringify(cur)) return { changed: false, backup: null };
  validate(next);
  let backup = null;
  if (text !== null) { backup = `${file}.bak-${new Date(now).toISOString().replace(/[:.]/g, '-')}-host`; writeAtomic(backup, text); }
  writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
  try { JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { if (text !== null) writeAtomic(file, text); else fs.rmSync(file, { force: true }); throw new Error('the written file did not parse; the previous file was restored'); }
  return { changed: true, backup: backup ? path.basename(backup) : null };
}

// ---- observation: the dashboard records the Origin of a refused write (only a well-formed origin is kept; bounded; newest last).
export function recordRefusedOrigin(root, origin, now = Date.now()) {
  if (!validateHostValue('dashboard.allowed_origins', origin)) return false;
  const list = readRefusedOrigins(root).filter(r => r.origin !== origin);
  list.push({ origin, at: now });
  try { writeAtomic(REFUSED_FILE(root), JSON.stringify(list.slice(-10)) + '\n'); return true; } catch { return false; }
}
export function readRefusedOrigins(root) {
  try { const l = JSON.parse(fs.readFileSync(REFUSED_FILE(root), 'utf8')); return Array.isArray(l) ? l.filter(r => r && validateHostValue('dashboard.allowed_origins', r.origin)).slice(-10) : []; }
  catch { return []; }
}
// The origin to offer: the first one refused that is not already allowed. Exactly one is offered at a time; the inbox item id is derived from
// the key and value, so it is raised once even if the tick repeats.
export const nextOriginToOffer = (root, allowed = []) => readRefusedOrigins(root).find(r => !allowed.includes(r.origin))?.origin ?? null;
