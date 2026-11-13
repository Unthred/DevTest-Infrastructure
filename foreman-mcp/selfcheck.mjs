// Issue #1314: does this server process still run the code that is installed? The client starts the server once and keeps it, so an install
// that replaces the files leaves the old code answering. The server takes a fingerprint of its own module files at start and again on every
// tool call; a difference means "stale". No timer: the cost of a check is one listing of the server folder.
import fs from 'node:fs';
import path from 'node:path';

export const STALE_TEXT = 'This MCP server started before the installed code changed, so it may be missing tools or fields (a proposal field could be dropped without an error). Restart the connection to this server in the client (for example reconnect it, or start a new session), then try again.';
export const BASE_VERSION = '0.1.0';

// Pure: the fingerprint of a listing of { name, size, mtimeMs }. Only module files count; order does not matter.
export function fingerprintOf(entries) {
  return entries.filter(e => e.name.endsWith('.mjs')).map(e => `${e.name}:${e.size}:${Math.round(e.mtimeMs)}`).sort().join('\n');
}

// Reads the folder; null when it cannot be read (which then counts as a change).
export function takeFingerprint(dir) {
  try {
    const entries = [];
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.mjs')) continue;
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) entries.push({ name, size: st.size, mtimeMs: st.mtimeMs });
    }
    return fingerprintOf(entries);
  } catch { return null; }
}

export function createSelfCheck({ dir, now = Date.now, take = takeFingerprint }) {
  const startedAt = new Date(now()).toISOString(), atStart = take(dir);
  return {
    startedAt,
    version: `${BASE_VERSION}+${startedAt.replace(/[-:.]/g, '')}`,   // a client log shows which process answered
    stale: () => { const current = take(dir); return current === null || current !== atStart; },
  };
}

const parse = text => { try { const v = JSON.parse(text); return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };

// The one extra line at the top level of a reply while stale. A reply that is not a JSON object gets it as a first line.
export function markStale(text) {
  const obj = parse(text);
  return obj ? JSON.stringify({ staleServer: STALE_TEXT, ...obj }, null, 1) : `staleServer: ${STALE_TEXT}\n${text}`;
}

// The status reply: startedAt and stale under the MCP version entry.
export function markStatus(text, check, stale) {
  const obj = parse(text);
  if (!obj) return text;
  const mcp = obj.version?.mcp;
  const entry = mcp && typeof mcp === 'object' ? mcp : mcp == null ? {} : { installed: mcp };
  return JSON.stringify({ ...obj, version: { ...(obj.version && typeof obj.version === 'object' ? obj.version : {}), mcp: { ...entry, startedAt: check.startedAt, stale } } }, null, 1);
}
