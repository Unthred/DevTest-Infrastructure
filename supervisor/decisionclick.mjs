// Issue #1156: what a click on a decision card does. The card's control becomes an ordinary inbox item that is already approved by the
// homeowner's click, so the existing approved-action pipeline (team.runInboxAction, controlactions.runControl) applies it once on the next
// tick, with its own re-checks, and a refusal ends the item 'failed' with its reason. Nothing is applied here. Node built-ins only.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { validateItem, hashOf, dirs, allStatuses, finish } from './inbox.mjs';

const LIVE = new Set(['approved', 'running']);
const refuse = (status, text) => ({ ok: false, status, text });

// Finds the card in the current view and the control it offers. The target comes from the card, never from the request.
export function resolveClick(view, { card, control }) {
  const item = (view?.panels?.needsYou || []).find(a => a.id === card);
  if (!item) return refuse(409, 'That card has already cleared.');
  const offered = (item.card?.controls || []).find(c => c.action === control);
  if (!offered) return refuse(409, 'That control no longer applies to this card.');
  return { ok: true, item, control: offered };
}

// Writes the approved item. Returns { ok, id } or { ok:false, status, text } when the same change is already waiting for the tick.
export function recordClick(inboxDir, { item, control }, now = Date.now(), by = 'homeowner') {
  const kind = control.action === 'park' ? 'control' : 'action';
  const reason = `${by} pressed ${control.label} on the ${item.card.type} card`;
  const raw = { kind, title: `${control.label} ${control.target} (decision card)`, action: control.action, target: control.target, reason };
  const v = validateItem(raw);
  if (!v.ok) return refuse(400, `The control could not be recorded: ${v.reason}.`);
  const waiting = allStatuses(inboxDir).some(s => LIVE.has(s.state) && s.click?.action === control.action && s.click?.target === control.target);
  if (waiting) return refuse(409, 'The same change is already waiting for the next tick.');
  const id = crypto.randomBytes(16).toString('hex'), d = dirs(inboxDir);
  fs.mkdirSync(d.items, { recursive: true, mode: 0o755 });
  fs.mkdirSync(d.status, { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(d.items, `${id}.json`), JSON.stringify(v.item, null, 1) + '\n', { mode: 0o644, flag: 'wx' });
  finish(inboxDir, id, {
    state: 'approved', kind, hash: hashOf(v.item), createdAt: now, decision: 'approve', decidedAt: now, title: v.item.title,
    click: { by, card: item.id, action: control.action, target: control.target, reason },
    ...(kind === 'control' ? { control: { action: control.action, target: control.target, reason, by } } : {}),
  }, now);
  return { ok: true, id };
}
