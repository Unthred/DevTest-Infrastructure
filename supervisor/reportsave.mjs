// Issue #882: hand-run sessions save their report where the tower-readonly MCP server reads it (`foreman_reports`, issue #612).
// `ai-supervisor reports-dir` prints the folder; `ai-supervisor report-save NAME [FILE|-]` writes one report into it. The name rules,
// size cap, finished marker and secret redaction are the reader's own (foreman-mcp/reports.mjs, foreman-mcp/redact.mjs), so a report
// that is saved is a report the reader lists and reads. The folder path is local configuration: AI_SUPERVISOR_REPORTS_DIR, else
// `reports_dir` in team.local.json. It is never in Git.
import fs from 'node:fs';
import path from 'node:path';
import { REPORT_NAME, REPORT_MAX_BYTES, FINISHED_MARKER } from '../foreman-mcp/reports.mjs';
import { redact } from '../foreman-mcp/redact.mjs';
import { SupervisorError } from './core.mjs';

export const REPORTS_DIR_ENV = 'AI_SUPERVISOR_REPORTS_DIR';

// The configured folder, checked to exist, be a directory and be writable by this caller. Throws SupervisorError with a plain reason.
export function reportsDir({ env = process.env, configured = null, fsApi = fs } = {}) {
  const dir = env[REPORTS_DIR_ENV] || configured;
  if (!dir) throw new SupervisorError(`the overseer reports folder is not configured here (set reports_dir in team.local.json or ${REPORTS_DIR_ENV})`);
  if (!path.isAbsolute(dir)) throw new SupervisorError('the configured overseer reports folder is not an absolute path');
  let s; try { s = fsApi.statSync(dir); } catch { throw new SupervisorError('the overseer reports folder does not exist'); }
  if (!s.isDirectory()) throw new SupervisorError('the configured overseer reports folder is not a directory');
  try { fsApi.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK); } catch { throw new SupervisorError('the overseer reports folder is not writable by this user (it is owned by root; run the command as root)'); }
  return path.resolve(dir);
}

export function checkReportName(name) {
  if (typeof name !== 'string' || !REPORT_NAME.test(name)) throw new SupervisorError('not a valid report name (letters, digits, dot, dash and underscore, at most 80 characters, ending .md or .txt, not starting with a dot)');
  return name;
}

// Writes the report atomically (a temporary dot file the reader never lists, then a rename), so the reader never sees a half-written file.
// A report that lacks the finished marker gets it as its last line: the saver is the writer that knows the text is complete.
export function saveReport(dir, name, text, { fsApi = fs } = {}) {
  checkReportName(name);
  if (redact(text) !== text) throw new SupervisorError('the report contains secret-shaped text (a token, key, password or credential in a URL); remove it and save again. Nothing was written');
  let body = text.trimEnd();   // linear time, unlike a trailing-whitespace regex
  if (!body || body === FINISHED_MARKER) throw new SupervisorError('the report is empty (no text came in; give a FILE or pipe the text in). Nothing was written, so any earlier report of this name is unchanged');
  if (body.split('\n').pop().trim() !== FINISHED_MARKER) body += `\n\n${FINISHED_MARKER}`;
  body += '\n';
  if (Buffer.byteLength(body) > REPORT_MAX_BYTES) throw new SupervisorError(`the report is larger than ${REPORT_MAX_BYTES / 1024} KB, the most the reader will show; shorten it`);
  const file = path.join(dir, name), tmp = path.join(dir, `.${name}.${process.pid}.tmp`);
  try {
    fsApi.writeFileSync(tmp, body, { flag: 'wx', mode: 0o640 });
    try { const g = fsApi.statSync(dir); fsApi.chownSync(tmp, fsApi.statSync(tmp).uid, g.gid); } catch { /* not allowed to change the group: the folder's own mode still applies */ }
    fsApi.chmodSync(tmp, 0o640);
    fsApi.renameSync(tmp, file);   // replaces an earlier report of the same name; a symbolic link in that place is replaced, not followed
  } catch (error) {
    try { fsApi.unlinkSync(tmp); } catch { /* nothing to remove */ }
    throw new SupervisorError(`could not save the report (${error.code || 'write failed'})`);
  }
  return file;
}

// The report text: from FILE (regular file, bounded), or from stdin for `-` or no argument.
export function readReportInput(source, { stdin = process.stdin, fsApi = fs } = {}) {
  if (source && source !== '-') {
    let s; try { s = fsApi.statSync(source); } catch { throw new SupervisorError('the report file cannot be read'); }
    if (!s.isFile()) throw new SupervisorError('the report file is not a regular file');
    if (s.size > REPORT_MAX_BYTES) throw new SupervisorError(`the report is larger than ${REPORT_MAX_BYTES / 1024} KB, the most the reader will show; shorten it`);
    return fsApi.readFileSync(source, 'utf8');
  }
  if (stdin.isTTY) throw new SupervisorError('no report text: give a FILE, or pipe the text in with `-`');
  const chunks = []; let total = 0;
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n; try { n = fsApi.readSync(stdin.fd ?? 0, buf, 0, buf.length, null); } catch (error) { if (error.code === 'EAGAIN') continue; if (error.code === 'EOF') break; throw new SupervisorError('the report text cannot be read from standard input'); }
    if (!n) break;
    total += n; if (total > REPORT_MAX_BYTES) throw new SupervisorError(`the report is larger than ${REPORT_MAX_BYTES / 1024} KB, the most the reader will show; shorten it`);
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks).toString('utf8');
}
