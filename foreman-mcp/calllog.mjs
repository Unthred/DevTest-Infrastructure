// The call log: one JSON line per call (time, tool, redacted arguments, duration, outcome) in the account's own file, size limited.
// The only file this server ever writes. A failure to log never fails a call.
import fs from 'node:fs';
import path from 'node:path';
import { redactDeep } from './redact.mjs';

export const LOG_MAX_BYTES = 256 * 1024;
export function createCallLog(file, { maxBytes = LOG_MAX_BYTES, now = Date.now } = {}) {
  return {
    file,
    record(entry) {
      if (!file) return;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        let size = 0; try { size = fs.statSync(file).size; } catch { /* no file yet */ }
        if (size > maxBytes) { try { fs.renameSync(file, file + '.1'); } catch { /* keep going */ } }
        const line = JSON.stringify({ at: new Date(now()).toISOString(), ...redactDeep(entry) }).slice(0, 4000);
        fs.appendFileSync(file, line + '\n', { mode: 0o600 });
      } catch { /* logging must never break a call */ }
    },
  };
}
