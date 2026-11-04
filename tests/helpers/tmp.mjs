// Issue #469: temp directories for tests that have no `t` to hang a cleanup on. Every directory made here is removed when the
// process ends (normal exit, failure, SIGINT/SIGTERM), so a failed or killed run leaves nothing behind. os.tmpdir() honours
// TMPDIR, which `ai-supervisor test-slot run` points at the configured temp root.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = new Set();
const clean = () => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); made.clear(); };
process.on('exit', clean);
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { clean(); process.kill(process.pid, sig); });

export function tmpDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.add(d);
  return d;
}
export const trackedTmpDirs = () => [...made];
export const cleanTmpDirs = clean;
