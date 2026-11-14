// Issue #949: a bounded, redacted, read-only view of <state root>/team/alerts.jsonl for the foreman_alerts MCP tool (D-030), served by the
// dashboard's GET handler because the MCP account cannot read the state root. It only reads, takes no lock and makes no model call.
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';

const DAY_MS = 86400000;
const TAIL_BYTES = 4 * 1024 * 1024;   // only the end of the file is read, so a huge log cannot stall the dashboard
const iso = ms => new Date(ms).toISOString();

// The same alert with a different number, SHA, branch, job id or quoted name is one group.
export function normaliseAlert(text) {
  return String(text ?? '').slice(0, 2000).toLowerCase()
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/[`"'][^`"'\n]{1,80}[`"']/g, '<name>')
    .replace(/\b[a-z0-9._-]+(?:\/[a-z0-9._-]+)+/g, '<path>')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/g, '<sha>')
    .replace(/#?\d+(?:[.,:]\d+)*%?/g, '<n>')
    .replace(/\s+/g, ' ').trim()
    .replace(/(\bpr <n> ).+?( is still )/, '$1<title>$2');
}

// Issue #1421: the level is shown when the row has one (rows written before levels existed have none).
function rowOf(o) {
  if (!o || !Number.isFinite(o.at)) return null;
  const level = typeof o.level === 'string' ? { level: o.level.slice(0, 20) } : {};
  return { at: o.at, text: String(o.text ?? ''), delivered: o.delivered === true, ...level };
}

export function readAlerts(root) {
  const file = path.join(root, 'team', 'alerts.jsonl');
  let fd; try { fd = fs.openSync(file, 'r'); } catch { return { rows: [], partial: false }; }
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL_BYTES), buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString('utf8').split('\n'); if (start > 0) lines = lines.slice(1);   // the first line of a tail is cut
    const rows = [];
    for (const l of lines) { if (!l) continue; try { const row = rowOf(JSON.parse(l)); if (row) rows.push(row); } catch { /* damaged line */ } }
    return { rows, partial: start > 0 };
  } finally { fs.closeSync(fd); }
}

// Options: since (ISO date or time; default the last 24 hours for the lists), contains (case-insensitive text), delivered (true or false), limit (1 to 200).
export function alertsView(root, { now = Date.now(), since = null, contains = null, delivered = null, limit = 50 } = {}) {
  const { rows, partial } = readAlerts(root);
  let from = now - DAY_MS;
  if (since != null && since !== '') { const t = Date.parse(since); if (!Number.isFinite(t)) throw new Error('since must be an ISO date or time'); from = t; }
  const want = delivered === null || delivered === undefined || delivered === '' ? null : (String(delivered) === 'true' ? true : String(delivered) === 'false' ? false : undefined);
  if (want === undefined) throw new Error('delivered must be true or false');
  const needle = contains ? String(contains).slice(0, 200).toLowerCase() : null;
  const lim = Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 50));
  const clean = r => ({ at: iso(r.at), text: redact(r.text, 500), delivered: r.delivered, ...(r.level ? { level: r.level } : {}) });
  const picked = rows.filter(r => r.at >= from && (want === null || r.delivered === want) && (!needle || redact(r.text, 2000).toLowerCase().includes(needle))).sort((a, b) => b.at - a.at);
  const groups = new Map();
  for (const r of picked) {
    const key = normaliseAlert(redact(r.text, 2000)).slice(0, 300), g = groups.get(key) || { pattern: key, count: 0, delivered: 0, notDelivered: 0, firstAt: r.at, lastAt: r.at, example: redact(r.text, 300) };
    g.count++; r.delivered ? g.delivered++ : g.notDelivered++; g.firstAt = Math.min(g.firstAt, r.at); g.lastAt = Math.max(g.lastAt, r.at); groups.set(key, g);
  }
  // Totals per UTC day for the last 7 UTC calendar days (today and the 6 before), today first, with the same text and delivered filters (since does not narrow them).
  const days = new Map(), dayStart = Math.floor(now / DAY_MS) * DAY_MS - 6 * DAY_MS;   // today and the 6 UTC days before it
  for (const r of rows) {
    if (r.at < dayStart || (want !== null && r.delivered !== want) || (needle && !redact(r.text, 2000).toLowerCase().includes(needle))) continue;
    const d = iso(r.at).slice(0, 10), e = days.get(d) || { day: d, total: 0, delivered: 0, notDelivered: 0 };
    e.total++; r.delivered ? e.delivered++ : e.notDelivered++; days.set(d, e);
  }
  const allGroups = [...groups.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
  return {
    from: iso(from), to: iso(now), matching: picked.length, shown: Math.min(lim, picked.length),
    alerts: picked.slice(0, lim).map(clean),
    groupCount: allGroups.length, ...(allGroups.length > 50 ? { groupsTruncated: true } : {}),
    groups: allGroups.slice(0, 50).map(g => ({ pattern: g.pattern, count: g.count, delivered: g.delivered, notDelivered: g.notDelivered, firstAt: iso(g.firstAt), lastAt: iso(g.lastAt), example: g.example })),
    perDay: [...days.values()].sort((a, b) => b.day.localeCompare(a.day)),
    ...(partial ? { note: 'The log is large; only its most recent part was read, so the oldest alerts may be missing.' } : {}),
  };
}
