// Host-specific local settings that a merged change needs (issue #853). A release whose change needs a value that must not be committed to
// this public repository (a hostname, an origin, a path) ships a migration that exports `settings = [{ key, pr }]`. Foreman raises exactly one
// approval item per (key, PR) at install. The value is filled in from what Foreman can observe (for the dashboard's allowed origins: the
// Origin of the first refused write), the homeowner approves it with one click on the dashboard, and the next tick backs up team.local.json,
// merges the value, checks that the file still parses and validates, and records the result. Nothing is applied without that approval.
// State is <root>/team/local-settings.json (mode 600). Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LOCAL_FILE } from './migrations.mjs';
import { redact } from './redact.mjs';

// The keys a migration may ask for. Each has a value check; the merged file is also validated against the shipped config before it is written.
const ORIGIN = /^https?:\/\/[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:\d{1,5})?$/;
export const SETTINGS = {
  'dashboard.allowed_origins': {
    noun: 'allowed dashboard origin',
    observe: 'refused_origin',
    check: v => typeof v === 'string' && ORIGIN.test(v) && !/^http:\/\/[^/]*:80$|^https:\/\/[^/]*:443$/.test(v),
    merge: (local, v) => { const dash = { ...(local.dashboard || {}) }; const list = Array.isArray(dash.allowed_origins) ? dash.allowed_origins : []; dash.allowed_origins = list.includes(v) ? list : [...list, v]; return { ...local, dashboard: dash }; },
    has: (local, v) => Array.isArray(local.dashboard?.allowed_origins) && local.dashboard.allowed_origins.includes(v),
  },
};
export const ID_RE = /^[a-f0-9]{32}$/;
export const idOf = (key, pr) => crypto.createHash('sha256').update(`setting\n${key}\n${pr}`).digest('hex').slice(0, 32);
const stateFile = root => path.join(root, 'team', 'local-settings.json');
const incidentsFile = root => path.join(root, 'team', 'incidents.jsonl');

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
  fs.writeFileSync(temp, text, { mode: 0o600 }); fs.chmodSync(temp, 0o600); fs.renameSync(temp, file);
}
export function readItems(root) {
  try { const s = JSON.parse(fs.readFileSync(stateFile(root), 'utf8')); return Array.isArray(s.items) ? s.items.filter(i => i && ID_RE.test(i.id || '') && Object.hasOwn(SETTINGS, i.key)) : []; } catch { return []; }
}
const save = (root, items) => writeAtomic(stateFile(root), JSON.stringify({ items }, null, 1) + '\n');
const update = (root, id, patch) => { const items = readItems(root); const i = items.find(x => x.id === id); if (!i) return null; Object.assign(i, patch); save(root, items); return i; };
const incident = (root, now, entry) => { try { fs.mkdirSync(path.dirname(incidentsFile(root)), { recursive: true }); fs.appendFileSync(incidentsFile(root), JSON.stringify({ at: now, kind: 'migration', ...entry }) + '\n', { mode: 0o600 }); } catch { /* the state file is the record */ } };
const hashOf = i => crypto.createHash('sha256').update(JSON.stringify([i.key, i.value, i.pr])).digest('hex').slice(0, 12);

// Raise the one item for (key, pr). Idempotent: a second call, or a later install, never makes a second item. `value` is given only when the
// caller already knows it; otherwise the item waits for an observation. A value already present in team.local.json needs no item.
export function raise(root, { key, pr, value = null, now = Date.now() }) {
  if (!Object.hasOwn(SETTINGS, key)) throw new Error(`unknown setting key ${String(key).slice(0, 60)}`);
  if (!Number.isSafeInteger(pr) || pr < 1) throw new Error('a setting item needs the pull request number');
  const id = idOf(key, pr), items = readItems(root);
  if (items.some(i => i.id === id)) return { id, created: false };
  if (value !== null && !SETTINGS[key].check(value)) throw new Error(`the value for ${key} is not acceptable`);
  items.push({ id, key, pr, value, state: value === null ? 'awaiting' : 'pending', createdAt: now });
  save(root, items);
  incident(root, now, { result: 'setting-raised', key, pr });
  return { id, created: true };
}
// Fill the value of an item that waits for an origin, from the Origin of a refused request. Only the first valid observation counts;
// a pending or decided item is never changed. Returns the item id the origin belongs to, or null.
export function observeOrigin(root, origin, { allowedHost = null, now = Date.now() } = {}) {
  if (typeof origin !== 'string' || !SETTINGS['dashboard.allowed_origins'].check(origin) || (allowedHost && origin === `http://${allowedHost}`)) return null;
  const items = readItems(root);
  const waiting = items.find(i => i.key === 'dashboard.allowed_origins' && i.state === 'awaiting');
  if (waiting) {
    waiting.value = origin; waiting.state = 'pending'; waiting.observedAt = now; save(root, items);
    return waiting.id;
  }
  return items.find(i => i.key === 'dashboard.allowed_origins' && i.state === 'pending' && i.value === origin)?.id || null;
}
// Dashboard cards in the shape of the inbox cards, so the same Approve/Reject form renders them.
export function cards(root) {
  return readItems(root).filter(i => i.state === 'pending').sort((a, b) => a.createdAt - b.createdAt).map(i => ({
    id: i.id, kind: 'setting', title: `Apply setting ${i.key} = ${i.value} needed by PR #${i.pr}`, why: `PR #${i.pr} was merged and needs this local setting to work. The value was observed on this host and is not stored in the repository.`,
    hash: hashOf(i), will: `Back up team.local.json, add ${i.value} to ${i.key}, check that the file still parses and is valid, and record the result. Nothing else changes.`, text: `${i.key} += ${i.value}\nneeded by PR #${i.pr}`,
  }));
}
export const waiting = root => readItems(root).filter(i => i.state === 'awaiting');
export const failed = (root, now = Date.now(), showMs = 3 * 86400000) => readItems(root).filter(i => i.state === 'failed' && now - (i.decidedAt || 0) <= showMs);
export const find = (root, id) => readItems(root).find(i => i.id === id) || null;
// Approve or reject a pending item, once. The value is re-checked at the moment of approval.
export function decide(root, id, decision, now = Date.now()) {
  if (!['approve', 'reject'].includes(decision)) return { ok: false, reason: 'unknown decision' };
  const i = find(root, id);
  if (!i) return { ok: false, reason: 'unknown item' };
  if (i.state !== 'pending') return { ok: false, reason: `the item is already ${i.state}` };
  if (decision === 'approve' && !SETTINGS[i.key].check(i.value)) { update(root, id, { state: 'failed', decidedAt: now, result: 'the value failed the final check' }); return { ok: false, reason: 'the value failed the final check' }; }
  update(root, id, decision === 'approve' ? { state: 'approved', decidedAt: now, approvedHash: hashOf(i) } : { state: 'rejected', decidedAt: now, result: 'rejected by the homeowner; nothing was changed' });
  return { ok: true };
}

// Apply every approved item. For each: read team.local.json, back it up (mode 600), merge, validate, write atomically, re-read and parse it
// (restoring the backup if the check fails), and record the outcome. `validate(next)` throws when the merged file would be invalid.
export function applyApproved(root, { validate = () => {}, now = Date.now() } = {}) {
  const out = [];
  for (const item of readItems(root).filter(i => i.state === 'approved')) {
    const file = path.join(root, LOCAL_FILE), spec = SETTINGS[item.key];
    const fail = reason => { const result = redact(reason, 200); update(root, item.id, { state: 'failed', decidedAt: now, result }); incident(root, now, { result: 'setting-failed', key: item.key, pr: item.pr, error: result }); out.push({ id: item.id, ok: false, result }); };
    if (item.approvedHash !== hashOf(item) || !spec.check(item.value)) { fail('the item changed after it was approved'); continue; }
    let text = '{}', exists = true;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') exists = false; else { fail('team.local.json is unreadable'); continue; } }
    let old; try { old = JSON.parse(text); } catch { fail('team.local.json is not valid JSON'); continue; }
    if (!old || typeof old !== 'object' || Array.isArray(old)) { fail('team.local.json is not an object'); continue; }
    if (spec.has(old, item.value)) { update(root, item.id, { state: 'applied', decidedAt: now, result: 'already present; nothing changed' }); out.push({ id: item.id, ok: true, result: 'already present' }); continue; }
    let next; try { next = spec.merge(structuredClone(old), item.value); validate(next); } catch (error) { fail(`the merged file is invalid: ${String(error?.message || error)}`); continue; }
    const backup = `${file}.bak-${new Date(now).toISOString().replace(/[:.]/g, '-')}-setting-${item.id.slice(0, 8)}`;
    try {
      if (exists) writeAtomic(backup, text);
      writeAtomic(file, JSON.stringify(next, null, 2) + '\n');
      const back = JSON.parse(fs.readFileSync(file, 'utf8'));   // the parse check
      if (!spec.has(back, item.value)) throw new Error('the written file does not contain the value');
    } catch (error) {
      try { if (exists) writeAtomic(file, text); else fs.rmSync(file, { force: true }); } catch { /* the backup beside the file is the way back */ }
      fail(`the written file failed its check and was restored: ${String(error?.message || error)}`); continue;
    }
    update(root, item.id, { state: 'applied', decidedAt: now, result: 'applied', ...(exists ? { backup: path.basename(backup) } : {}) });
    incident(root, now, { result: 'setting-applied', key: item.key, pr: item.pr, ...(exists ? { backup: path.basename(backup) } : {}) });
    out.push({ id: item.id, ok: true, result: 'applied' });
  }
  return out;
}

// A "Homeowner steps" section of a pull request body or job report: the lines under that heading up to the next heading (issue #853).
export function homeownerSteps(body) {
  const lines = String(body ?? '').replace(/\r/g, '').split('\n'), start = lines.findIndex(l => /^\s{0,3}#{1,6}\s*homeowner steps\s*:?\s*$/i.test(l));
  if (start < 0) return [];
  const steps = [];
  for (const l of lines.slice(start + 1)) {
    if (/^\s{0,3}#{1,6}\s/.test(l)) break;
    const m = /^\s*(?:[-*]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.+)$/.exec(l);
    if (m) steps.push({ text: m[2].trim().slice(0, 300), done: m[1] === 'x' || m[1] === 'X' });
  }
  return steps;
}
