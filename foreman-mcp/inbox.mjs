// The one write the MCP server can make (issue #124, D-031 proposed): a proposal file in <inboxDir>/items/. The file name is generated here
// (32 hex characters), never taken from the caller, so a call cannot name a path. Nothing is run, changed or approved by writing it:
// Foreman validates the item again, shows it on the dashboard and acts only after the homeowner approves it there. Status is read back
// from <inboxDir>/status/, which only Foreman writes. This module imports nothing from supervisor/.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { redact } from './redact.mjs';

export const LIMITS = { title: 200, prompt: 8000, body: 8000, why: 400, reason: 300, items: 60, action: 40, target: 40 };
const ACTIONS = { new_review_attempt: /^[1-9]\d{0,8}$/, reopen: /^[1-9]\d{0,8}$/, close_job: /^[a-f0-9]{8}$/, stop_job: /^[a-f0-9]{8}$/, resume_job: /^[a-f0-9]{8}$/, pause_work: /^new$/, resume_work: /^new$/, restart_dashboard: /^dashboard$/, retry_install: /^install$/, run_tests: /^[0-9a-f]{40}$/, allowance_probe: /^[a-z][a-z0-9_-]{0,29}$/ };   // issue #629: the names Foreman accepts   // items: files in the directory at once (Foreman removes finished ones)
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
    if (!ACTIONS[item.action].test(item.target)) return { ok: false, error: 'target does not fit the action (a pull request or issue number, the 8-character job id, new, dashboard, install, a 40-character commit id, or an agent name)' };
  }
  return { ok: true, item };
}

export function createInbox({ dir }) {
  const items = dir ? path.join(dir, 'items') : null, status = dir ? path.join(dir, 'status') : null;
  return {
    enabled: !!dir,
    propose(args) {
      if (!dir) throw new Error('the inbox is not configured on this server');
      const c = checkProposal(args);
      if (!c.ok) throw new Error(c.error);
      let count = 0; try { count = fs.readdirSync(items).length; } catch { throw new Error('the inbox directory is not available'); }
      if (count >= LIMITS.items) throw new Error('the inbox is full; wait for the homeowner to decide the waiting items');
      const id = crypto.randomBytes(16).toString('hex'), file = path.join(items, `${id}.json`);
      fs.writeFileSync(file, JSON.stringify(c.item) + '\n', { flag: 'wx', mode: 0o600 });
      return { id, state: 'submitted', note: 'Foreman validates the item, then the homeowner approves or rejects it on the dashboard. Read the outcome with foreman_proposal_status.' };
    },
    status(id) {
      if (!dir) throw new Error('the inbox is not configured on this server');
      if (!ID_RE.test(String(id))) throw new Error('id must be the 32-character id returned by foreman_propose');
      let s = null; try { s = JSON.parse(fs.readFileSync(path.join(status, `${id}.json`), 'utf8')); } catch { /* none yet */ }
      if (!s) {
        if (!fs.existsSync(path.join(items, `${id}.json`))) throw new Error('no such item');
        return { id, state: 'waiting', note: 'Foreman has not picked this item up yet (it does so on its next tick).' };
      }
      return { id, state: s.state, kind: s.kind ?? null, reason: s.reason ?? null, result: s.result ?? null, decidedAt: s.decidedAt ? new Date(s.decidedAt).toISOString() : null, updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null, issue: s.issue ?? null, job: s.job ?? null };
    },
  };
}
