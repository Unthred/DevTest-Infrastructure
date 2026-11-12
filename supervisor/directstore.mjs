// Issue #1164: the files behind direct control, kept in the inbox folder next to the inbox audit log. Foreman and the dashboard write them; the MCP
// account only reads them, through the dashboard view. Three files: the audit trail (JSON lines), the switch, and the undo requests the dashboard
// leaves for the next pass. Node built-ins only. Nothing here decides anything: it reads and appends.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redactLong } from './redact.mjs';

const MAX_AUDIT_BYTES = 2 * 1024 * 1024;
const TEXT_CHARS = 400;
export const AUDIT_ID = /^[a-f0-9]{16}$/;
export const files = dir => ({ audit: path.join(dir, 'direct-audit.jsonl'), sw: path.join(dir, 'direct-switch.json'), undo: path.join(dir, 'direct-undo') });
const clip = t => redactLong(String(t ?? '').replace(/\s+/g, ' '), TEXT_CHARS, ' [cut]').trim();
const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// Direct control is on unless the homeowner switched it off on the dashboard.
export function readSwitch(dir) {
  const s = readJson(files(dir).sw);
  return { enabled: s?.enabled !== false, at: Number.isFinite(s?.at) ? s.at : null, by: s?.by ? clip(s.by) : null };
}
export function writeSwitch(dir, enabled, now, by = 'homeowner') {
  const file = files(dir).sw, temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, JSON.stringify({ enabled: enabled === true, at: now, by }) + '\n', { mode: 0o644, flag: 'wx' });
  fs.renameSync(temp, file);
  appendAudit(dir, { at: now, by, action: enabled ? 'switch_on' : 'switch_off', target: 'direct control', outcome: 'done', changed: true,
    text: enabled ? 'direct control turned on' : 'direct control turned off' });
}

// Appends one record and returns it with its id. The audit trail must not stop a pass, so a failed write returns null (the item status is the record).
export function appendAudit(dir, entry) {
  const rec = { id: crypto.randomBytes(8).toString('hex'), ...entry };
  try {
    const file = files(dir).audit;
    try { if (fs.statSync(file).size > MAX_AUDIT_BYTES) fs.renameSync(file, `${file}.1`); } catch { /* none yet */ }
    fs.appendFileSync(file, JSON.stringify(rec) + '\n', { mode: 0o644 });
    return rec;
  } catch { return null; }
}

function readLines(dir) {
  let text = '';
  try { text = fs.readFileSync(files(dir).audit, 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(r => r && AUDIT_ID.test(r.id || ''));
}
const reversedBy = (all, id) => all.find(r => r.action === 'undo' && r.outcome === 'done' && r.of === id) || null;

// Newest first. `undoable` is true for a successful, changing record with a reverse step that has not been reversed. Text is redacted and bounded again.
export function readAudit(dir, limit = 100) {
  const all = readLines(dir);
  const view = r => ({
    id: r.id, at: r.at, by: clip(r.by), action: clip(r.action), target: clip(r.target), value: r.value == null ? null : clip(r.value),
      reason: r.reason == null ? null : clip(r.reason),
    outcome: r.outcome === 'done' ? 'done' : r.outcome === 'refused' ? 'refused' : 'failed', changed: r.changed === true, before: r.before ?? null,
      after: r.after ?? null, text: clip(r.text),
    of: r.of ?? null, undone: !!reversedBy(all, r.id), undoable: r.outcome === 'done' && r.changed === true && !!r.undo && !reversedBy(all, r.id),
  });
  return all.slice(-limit).reverse().map(view);
}
export const findRecord = (dir, id) => readLines(dir).find(r => r.id === id) || null;
export const isReversed = (dir, id) => !!reversedBy(readLines(dir), id);

// The dashboard leaves a request; the next pass reverses the action. A second request for the same record changes nothing.
export function requestUndo(dir, auditId, now) {
  if (!AUDIT_ID.test(String(auditId))) return { ok: false, reason: 'unknown record' };
  const rec = findRecord(dir, auditId);
  if (!rec) return { ok: false, reason: 'unknown record' };
  if (rec.outcome !== 'done' || rec.changed !== true || !rec.undo) return { ok: false, reason: 'that action changed nothing, so there is nothing to undo' };
  if (isReversed(dir, auditId)) return { ok: false, reason: 'that action was already undone' };
  fs.mkdirSync(files(dir).undo, { recursive: true, mode: 0o755 });
  try { fs.writeFileSync(path.join(files(dir).undo, `${auditId}.json`), JSON.stringify({ at: now }) + '\n', { mode: 0o644,
    flag: 'wx' }); } catch { return { ok: false, reason: 'an undo of that action is already waiting' }; }
  return { ok: true };
}
export function pendingUndos(dir) {
  try { return fs.readdirSync(files(dir).undo).map(n => /^([a-f0-9]{16})\.json$/.exec(n)?.[1]).filter(Boolean).sort(); } catch { return []; }
}
export function clearUndo(dir, auditId) { try { fs.unlinkSync(path.join(files(dir).undo, `${auditId}.json`)); } catch { /* already gone */ } }
