// Issue #1159: the limit resets the homeowner has on a provider plan, recorded by hand on the dashboard. The captured provider shapes
// (allowance.mjs: Claude rate_limit_event, Codex token_count rate_limits) carry no reset offers, so there is nothing to read them from.
// One record shape for every agent. They live in Foreman state (<root>/limit-resets.json), never in [host].json.
// The dashboard server is the only writer; the tick and the view only read. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicJson } from './core.mjs';

export const LIMITS = ['weekly', 'five_hour'];
export const MAX_RESETS = 200;
const FAMILY = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const file = root => path.join(root, 'limit-resets.json');

// 'all' or a model family name (fable, opus, sonnet), lower case.
export const scopeOf = text => {
  const t = String(text ?? '').trim().toLowerCase();
  return t === 'all' || t === '' ? 'all' : FAMILY.test(t) ? t : null;
};
// A calendar date; the reset is usable through the end of that day (UTC).
export function expiryTime(date) {
  if (!DATE.test(date || '')) return null;
  const start = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(start.getTime()) && start.toISOString().startsWith(date) ? Date.parse(`${date}T23:59:59Z`) : null;   // 2027-02-30 is not a date
}

export function readResets(root) {
  try {
    const v = JSON.parse(fs.readFileSync(file(root), 'utf8'));
    return Array.isArray(v?.resets) ? v.resets.filter(r => r && typeof r.id === 'string' && typeof r.agent === 'string') : [];
  } catch (error) {
    if (error.code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}
const save = (root, resets) => atomicJson(file(root), { version: 1, resets });

// Check one form's fields. Returns { ok: true, fields } or { ok: false, reason }. `agents` are the configured agent names.
export function checkFields(form, agents) {
  const agent = String(form.agent ?? '');
  if (!agents.includes(agent)) return { ok: false, reason: 'unknown agent' };
  const limit = String(form.limit ?? '');
  if (!LIMITS.includes(limit)) return { ok: false, reason: 'the limit must be weekly or five_hour' };
  const scope = scopeOf(form.scope);
  if (scope === null) return { ok: false, reason: 'the model scope must be all or a family name such as fable' };
  const expires = String(form.expires ?? '').trim();
  if (expires && expiryTime(expires) === null) return { ok: false, reason: 'the expiry must be a date, YYYY-MM-DD' };
  return { ok: true, fields: { agent, limit, scope, expires: expires || null } };
}

// Apply one action: add, edit, use, unuse, delete. Returns { ok: true } or { ok: false, reason }.
export function applyReset(root, action, form, { agents, now }) {
  const all = readResets(root);
  const id = String(form.id ?? '');
  const at = all.findIndex(r => r.id === id);
  if (action === 'add') {
    if (all.length >= MAX_RESETS) return { ok: false, reason: 'too many reset records; delete some first' };
    const c = checkFields(form, agents);
    if (!c.ok) return c;
    save(root, [...all, { id: crypto.randomBytes(6).toString('hex'), ...c.fields, usedAt: null, createdAt: now }]);
    return { ok: true };
  }
  if (at < 0) return { ok: false, reason: 'no such reset record' };
  if (action === 'delete') { save(root, all.filter((_, i) => i !== at)); return { ok: true }; }
  if (action === 'use' || action === 'unuse') { all[at] = { ...all[at], usedAt: action === 'use' ? now : null }; save(root, all); return { ok: true }; }
  if (action === 'edit') {
    const c = checkFields({ ...all[at], ...form }, agents);
    if (!c.ok) return c;
    all[at] = { ...all[at], ...c.fields, updatedAt: now };
    save(root, all);
    return { ok: true };
  }
  return { ok: false, reason: 'unknown action' };
}
