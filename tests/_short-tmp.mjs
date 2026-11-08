import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A Unix socket path holds at most 107 bytes. The supervisor's pre-install check runs the suite with TMPDIR set to a long per-job
// folder on the cache drive (issue #1007), so tests that create socket paths under os.tmpdir() overflow there and fail the install.
// Use os.tmpdir() when it is short enough, otherwise a short fixed base. The caller removes the folder it gets back.
const MAX_BASE = 24;
export const shortTmpBase = () => (Buffer.byteLength(os.tmpdir()) <= MAX_BASE ? os.tmpdir() : '/tmp');
export const shortMkdtemp = prefix => fs.mkdtempSync(path.join(shortTmpBase(), prefix));
