// Issue #1316: the read-only half of withdraw and replace. It finds the item a `replaces` or a withdraw names, says whether it can be replaced,
// lists the drafts that wait for it, and follows a withdrawn item to the item that replaced it (so a link follows a replacement, also twice in a
// row). Both the MCP server (submit time) and Foreman (pickup) use it, so they refuse with the same words. It only reads the inbox directory.
import fs from 'node:fs';
import path from 'node:path';

export const REPLACEABLE_KINDS = ['prompt', 'issue_draft', 'action'];
const REF = /^(?:[a-f0-9]{8}|[a-f0-9]{32})$/;
const FULL = /^[a-f0-9]{32}\.json$/;
const MAX_HOPS = 20;

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const listed = dir => { try { return fs.readdirSync(dir).filter(name => FULL.test(name)).map(name => name.slice(0, 32)); } catch { return []; } };
const known = inboxDir => [...new Set([...listed(path.join(inboxDir, 'items')), ...listed(path.join(inboxDir, 'status'))])];
const statusIn = (inboxDir, id) => readJson(path.join(inboxDir, 'status', `${id}.json`));
const oneLine = text => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);

export const replacesFormatRefusal = ref => (typeof ref === 'string' && REF.test(ref) ? null : 'replaces must be an 8 or 32 character proposal id');

// The full id a reference names, or { reason } when it names none or more than one item.
export function resolveRef(inboxDir, ref) {
  const matches = known(inboxDir).filter(id => id.startsWith(String(ref)));
  if (matches.length > 1) return { reason: 'the id matches more than one item; use the full id' };
  return matches.length ? { id: matches[0] } : { reason: 'no item with that id is known to the Inbox' };
}

// The item a withdrawn one was replaced by, and so on to the newest. An item that was not replaced is its own answer.
export function followReplaced(inboxDir, id) {
  let current = id;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const status = statusIn(inboxDir, current);
    if (status?.state !== 'withdrawn' || !/^[a-f0-9]{32}$/.test(status.replacedBy || '')) return current;
    current = status.replacedBy;
  }
  return current;
}

// Can the item named by `ref` be replaced by a new item of `kind`? Only a pending item that came through the propose tool, of the same kind.
export function replaceCheck(inboxDir, kind, ref) {
  const found = resolveRef(inboxDir, ref);
  if (!found.id) return { ok: false, reason: `replaces: ${found.reason}; nothing was replaced and the new item was not accepted` };
  const status = statusIn(inboxDir, found.id);
  const label = `${oneLine(status?.title) || 'untitled'} (${found.id.slice(0, 8)})`;
  if (!status) return { ok: false, reason: `replaces: ${label} has not been picked up by Foreman yet (state waiting); try again after it is pending. The new item was not accepted` };
  if (status.state !== 'pending') {
    const note = status.state === 'withdrawn' && status.replacedBy ? ' (already replaced)' : '';
    return { ok: false, reason: `replaces: ${label} is ${status.state}${note}, not pending, so nothing was withdrawn and the new item was not accepted` };
  }
  if (!REPLACEABLE_KINDS.includes(status.kind)) return { ok: false, reason: `replaces: ${label} is not an item of the propose tool, so it cannot be replaced` };
  if (status.kind !== kind) return { ok: false, reason: `replaces: ${label} is ${status.kind} but the new item is ${kind}; a replacement must be the same kind` };
  return { ok: true, old: { id: found.id, title: oneLine(status.title) || 'untitled', kind: status.kind } };
}

// The pending or approved issue drafts whose `after` names this item (directly or through an earlier replacement of it).
export function dependentsOf(inboxDir, id) {
  const moved = [];
  for (const other of known(inboxDir)) {
    const status = statusIn(inboxDir, other);
    if (!status || status.kind !== 'issue_draft' || !['pending', 'approved'].includes(status.state)) continue;
    const after = readJson(path.join(inboxDir, 'items', `${other}.json`))?.after;
    const names = Array.isArray(after) ? after : [];
    const hit = names.some(ref => { const match = resolveRef(inboxDir, ref); return match.id && followReplaced(inboxDir, match.id) === id; });
    if (hit) moved.push({ id: other, shortId: other.slice(0, 8), title: oneLine(status.title) || 'untitled' });
  }
  return moved;
}

// Does the new item's own `after` name the item it replaces? That would make it wait for itself.
export function afterNamesReplaced(inboxDir, after, oldId) {
  return (Array.isArray(after) ? after : []).some(ref => { const match = resolveRef(inboxDir, ref); return match.id && followReplaced(inboxDir, match.id) === oldId; });
}

// The check made when a new item that names `replaces` is picked up. Returns { ok, old } or { ok:false, reason }.
export function checkReplacement(dir, item) {
  const check = replaceCheck(dir, item.kind, item.replaces);
  if (!check.ok) return check;
  if (item.after && afterNamesReplaced(dir, item.after, check.old.id)) {
    return { ok: false, reason: `after names ${check.old.title} (${check.old.id.slice(0, 8)}), the item this one replaces, so the new item would wait for itself` };
  }
  return check;
}

// What the reply to a propose that replaces an item adds: the item it replaced and every draft whose link will move. Nothing when it replaces none.
export function replaceReply(dir, swap) {
  if (!swap) return {};
  const old = { id: swap.old.id, shortId: swap.old.id.slice(0, 8), title: swap.old.title };
  return { replaces: old, linksMoved: dependentsOf(dir, old.id), replaceNote: 'The old item is withdrawn when Foreman picks this one up; the drafts listed in linksMoved then wait for this item.' };
}

// What foreman_proposal_status adds for a withdrawn item (the time and its replacement) and for an item that replaced another.
export function withdrawnView(status) {
  const view = {};
  if (status.state === 'withdrawn') {
    view.withdrawnAt = status.withdrawnAt ? new Date(status.withdrawnAt).toISOString() : null;
    view.replacedBy = status.replacedBy ? { id: status.replacedBy, title: status.replacedByTitle ?? null } : null;
  }
  if (status.replaced) view.replaced = status.replaced;
  return view;
}
