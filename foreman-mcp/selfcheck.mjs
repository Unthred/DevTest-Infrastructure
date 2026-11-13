// Issue #1314: does this server process still run the code that is installed? The client starts the server once and keeps it, so an install
// that replaces the files leaves the old code answering. The server takes a fingerprint of its own module files at start and again on every
// tool call; a difference means "stale". No timer: the cost of a check is one listing of the server folder.
import fs from 'node:fs';
import path from 'node:path';

// Issue #1327: the long text lives in its own file, next to the modules.
export const STALE_TEXT = fs.readFileSync(new URL('./stale-text.txt', import.meta.url), 'utf8').trim();
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

// The status reply: startedAt and stale under the MCP version entry. A reply that is not a JSON object (an error, or text cut at the size
// limit) cannot take the entry, so the self-check goes in a first line instead and the overseer still sees it (issue #1327).
export function markStatus(text, check, stale) {
  const obj = parse(text);
  if (!obj) return `mcpSelfCheck: ${JSON.stringify({ startedAt: check.startedAt, stale })}\n${text}`;
  const mcp = obj.version?.mcp;
  const entry = mcp && typeof mcp === 'object' ? mcp : mcp == null ? {} : { installed: mcp };
  const version = obj.version && typeof obj.version === 'object' ? obj.version : {};
  const marked = { ...entry, startedAt: check.startedAt, stale };
  return JSON.stringify({ ...obj, version: { ...version, mcp: marked } }, null, 1);
}
