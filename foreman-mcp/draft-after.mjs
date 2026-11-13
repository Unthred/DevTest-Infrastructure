// Issue #1259: an issue draft may name earlier drafts of the same Inbox it must be posted after (`after`). Both the MCP server (submit time)
// and Foreman (pickup) refuse a bad value with the same words, so the check lives here; it only reads the inbox directory.
import fs from 'node:fs';
import path from 'node:path';

export const AFTER_MAX = 10;
const REF = /^(?:[a-f0-9]{8}|[a-f0-9]{32})$/;
const FULL = /^[a-f0-9]{32}\.json$/;
const MAX_ITEM_BYTES = 32 * 1024;

// The shape only: a list of 1 to AFTER_MAX well formed ids. Returns the refusal sentence or null.
export function afterFormatRefusal(after) {
  if (!Array.isArray(after)) return 'after must be a list of proposal ids';
  if (after.length < 1) return 'after must name at least one draft';
  if (after.length > AFTER_MAX) return `after names ${after.length} drafts; the limit is ${AFTER_MAX}`;
  const bad = after.findIndex(ref => typeof ref !== 'string' || !REF.test(ref));
  return bad < 0 ? null : `after entry ${bad + 1} is not an 8 or 32 character proposal id`;
}

const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const itemKind = (items, id) => {
  const file = path.join(items, `${id}.json`);
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && st.size <= MAX_ITEM_BYTES ? readJson(file)?.kind ?? null : null;
  } catch { return null; }
};

// Resolves every entry to a full id of an issue draft the Inbox knows (an item file or a status record). Returns { ok, ids } or { ok: false, reason }.
export function resolveAfter(inboxDir, selfId, after) {
  const items = path.join(inboxDir, 'items'), status = path.join(inboxDir, 'status');
  const listed = dir => { try { return fs.readdirSync(dir).filter(n => FULL.test(n)).map(n => n.slice(0, 32)); } catch { return []; } };
  const known = [...new Set([...listed(items), ...listed(status)])];
  const ids = [];
  for (const [index, ref] of after.entries()) {
    const where = `after entry ${index + 1}`;
    const matches = known.filter(id => id.startsWith(ref));
    if (matches.length > 1) return { ok: false, reason: `${where} matches more than one item; use the full id` };
    if (!matches.length) return { ok: false, reason: `${where} is not an item the Inbox knows` };
    const id = matches[0];
    if (id === selfId) return { ok: false, reason: `${where} names the draft itself` };
    const kind = readJson(path.join(status, `${id}.json`))?.kind ?? itemKind(items, id);
    if (kind !== 'issue_draft') return { ok: false, reason: `${where} is not an issue draft` };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}

// "Title (abcd1234)" for each named draft, for the card and the status. A draft whose title cannot be read shows its id alone.
export function afterLabels(inboxDir, after) {
  const items = path.join(inboxDir, 'items'), status = path.join(inboxDir, 'status');
  const listed = dir => { try { return fs.readdirSync(dir).filter(n => FULL.test(n)).map(n => n.slice(0, 32)); } catch { return []; } };
  const known = [...new Set([...listed(items), ...listed(status)])];
  return (Array.isArray(after) ? after : []).map(ref => {
    const matches = known.filter(id => id.startsWith(String(ref)));
    if (matches.length !== 1) return String(ref).slice(0, 8);
    const id = matches[0];
    const title = readJson(path.join(status, `${id}.json`))?.title ?? readJson(path.join(items, `${id}.json`))?.title;
    return typeof title === 'string' && title.trim() ? `${title.replace(/\s+/g, ' ').trim().slice(0, 200)} (${id.slice(0, 8)})` : id.slice(0, 8);
  });
}
