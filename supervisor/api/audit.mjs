// Issue #1257: the command audit trail and the idempotency memory. One JSON file in the state root holds the newest 1000 entries (one per
// audited request) and the replies kept for 10 minutes by idempotency key. Reads and writes are synchronous, so within one dashboard process
// a pass cannot interleave with another. The file holds ids, names and the small validated input, never free text beyond the reason.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from '../core.mjs';

export const MAX_ENTRIES = 1000;
export const KEY_TTL_MS = 10 * 60000;
export const SUMMARY_WINDOW_SECONDS = 24 * 3600;
const file = root => path.join(root, 'dashboard', 'command-audit.json');

function load(root) {
  try {
    const log = JSON.parse(fs.readFileSync(file(root), 'utf8'));
    if (Array.isArray(log?.entries) && log.keys && typeof log.keys === 'object') return log;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
  return { entries: [], keys: {} };
}

const freshId = log => {
  for (;;) {
    const id = crypto.randomBytes(4).toString('hex');
    if (!log.entries.some(entry => entry.id === id)) return id;
  }
};

// entry holds everything but id and at. Returns the stored entry; when a key is given its reply is kept so a repeat gets the same answer.
export function append(root, entry, now, remember = null) {
  const log = load(root);
  const stored = { id: freshId(log), at: new Date(now).toISOString(), ...entry };
  log.entries.push(stored);
  if (log.entries.length > MAX_ENTRIES) log.entries.splice(0, log.entries.length - MAX_ENTRIES);
  for (const [key, kept] of Object.entries(log.keys)) if (now - kept.at > KEY_TTL_MS) delete log.keys[key];
  if (remember) log.keys[remember.key] = { at: now, status: remember.status, reply: { ...remember.reply, audit_id: stored.id } };
  atomicJson(file(root), log);
  return stored;
}

// The first reply for this key within 10 minutes, as { status, reply }, else null.
export function replayOf(root, key, now) {
  const kept = load(root).keys[key];
  return kept && now - kept.at <= KEY_TTL_MS && now >= kept.at ? { status: kept.status, reply: kept.reply } : null;
}

// An undo marks the newest entry it reverses: the command's undo_command is the undo, the target is the same and nothing undid it yet.
export function markUndone(root, { undoCommand, targetKey, byId }) {
  const log = load(root);
  const entry = [...log.entries].reverse().find(e => e.undo?.command === undoCommand && e.undo.available && !e.undo.undone_by && e.target?.key === targetKey);
  if (!entry) return null;
  entry.undo = { ...entry.undo, available: false, undone_by: byId };
  atomicJson(file(root), log);
  return entry.id;
}

export const readEntries = root => load(root).entries;
