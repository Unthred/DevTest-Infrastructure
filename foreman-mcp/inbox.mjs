// The one write the MCP server can make (issue #124, D-031 proposed): a proposal file in <inboxDir>/items/. The file name is generated here
// (32 hex characters), never taken from the caller, so a call cannot name a path. Nothing is run, changed or approved by writing it:
// Foreman validates the item again, shows it on the dashboard and acts only after the homeowner approves it there. Status is read back
// from <inboxDir>/status/, which only Foreman writes. This module imports nothing from supervisor/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redact } from './redact.mjs';

export const LIMITS = { title: 200, prompt: 8000, body: 8000, why: 400, reason: 300, waiting: 30, action: 40, target: 40 };
const ACTIONS = { new_review_attempt: /^[1-9]\d{0,8}$/, clear_retry_cap: /^[1-9]\d{0,8}$/, reopen: /^[1-9]\d{0,8}$/, close_job: /^[a-f0-9]{8}$/, stop_job: /^[a-f0-9]{8}$/, resume_job: /^[a-f0-9]{8}$/ };   // issue #629: the names Foreman accepts
const ID_RE = /^[a-f0-9]{32}$/;
const ATTRIBUTION = [/\bgenerated (?:with|by)\b[^\n]{0,60}\b(?:claude|codex|gpt|openai|anthropic|copilot|gemini|ai)\b/i, /\bco-authored-by:/i, /\bnoreply@anthropic\.com\b/i, /\bclaude\.ai\/code\b/i];

// Refuses early what Foreman would refuse later, so the overseer learns at once. Returns { ok, item } or { ok:false, error }.
export function checkProposal(args) {
  const a = args && typeof args === 'object' ? args : {};
  const kind = a.kind;
  if (!['prompt', 'issue_draft', 'action'].includes(kind)) return { ok: false, error: 'kind must be "prompt", "issue_draft" or "action"' };
  const bodyKey = kind === 'prompt' ? 'prompt' : kind === 'action' ? 'reason' : 'body', allowed = kind === 'action' ? ['kind', 'title', 'action', 'target', 'reason'] : ['kind', 'title', bodyKey, 'why'];
  const extra = Object.keys(a).filter(k => !allowed.includes(k));
  if (extra.length) return { ok: false, error: `unknown argument: ${extra.slice(0, 3).map(k => String(k).replace(/[^\w-]/g, '?').slice(0, 20)).join(', ')}` };
  const item = { kind };
  for (const k of allowed.filter(k => k !== 'kind')) {
    const v = a[k];
    if (v === undefined && k === 'why') continue;
    if (typeof v !== 'string' || !v.trim()) return { ok: false, error: `${k} must be a non-empty string` };
    if (v.length > (LIMITS[k] ?? 40)) return { ok: false, error: `${k} is longer than ${LIMITS[k]} characters` };
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) return { ok: false, error: `${k} contains control characters` };
    if (redact(v) !== v) return { ok: false, error: `${k} contains secret-shaped text; remove it` };
    if (ATTRIBUTION.some(re => re.test(v))) return { ok: false, error: `${k} contains AI attribution text, which this project does not allow` };
    item[k] = v;
  }
  if (/[\r\n]/.test(item.title)) return { ok: false, error: 'title must be one line' };
  if (kind === 'action') {
    if (!Object.hasOwn(ACTIONS, item.action)) return { ok: false, error: `action must be one of: ${Object.keys(ACTIONS).join(', ')}` };
    if (!ACTIONS[item.action].test(item.target)) return { ok: false, error: 'target must be a pull request or issue number, or the 8-character job id' };
  }
  return { ok: true, item };
}

export function createInbox({ dir, baseUrl = null }) {
  // Issue #977: the dashboard link for an item, so the overseer can pass it on. Absent when no dashboard address is configured.
  const linkFor = id => { try { return baseUrl ? new URL(`/inbox/${id}`, baseUrl).href : null; } catch { return null; } };
  const items = dir ? path.join(dir, 'items') : null, status = dir ? path.join(dir, 'status') : null;
  // Issue #943: counted the way Foreman counts. Waiting = items Foreman holds as pending (from status/) plus item files it has not picked up yet.
  // Finished items (done, rejected, refused, failed) do not count, whatever files remain. The limit is the one Foreman published in status/limits.json.
  function waiting() {
    let names; try { names = fs.readdirSync(items); } catch { throw new Error('the inbox directory is not available'); }
    let pending = 0, unpicked = 0;
    for (const n of names) {
      const m = /^([a-f0-9]{32})\.json$/.exec(n); if (!m) continue;
      let s = null; try { s = JSON.parse(fs.readFileSync(path.join(status, `${m[1]}.json`), 'utf8')); } catch { /* none yet */ }
      if (!s) unpicked++; else if (s.state === 'pending') pending++;
    }
    let limit = LIMITS.waiting; try { const l = JSON.parse(fs.readFileSync(path.join(status, 'limits.json'), 'utf8')).pending; if (Number.isSafeInteger(l) && l >= 1 && l <= 200) limit = l; } catch { /* default */ }
    return { pending, unpicked, total: pending + unpicked, limit };
  }
  return {
    enabled: !!dir,
    propose(args) {
      if (!dir) throw new Error('the inbox is not configured on this server');
      const c = checkProposal(args);
      if (!c.ok) throw new Error(c.error);
      const w = waiting(); if (w.total >= w.limit) throw new Error(`the inbox is full: ${w.total} items are waiting (${w.pending} for the homeowner's decision, ${w.unpicked} not yet picked up by Foreman); the limit is ${w.limit}. Wait for the homeowner to decide some`);
      const id = crypto.randomBytes(16).toString('hex'), file = path.join(items, `${id}.json`);
      fs.writeFileSync(file, JSON.stringify(c.item) + '\n', { flag: 'wx', mode: 0o600 });
      return { id, shortId: id.slice(0, 8), link: linkFor(id), state: 'submitted', note: 'Foreman validates the item, then the homeowner approves or rejects it on the dashboard. Read the outcome with foreman_proposal_status.' };
    },
    status(id) {
      if (!dir) throw new Error('the inbox is not configured on this server');
      if (/^[a-f0-9]{8}$/.test(String(id))) {   // the short id the dashboard shows: resolved only when exactly one item starts with it
        // Foreman deletes items/<id>.json once an item is finished, so status/ is searched as well.
        const found = new Set();
        for (const d of [items, status]) {
          let names = []; try { names = fs.readdirSync(d); } catch { /* none */ }
          for (const n of names) if (n.startsWith(id) && /^[a-f0-9]{32}\.json$/.test(n)) found.add(n.slice(0, 32));
        }
        if (found.size !== 1) throw new Error(found.size ? 'more than one item starts with that id; use the full id' : 'no such item');
        id = [...found][0];
      }
      if (!ID_RE.test(String(id))) throw new Error('id must be the 32-character id returned by foreman_propose (or its first 8 characters)');
      let s = null; try { s = JSON.parse(fs.readFileSync(path.join(status, `${id}.json`), 'utf8')); } catch { /* none yet */ }
      if (!s) {
        if (!fs.existsSync(path.join(items, `${id}.json`))) throw new Error('no such item');
        return { id, shortId: id.slice(0, 8), link: linkFor(id), state: 'waiting', note: 'Foreman has not picked this item up yet (it does so on its next tick).' };
      }
      return { id, shortId: id.slice(0, 8), link: linkFor(id), state: s.state, kind: s.kind ?? null, reason: s.reason ?? null, result: s.result ?? null, decidedAt: s.decidedAt ? new Date(s.decidedAt).toISOString() : null, updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null, issue: s.issue ?? null, job: s.job ?? null };
    },
  };
}
