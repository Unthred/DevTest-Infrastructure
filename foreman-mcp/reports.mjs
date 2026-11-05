// Hand-run session reports (issue #612). A fixed folder of small text reports that sessions leave for the overseer; this module only reads it.
// Never writes, never follows a symlink, never reads outside the folder, and returns bounded text (redacted before it is cut).
import fs from 'node:fs';
import path from 'node:path';
import { redact } from './redact.mjs';

export const REPORT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(md|txt)$/;   // one path component: no separators, no leading dot, a known extension
export const REPORT_MAX_BYTES = 256 * 1024;   // most of a report ever read from disk
export const REPORT_LIST_MAX = 100;

const truncatedMarker = n => `\n\n[truncated: ${n} more characters not shown]`;

export function createReports(dir, { fsApi = fs, redact: redactText = redact } = {}) {
  const need = () => { if (!dir) throw new Error('no reports folder is configured (reportsDir in the server configuration)'); return path.resolve(dir); };
  return {
    list() {
      const root = need();
      let entries; try { entries = fsApi.readdirSync(root, { withFileTypes: true }); } catch { throw new Error('the reports folder cannot be read'); }
      const rows = [];
      for (const e of entries) {
        if (!e.isFile() || !REPORT_NAME.test(e.name)) continue;   // a symlink is not a file here, and odd names are skipped
        try { const s = fsApi.lstatSync(path.join(root, e.name)); if (s.isFile()) rows.push({ name: e.name, modified: new Date(s.mtimeMs).toISOString(), bytes: s.size, mtimeMs: s.mtimeMs }); } catch { /* vanished */ }
      }
      rows.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
      return { folderConfigured: true, count: rows.length, shown: Math.min(rows.length, REPORT_LIST_MAX), reports: rows.slice(0, REPORT_LIST_MAX).map(({ name, modified, bytes }) => ({ name, modified, bytes })) };
    },
    read(name, maxChars) {   // redacts the whole buffer read from disk first, then cuts, so a secret cannot be split by the cut
      const root = need();
      if (typeof name !== 'string' || !REPORT_NAME.test(name)) throw new Error('not a valid report name (letters, digits, dot, dash and underscore, ending .md or .txt)');
      const file = path.join(root, name);
      if (path.dirname(file) !== root) throw new Error('not a valid report name');
      let fd;
      try { fd = fsApi.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }   // O_NOFOLLOW: a symlink in the last position is refused
      catch (error) { throw new Error(error.code === 'ENOENT' ? 'no such report' : 'that report cannot be read (it may be a symbolic link)'); }
      try {
        const s = fsApi.fstatSync(fd); if (!s.isFile()) throw new Error('that report cannot be read (not a regular file)');
        const buf = Buffer.alloc(Math.min(s.size, REPORT_MAX_BYTES + 1)); const n = fsApi.readSync(fd, buf, 0, buf.length, 0);
        let text = redactText(buf.subarray(0, Math.min(n, REPORT_MAX_BYTES)).toString('utf8')), more = s.size > REPORT_MAX_BYTES ? s.size - REPORT_MAX_BYTES : 0;
        if (maxChars && text.length > maxChars) { more += text.length - maxChars; text = text.slice(0, maxChars); }
        return `${name} (${new Date(s.mtimeMs).toISOString()}, ${s.size} bytes)\n\n${text}${more ? truncatedMarker(more) : ''}`;
      } finally { try { fsApi.closeSync(fd); } catch { /* closed */ } }
    },
  };
}
