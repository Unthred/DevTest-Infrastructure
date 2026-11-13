// Issue #1306: the record of reasons for closed issues, one file under the Foreman state root, keyed by issue number.
//   { "version": 1, "startedAt": <ms>, "reasons": { "895": { "reason": "...", "at": <ms>, "call": "<audit id>" } } }
// The start time is written once, by the first pass after install, and never moved. A file that cannot be read is reported, never treated as empty.
import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './core.mjs';
import { closedReasonItem, ITEM_ID } from './closedreason.mjs';

export const recordFile = root => path.join(root, 'team', 'closed-reasons.json');
const EMPTY = () => ({ version: 1, startedAt: null, reasons: {} });
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// { record } or { error }. A missing or zero-length file is a record with nothing in it; any other text that is not a record is an error.
export function readRecord(root) {
  let text;
  try { text = fs.readFileSync(recordFile(root), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return { record: EMPTY() };
    return { error: `the record of close reasons cannot be read (${error.code || 'error'})` };
  }
  if (!text.trim()) return { record: EMPTY() };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { error: 'the record of close reasons is not valid JSON' }; }
  const startOk = parsed?.startedAt === null || Number.isFinite(parsed?.startedAt);
  if (!isObject(parsed) || !isObject(parsed.reasons) || !startOk) return { error: 'the record of close reasons has the wrong shape' };
  return { record: { version: 1, startedAt: parsed.startedAt ?? null, reasons: parsed.reasons } };
}

const write = (root, record) => {
  fs.mkdirSync(path.dirname(recordFile(root)), { recursive: true, mode: 0o700 });
  atomicJson(recordFile(root), record);
};

// Writes the start time when there is none. Returns it. A damaged record is left as it is and gives null.
export function ensureStartedAt(root, now) {
  const read = readRecord(root);
  if (read.error) return null;
  if (read.record.startedAt !== null) return read.record.startedAt;
  write(root, { ...read.record, startedAt: now });
  return now;
}

// Adds one reason. Returns { ok: true } or { ok: false, why } for a damaged record or a number that already has one.
export function addReason(root, number, entry) {
  const read = readRecord(root);
  if (read.error) return { ok: false, why: read.error };
  if (Object.hasOwn(read.record.reasons, String(number))) return { ok: false, why: 'a reason is already recorded' };
  write(root, { ...read.record, reasons: { ...read.record.reasons, [String(number)]: entry } });
  return { ok: true };
}

// The attention items for the dashboard view: the grouped item, or one fault item when the record cannot be read.
export function closedReasonAttention(root, issues) {
  const read = readRecord(root);
  if (read.error) {
    const text = `Foreman cannot tell which closed issues have a recorded reason: ${read.error}.`;
    const action = 'Repair or remove team/closed-reasons.json under the Foreman state root.';
    return [{ id: `${ITEM_ID}-unreadable`, text, ref: null, severity: 'action', action }];
  }
  const item = closedReasonItem({ issues, record: read.record, startedAt: read.record.startedAt });
  return item ? [item] : [];
}
