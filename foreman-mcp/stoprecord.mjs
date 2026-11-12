// Issue #1161: foreman_stop_record. When Foreman is held by a homeowner stop (the upgrade latch or a Needs you pause), the reason text names a
// stop record. This module reads that one file so the overseer can say why. Read-only. It is not a general file read: the path must be
// named by a current reason, sit directly in an allowed directory, and be a regular file reached without a symbolic link.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_STOP_DIRS = ['/mnt/cache/logs/agent-cleanup'];
export const STOP_MAX_BYTES = 128 * 1024;   // most of a record ever read from disk
export const STOP_MAX_CHARS = 10000;        // most of a record returned (the tool result is bounded again by the toolset)
// Allowed directories: FOREMAN_MCP_STOP_DIRS (colon separated), else stopDirs in the configuration file, else the default.
export function stopDirsFrom(env, fsApi = fs) {
  const fromEnv = String(env.FOREMAN_MCP_STOP_DIRS || '').split(':').filter(Boolean);
  if (fromEnv.length) return fromEnv;
  let cfg = {};
  if (env.FOREMAN_MCP_CONFIG) { try { cfg = JSON.parse(fsApi.readFileSync(env.FOREMAN_MCP_CONFIG, 'utf8')); } catch { cfg = {}; } }
  return Array.isArray(cfg.stopDirs) && cfg.stopDirs.length ? cfg.stopDirs.map(String) : DEFAULT_STOP_DIRS;
}
const PATH_IN_TEXT = /\/[A-Za-z0-9._\/-]+\.(?:md|txt)\b/g;

// Pure: the distinct record paths a set of reason texts name, with the text each came from.
export function namedPaths(reasons) {
  const seen = new Map();
  for (const r of reasons) for (const p of String(r.text ?? '').match(PATH_IN_TEXT) ?? []) if (!seen.has(p)) seen.set(p, r.source);
  return [...seen].map(([file, source]) => ({ file, source }));
}

// Pure: is the file directly inside one of the allowed directories (after normalising `..`)?
export function insideAllowed(file, dirs) {
  const resolved = path.resolve(file);
  return dirs.map(d => path.resolve(d)).some(d => path.dirname(resolved) === d);
}

function readRecord(file, dirs, fsApi, redactText) {
  const resolved = path.resolve(file);
  let realParent;
  try { realParent = fsApi.realpathSync(path.dirname(resolved)); } catch { return { path: file, refused: 'the directory cannot be read' }; }
  const allowedReal = dirs.map(d => { try { return fsApi.realpathSync(d); } catch { return null; } }).filter(Boolean);
  if (!allowedReal.includes(realParent)) return { path: file, refused: 'the directory is not in the allowed stop-record directories' };
  let fd;
  try { fd = fsApi.openSync(path.join(realParent, path.basename(resolved)), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { return { path: file, refused: error.code === 'ENOENT' ? 'the named file does not exist' : 'the file cannot be read (it may be a symbolic link)' }; }
  try {
    const s = fsApi.fstatSync(fd);
    if (!s.isFile()) return { path: file, refused: 'not a regular file' };
    const buf = Buffer.alloc(Math.min(s.size, STOP_MAX_BYTES));
    const n = fsApi.readSync(fd, buf, 0, buf.length, 0);
    const text = redactText(buf.subarray(0, n).toString('utf8'));   // redact the whole buffer first so a cut cannot split a secret
    const cut = text.length > STOP_MAX_CHARS;
    const unread = s.size > n ? s.size - n : 0;
    return { path: file, modified: new Date(s.mtimeMs).toISOString(), bytes: s.size, text: text.slice(0, STOP_MAX_CHARS), truncated: cut || unread > 0 };
  } finally { try { fsApi.closeSync(fd); } catch { /* closed */ } }
}

// reasons(): [{ source, text }] from the current latch and pause records. Throws nothing; a source that fails is reported in `unavailable`.
export function stopRecordTool({ reasons, dirs = DEFAULT_STOP_DIRS, fsApi = fs, redact: redactText }) {
  return {
    name: 'foreman_stop_record',
    description: 'Why Foreman is held by a homeowner stop: reads the stop record file named by the current upgrade latch or pause reason (path, modified time, redacted text, cut if long) so the stop\'s scope, resume conditions and resume note can be read without a Tower session. Only the file the reason names, and only inside the allowed stop-record directories; any other path is refused. Says so when there is no stop. Read-only.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async run() {
      const { list, unavailable } = await reasons();
      if (!list.length) return { stop: false, note: 'No upgrade latch or pause reason is set, so there is no homeowner stop record.', ...(unavailable.length ? { unavailable } : {}) };
      const named = namedPaths(list);
      if (!named.length) return { stop: true, record: null, reasons: list.map(r => ({ source: r.source, text: redactText(String(r.text).slice(0, 400)) })), note: 'A latch or pause is set but its reason names no stop record file.', ...(unavailable.length ? { unavailable } : {}) };
      return { stop: true, records: named.map(n => ({ source: n.source, ...(insideAllowed(n.file, dirs) ? readRecord(n.file, dirs, fsApi, redactText) : { path: n.file, refused: 'the path is not in the allowed stop-record directories' }) })), ...(unavailable.length ? { unavailable } : {}) };
    },
  };
}

// The reasons come from the same dashboard endpoints the other tools use: the install record's latch and the Needs you items.
export function viewReasons({ source, getPath }) {
  return async () => {
    const list = [], unavailable = [];
    if (getPath) {
      try { const l = (await getPath('/api/installs.json'))?.latch; if (l?.reason) list.push({ source: 'upgrade latch', text: String(l.reason) }); } catch { unavailable.push('install history'); }
    }
    try {
      const v = (await source.get()).view;
      for (const a of v.attention || []) if (/pause|latch|stop/i.test(a.id || '') || /\b(paused|latched|homeowner stop)\b/i.test(a.text || '')) list.push({ source: `needs you: ${a.id ?? 'item'}`, text: `${a.text ?? ''} ${a.tried ?? ''}` });
    } catch { unavailable.push('dashboard view'); }
    return { list, unavailable };
  };
}
