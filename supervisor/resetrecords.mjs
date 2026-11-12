// Issue #1162: the homeowner's limit reset records, kept in Foreman state (<state root>/team/limit-resets.json), never in team.local.json.
// Source finding (documented in docs/supervisor.md): the captured provider readings (allowance.mjs, probe.mjs) carry only windows with use and reset
// time. No reset offer, count or expiry is reported, so the homeowner adds, edits, marks used and deletes records on the dashboard.
// The same shape serves every agent. Only the dashboard's write route changes this file; the tick keeps its own bookkeeping in resets-seen.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from './core.mjs';

export const LIMITS = ['weekly', 'five_hour'];
export const MAX_RECORDS = 60;
const SCOPE_RE = /^(all|[a-z][a-z0-9_-]{1,23})$/;
const NOTE_MAX = 120;

const file = root => path.join(root, 'team', 'limit-resets.json');

export function readRecords(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file(root), 'utf8'));
    return Array.isArray(parsed?.records) ? parsed.records.filter(record => typeof record?.id === 'string') : [];
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}

function writeRecords(root, records) {
  fs.mkdirSync(path.dirname(file(root)), { recursive: true, mode: 0o700 });
  atomicJson(file(root), { version: 1, records });
}

// Checks the fields of one record. `expiry` is an ISO date or date-time, or empty for a reset that does not lapse.
export function checkFields(input, agentNames) {
  const agent = String(input?.agent ?? '');
  if (!agentNames.includes(agent)) return { ok: false, reason: 'unknown agent' };
  const limit = String(input?.limit ?? '');
  if (!LIMITS.includes(limit)) return { ok: false, reason: 'limit must be weekly or five_hour' };
  const scope = String(input?.scope ?? 'all').trim().toLowerCase() || 'all';
  if (!SCOPE_RE.test(scope)) return { ok: false, reason: 'scope must be "all" or a model family name such as fable' };
  const rawExpiry = String(input?.expiry ?? '').trim();
  const expiry = rawExpiry ? Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(rawExpiry) ? `${rawExpiry}T23:59:59Z` : rawExpiry) : null;
  if (rawExpiry && !Number.isFinite(expiry)) return { ok: false, reason: 'expiry is not a date (use YYYY-MM-DD)' };
  const note = String(input?.note ?? '').replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX);
  return { ok: true, fields: { agent, limit, scope, expiry, ...(note ? { note } : {}) } };
}

export function addRecord(root, input, agentNames, now) {
  const checked = checkFields(input, agentNames);
  if (!checked.ok) return checked;
  const records = readRecords(root);
  if (records.length >= MAX_RECORDS) return { ok: false, reason: `at most ${MAX_RECORDS} records; delete some first` };
  const record = { id: crypto.randomBytes(4).toString('hex'), ...checked.fields, state: 'available', createdAt: now };
  writeRecords(root, [...records, record]);
  return { ok: true, record };
}

function change(root, id, apply) {
  const records = readRecords(root);
  const index = records.findIndex(record => record.id === id);
  if (index < 0) return { ok: false, reason: 'unknown reset' };
  const result = apply(records[index]);
  if (!result.ok) return result;
  const next = result.record ? records.map((record, i) => (i === index ? result.record : record)) : records.filter((_, i) => i !== index);
  writeRecords(root, next);
  return { ok: true, record: result.record ?? null, previous: records[index] };
}

// The form always posts every field, so an edit replaces them all; the id, state and creation time stay.
export function editRecord(root, id, input, agentNames) {
  return change(root, id, current => {
    const checked = checkFields(input, agentNames);
    if (!checked.ok) return checked;
    const { note, ...kept } = current;
    return { ok: true, record: { ...kept, ...checked.fields } };
  });
}

export function markUsed(root, id, now) {
  return change(root, id, current => (current.state === 'used' ? { ok: false, reason: 'already marked used' } : { ok: true, record: { ...current, state: 'used', usedAt: now } }));
}

export function deleteRecord(root, id) {
  return change(root, id, () => ({ ok: true, record: null }));
}
