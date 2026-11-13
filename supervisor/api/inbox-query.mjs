// Issue #1255: filtering, ordering, counting and paging of the Inbox read model, as pure functions of the items and the query.
// Values that name nothing (an unknown state, a bad cursor) give an empty page, never an error; a limit out of range is brought into range.
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

const list = value => (typeof value === 'string' && value ? value.split(',').map(v => v.trim()).filter(Boolean) : null);
const stamp = item => (item.created_at ? Date.parse(item.created_at) : 0);

export function filterOf(query) {
  const states = list(query.state);
  const kinds = list(query.kind);
  const text = String(query.q ?? '').trim().toLowerCase();
  return item => (!states || states.includes(item.state))
    && (!kinds || kinds.includes(item.kind))
    && (!text || [item.id, item.full_id, item.title].some(field => field.toLowerCase().includes(text)));
}

export function countBy(items, field) {
  const counts = {};
  for (const item of items) counts[item[field]] = (counts[item[field]] || 0) + 1;
  return counts;
}

// Newest first unless sort is oldest; the full id breaks ties so the order, and so the cursor, is total.
export function sortItems(items, sort) {
  const sign = sort === 'oldest' ? 1 : -1;
  return [...items].sort((a, b) => sign * (stamp(a) - stamp(b)) || sign * a.full_id.localeCompare(b.full_id));
}

export function limitOf(raw) {
  const n = Math.trunc(Number(raw));
  if (raw === undefined || raw === '' || !Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, n));
}

const encode = item => Buffer.from(`${stamp(item)}:${item.full_id}`).toString('base64url');
function decode(cursor) {
  const m = /^(\d{1,16}):([a-f0-9]{32})$/.exec(Buffer.from(String(cursor), 'base64url').toString('utf8'));
  return m ? { at: Number(m[1]), id: m[2] } : null;
}

// The cursor names the last item returned, so a change in the Inbox between two pages never repeats or skips an item that stays.
// items are already sorted. Returns { items, next }.
export function pageOf(items, query) {
  const limit = limitOf(query.limit);
  let rest = items;
  if (query.cursor !== undefined && query.cursor !== '') {
    const at = decode(query.cursor);
    if (!at) return { items: [], next: null };
    const sign = query.sort === 'oldest' ? 1 : -1;
    rest = items.filter(item => sign * (stamp(item) - at.at) > 0 || (stamp(item) === at.at && sign * item.full_id.localeCompare(at.id) > 0));
  }
  const slice = rest.slice(0, limit);
  return { items: slice, next: rest.length > limit ? encode(slice[slice.length - 1]) : null };
}
